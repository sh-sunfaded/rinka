/**
 * rinka — test/run-tests.ts 全量テスト（node:test + node:assert。ハーネス自作なし・依存ゼロ）。
 *
 * 実行: node --experimental-strip-types --no-warnings test/run-tests.ts
 * 成功失敗は終了コードに出る（失敗で非0）。ハングはper-testタイムアウトと
 * 実行側の `timeout` ラップで落とす（240秒を目安に）。
 * 構文規約: as断言不使用（expectString等・isRecord・isRpcOk で絞る）・class不使用（closure）
 * ・Date.now不使用（ループ回数で上限）・createAudit には固定Clockを注入（決定性）。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { NATIVE_FRAME_MAX, createNativeReader, encodeNativeFrame } from "../native-host/src/native.ts";
import { BACKEND_CALL_TIMEOUT_MS, createAddonBackend } from "../native-host/src/backend.ts";
import { loadToken, validateEnvironment } from "../native-host/src/config.ts";
import { createAudit } from "../native-host/src/audit.ts";
import { TOOLS, callTool } from "../native-host/src/tools.ts";
import { isRpcOk, SERVER_INFO, SUPPORTED_PROTOCOL, handleRpcMessage } from "../native-host/src/mcp.ts";
import { startServer, tokenMatches } from "../native-host/src/http.ts";
import type { RunningServer } from "../native-host/src/http.ts";
import { buildXpi, readCentralDirectory, verifyStored } from "../tools/build-xpi.ts";
import { isRecord } from "../native-host/src/types.ts";
import type { Backend, BackendMode, FillField } from "../native-host/src/types.ts";
import type { ToolDeps } from "../native-host/src/tools.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "rinka-test-"));
const TOKEN = "x".repeat(40);

// ---- as断言の代替: 期待形で絞り込む小さなexpect族 ----

const fail = (what: string): Error => new Error(`テスト内部エラー: ${what}が期待形でない`);

const expectString = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw fail(what);
  return v;
};

const expectNumber = (v: unknown, what: string): number => {
  if (typeof v !== "number") throw fail(what);
  return v;
};

const expectRecord = (v: unknown, what: string): Record<string, unknown> => {
  if (!isRecord(v)) throw fail(what);
  return v;
};

const expectArray = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw fail(what);
  return v;
};

const testConfig = (over: Partial<Config> = {}): Config => {
  return {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    readMaxBytes: 65536,
    screenshotMaxBytes: 4194304,
    historyMaxRows: 20,
    auditPath: "/dev/null",
    writeTimeoutSec: 1800,
    sudoFill: false,
    sudoFillUrls: [],
    fillMaxBytes: 4096,
    ...over,
  };
};

// ---------------- FakeBackend（closure。class不使用） ----------------

const createFakeBackend = (): Backend & { mode: BackendMode; seen: string[] } => {
  const fake: Backend & { mode: BackendMode; seen: string[] } = {
    /** host側modeガードのテスト用。初期read・test内で write に切替可能。 */
    mode: "read",
    seen: [],
    getMode: (): BackendMode => fake.mode,
    listTabs: async () => ({ tabs: [{ tabId: 7, url: "https://example.invalid/a", title: "例A", active: true }] }),
    readTab: async (tabId: number) => ({ tab: { tabId, url: "https://example.invalid/a", title: "例A", active: true }, text: "本文SECRETTEXT-MARKERだよ" }),
    screenshot: async (tabId: number) => ({ tab: { tabId, url: "https://example.invalid/a", title: "例A", active: true }, base64: "QUJDRA==" }),
    searchHistory: async (query: string, limit: number) => [{ url: `https://example.invalid/?q=${query}&limit=${limit}`, title: "検索", visitCount: 3, lastVisit: "2026-11-20T00:00:00.000Z" }],

    // ---- v2 書込み（modeフィールドでtest側が制御。mode="write"のときだけ呼ばれる想定） ----
    openTab: async (url: string, active: boolean) => {
      fake.seen.push(`open:${url}:${active}`);
      return { tab: { tabId: 99, url, title: "開いた", active } };
    },
    closeTab: async (tabId: number) => {
      fake.seen.push(`close:${tabId}`);
      return { tab: { tabId, url: "https://example.invalid/before", title: "閉じた", active: true } };
    },
    activateTab: async (tabId: number) => {
      fake.seen.push(`activate:${tabId}`);
      return { tab: { tabId, url: "https://example.invalid/a", title: "例A", active: true } };
    },
    navigateTab: async (tabId: number, url: string) => {
      fake.seen.push(`navigate:${tabId}:${url}`);
      return { tab: { tabId, url: "https://example.invalid/before", title: "前", active: true }, tabAfter: { tabId, url, title: "後", active: true } };
    },
    reloadTab: async (tabId: number, bypassCache: boolean) => {
      fake.seen.push(`reload:${tabId}:${bypassCache}`);
      return { tab: { tabId, url: "https://example.invalid/a", title: "例A", active: true } };
    },
    goTab: async (tabId: number, dir: "back" | "forward") => {
      fake.seen.push(`go:${tabId}:${dir}`);
      return { tab: { tabId, url: "https://example.invalid/a", title: "例A", active: true } };
    },
    pageClick: async (tabId: number, target: { selector?: string; x?: number; y?: number }) => {
      const desc = target.selector !== undefined ? target.selector : `${target.x ?? "?"},${target.y ?? "?"}`;
      fake.seen.push(`click:${tabId}:${desc}`);
      return { tab: { tabId, url: "https://example.invalid/a", title: "例A", active: true }, element: "a#top" };
    },
    pageFill: async (tabId: number, fields: FillField[], sudo: { fill: boolean; urls: string[] }) => {
      fake.seen.push(`fill:${tabId}:${fields.length}:${sudo.fill}`);
      return { tab: { tabId, url: "https://example.invalid/a", title: "例A", active: true }, fields: fields.map((f) => ({ selector: f.selector, valueLength: f.value.length })) };
    },
    pageScroll: async (tabId: number, direction: "up" | "down", amount: number) => {
      fake.seen.push(`scroll:${tabId}:${direction}:${amount}`);
      return { tab: { tabId, url: "https://example.invalid/a", title: "例A", active: true }, scrollY: 600 };
    },
  };
  return fake;
};

// ============ 1. Native Messaging framing ============

test("framing: encode/decode 往復", () => {
  const frame = encodeNativeFrame('{"t":"ready","port":8765}');
  const out = createNativeReader().push(frame);
  assert.equal(out.length, 1);
  assert.equal(out[0], '{"t":"ready","port":8765}');
});

test("framing: 分割受信", () => {
  const frame = encodeNativeFrame(JSON.stringify({ hello: "world" }));
  const r = createNativeReader();
  assert.equal(r.push(frame.subarray(0, 3)).length, 0, "前半では未完成");
  const b = r.push(frame.subarray(3));
  assert.equal(b.length, 1, "後半で完成");
  assert.equal(expectRecord(JSON.parse(b[0]), "hello frame").hello, "world");
});

test("framing: 連続フレーム", () => {
  const r = createNativeReader();
  const out = r.push(Buffer.concat([encodeNativeFrame("1"), encodeNativeFrame("2"), encodeNativeFrame("3")]));
  assert.equal(out.join(","), "1,2,3");
});

test("framing: 32MB超フレーム拒否", () => {
  const r = createNativeReader();
  const head = Buffer.alloc(4);
  head.writeUInt32LE(NATIVE_FRAME_MAX + 1, 0);
  assert.throws(() => r.push(head), "NATIVE_FRAME_MAX超でthrowすべき");
});

// ============ 2. AddonBackend ============

test("backend: captureはresp1通でbase64を受け取る（chunkなし）", async () => {
  const sent: Record<string, unknown>[] = [];
  const b = createAddonBackend((o) => {
    sent.push(o);
  });
  const p = b.screenshot(7);
  assert.equal(expectString(expectRecord(sent[0], "req").cmd, "cmd"), "tabs/capture");
  const id = expectNumber(expectRecord(sent[0], "req").id, "req.id");
  b.onMessage({ t: "resp", id, ok: true, result: { tab: { tabId: 7, url: "https://example.invalid/a", title: "例", active: true }, base64: "QUJDRUZH" } });
  const r = await p;
  assert.equal(r.base64, "QUJDRUZH");
  assert.equal(r.tab.tabId, 7);
});

test("backend: respエラーはreject", async () => {
  const b = createAddonBackend(() => {});
  const p = b.readTab(7);
  p.catch(() => {}); // unhandled回避
  b.onMessage({ t: "resp", id: 1, ok: false, error: "タブがない" });
  await assert.rejects(p, /タブがない/, "エラー文が伝わるべき");
});

test("backend: listTabsはtabs配列検査（fail-closed）", async () => {
  const b = createAddonBackend(() => {});
  const p = b.listTabs();
  p.catch(() => {});
  b.onMessage({ t: "resp", id: 1, ok: true, result: {} }); // tabs無し
  await assert.rejects(p, "tabsが無ければfail-closed");
});

test("backend: タブ情報の検査強化: 4欄とも検証（fail-closed）", async () => {
  const b = createAddonBackend(() => {});
  const p = b.closeTab(9);
  p.catch(() => {});
  // url/title/activeが欠けた応答は、id検査だけの受入れより厳しく弾く
  b.onMessage({ t: "resp", id: 1, ok: true, result: { tab: { tabId: 9 } } });
  await assert.rejects(p, /fail-closed/, "TabInfo4欄検査で弾くべき");
});

test("backend: タイムアウト定数は15秒", () => {
  assert.equal(BACKEND_CALL_TIMEOUT_MS, 15000);
});

// ============ 3. config ============

test("config: RINKA_TOKEN envでOK", () => {
  const c = validateEnvironment({ RINKA_TOKEN: TOKEN }, tmp);
  assert.equal(c.token, TOKEN);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 8765);
});

test("config: 0600トークンファイルをloadTokenが読む", () => {
  const dir = join(tmp, "tok60");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "token");
  writeFileSync(path, TOKEN, { mode: 0o600 });
  assert.equal(loadToken({ RINKA_TOKEN_PATH: path }, dir), TOKEN);
});

test("config: 0644トークンファイルは拒否", () => {
  const dir = join(tmp, "tok64");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "token");
  writeFileSync(path, TOKEN, { mode: 0o644 });
  assert.throws(() => loadToken({ RINKA_TOKEN_PATH: path }, dir), /権限/, "権限緩いトークンファイルは拒否すべき");
});

test("config: トークン不在は/token/入りエラー", () => {
  const dir = join(tmp, "tokMissing");
  mkdirSync(dir, { recursive: true });
  assert.throws(() => loadToken({}, dir), /token/, "案内に行き先が要る");
});

test("config: 未知RINKA_*は拒否", () => {
  assert.throws(() => validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_EVIL: "1" }, tmp), /RINKA_EVIL/, "未知envは拒否すべき");
});

test("config: RINKA_PORT 範囲外は拒否・0許可", () => {
  assert.throws(() => validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_PORT: "99999" }, tmp), "65535超は拒否");
  assert.equal(validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_PORT: "0" }, tmp).port, 0, "port 0可");
});

test("config: RINKA_HOSTはlocalhostのみ", () => {
  assert.throws(() => validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_HOST: "0.0.0.0" }, tmp), "0.0.0.0は拒否（家規1）");
});

// ============ 4. audit ============

/** 固定Clock（決定性検査: ts欄は常にこの値になる）。本番はindex.tsが実測時計を注入する。 */
const fixedClock = (): string => "2026-11-22T00:00:00.000Z";

test("audit: 本文を書かない・引数は書く・Clock注入でtsは決定的", () => {
  const logPath = join(tmp, "audit-test.jsonl");
  const audit = createAudit(logPath, fixedClock);
  audit.record("read_tab", { tabId: 7 });
  audit.record("search_history", { query: "keyword", limit: 20 });
  const text = readFileSync(logPath, "utf8");
  assert.ok(!text.includes("SECRETTEXT-MARKER"), "本文マーカーが監査ログに漏れた");
  assert.ok(text.includes("read_tab") && text.includes("tabId"), "引数は記録されるべき");
  assert.ok(text.includes("keyword"), "検索語は記録されるべき");
  const lines = text.trim().split("\n").map((l) => expectRecord(JSON.parse(l), "監査行"));
  for (const line of lines) {
    assert.equal(expectString(line.ts, "ts"), "2026-11-22T00:00:00.000Z", "Clock注入でtsは決定的");
  }
});

test("audit: ローテーション 64KB超で path.1 へ（再起動を跨ぐサイズ方式）", () => {
  const logPath = join(tmp, "audit-rot.jsonl");
  const audit = createAudit(logPath, fixedClock);
  const big = "k".repeat(120);
  for (let i = 0; i < 700; i++) audit.record("search_history", { query: big, limit: 20 });
  assert.ok(existsSync(logPath + ".1"), "旧ログが .1 に退避すべき");
});

// ============ 5. tools (FakeBackend) ============

const toolDeps = (cfg: Partial<Config> = {}): ToolDeps => {
  return { config: testConfig(cfg), audit: createAudit(join(tmp, "tools-audit.jsonl"), fixedClock), backend: createFakeBackend() };
};

test("tools: 14ツール定義（読み取り4＋書込み10）", () => {
  assert.equal(TOOLS.length, 14);
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    [
      "list_tabs", "read_tab", "screenshot", "search_history",
      "open_tab", "close_tab", "activate_tab",
      "navigate_tab", "reload_tab", "go_back", "go_forward",
      "page_click", "page_fill", "page_scroll",
    ],
  );
  for (const t of TOOLS) assert.ok(t.description.includes("信頼できない"), `${t.name}: untrusted注記が必要`);
  for (const t of TOOLS.slice(4)) {
    assert.ok(t.description.includes("WRITE状態"), `${t.name}: WRITE制限の注記が必要`);
  }
});

test("tools: read_tab wrapperで包む・監査に本文なし", async () => {
  const logPath = join(tmp, "read-audit.jsonl");
  const deps = { config: testConfig(), audit: createAudit(logPath, fixedClock), backend: createFakeBackend() };
  const r = await callTool("read_tab", { tabId: 7 }, deps);
  const c = expectString(r.content, "content");
  assert.ok(c.startsWith('<rinka-page-content untrusted="true">'), "wrapperで包む");
  assert.ok(c.includes("SECRETTEXT-MARKER"), "本文が入っている");
  assert.ok(c.endsWith("</rinka-page-content>"), "wrapperで閉じる");
  assert.ok(!readFileSync(logPath, "utf8").includes("SECRETTEXT-MARKER"), "監査ログに本文を書かない");
});

test("tools: read_tab readMaxBytes上限強制（バイト単位・UTF-8境界）", async () => {
  // CJK交じり（「本文」は3byte/字）で上限10byte: きっちり10byteに切り、壊れ尾はU+FFFDを捨てる
  const deps = toolDeps({ readMaxBytes: 10 });
  const r = await callTool("read_tab", { tabId: 7 }, deps);
  const c = expectString(r.content, "content").replace(/<\/?rinka-page-content[^>]*>/g, "").trim();
  assert.ok(Buffer.byteLength(c, "utf8") <= 10, `バイト上限内: ${Buffer.byteLength(c, "utf8")}`);
  assert.ok(!c.endsWith("\uFFFD"), "末尾の壊れたUTF-8は捨てる");
});

test("tools: screenshot screenshotMaxBytes上限は拒否", async () => {
  const deps = toolDeps({ screenshotMaxBytes: 3 }); // "QUJDRA=="より小さい
  await assert.rejects(callTool("screenshot", { tabId: 7 }, deps), /上限/, "上限超はエラー");
});

test("tools: search_history limitはhistoryMaxRowsに強制", async () => {
  const deps = toolDeps();
  const r = await callTool("search_history", { query: "kw", limit: 99999 }, deps);
  const rows = expectArray(r.rows, "rows");
  assert.equal(rows.length, 1);
  const row0 = expectRecord(rows[0], "rows[0]");
  assert.ok(expectString(row0.url, "rows[0].url").includes("limit=20"), "limitが20に強制されるべき");
});

test("tools: query必須・tabId必須", async () => {
  const deps = toolDeps();
  await assert.rejects(callTool("search_history", {}, deps), "query無しは拒否");
  await assert.rejects(callTool("read_tab", {}, deps), "tabId無しは拒否");
});

// ============ 5b. tools v2 書込み（mode・対象・固定リミッタ・監査） ============

test("tools v2: READ状態の書込みは二次ガードで拒否（WRITE案内）", async () => {
  const deps = toolDeps(); // FakeBackend.mode = "read"
  for (const name of ["open_tab", "close_tab", "activate_tab", "navigate_tab", "reload_tab", "go_back", "go_forward", "page_click", "page_fill", "page_scroll"]) {
    await assert.rejects(callTool(name, { tabId: 7, url: "https://example.invalid/x" }, deps), /WRITE/, `${name}: READでは拒否すべき`);
  }
});

test("tools v2: WRITE状態ならopen_tabなどが通る・監査にwrite:1とURL", async () => {
  const logPath = join(tmp, "write-audit.jsonl");
  const backend = createFakeBackend();
  backend.mode = "write";
  const deps = { config: testConfig(), audit: createAudit(logPath, fixedClock), backend };
  const r = await callTool("open_tab", { url: "https://example.invalid/opened" }, deps);
  assert.equal(expectNumber(expectRecord(r.tab, "tab").tabId, "tab.tabId"), 99);
  assert.ok(backend.seen.includes("open:https://example.invalid/opened:true"), "backend.openTabが呼ばれる");
  const line = readFileSync(logPath, "utf8");
  assert.ok(line.includes('"write":1'), "監査にwrite:1");
  assert.ok(line.includes("https://example.invalid/opened"), "監査に対象URL（実行前採取）");
});

test("tools v2: open/navigateのURLはhttp/httpsのみ・2048字上限", async () => {
  const backend = createFakeBackend();
  backend.mode = "write";
  const deps = { config: testConfig(), audit: createAudit(join(tmp, "url-audit.jsonl"), fixedClock), backend };
  await assert.rejects(callTool("open_tab", { url: "file:///etc/passwd" }, deps), /http/, "file:拒否");
  await assert.rejects(callTool("open_tab", { url: "javascript:alert(1)" }, deps), /http/, "javascript:拒否");
  await assert.rejects(callTool("open_tab", { url: "https://example.invalid/" + "a".repeat(2100) }, deps), /2048/, "長すぎ");
  await assert.rejects(callTool("navigate_tab", { tabId: 7, url: "about:config" }, deps), /http/, "about:拒否");
});

test("tools v2: page_fill fields検査（1〜20欄・fill1欄上限・監査に値なし）", async () => {
  const logPath = join(tmp, "fill-audit.jsonl");
  const backend = createFakeBackend();
  backend.mode = "write";
  const deps = { config: testConfig(), audit: createAudit(logPath, fixedClock), backend };
  await assert.rejects(callTool("page_fill", { tabId: 7, fields: [] }, deps), /1〜20/, "0欄拒否");
  await assert.rejects(callTool("page_fill", { tabId: 7, fields: Array.from({ length: 21 }, (_, i) => ({ selector: `#f${i}`, value: "x" })) }, deps), /1〜20/, "21欄拒否");
  await assert.rejects(
    callTool("page_fill", { tabId: 7, fields: [{ selector: "#a", value: "x".repeat(4097) }] }, deps),
    /4096/,
    "fill1欄バイト上限",
  );
  const r = await callTool("page_fill", { tabId: 7, fields: [{ selector: "#a", value: "秘密の値SECRETVAL" }, { selector: "#b", value: "y" }] }, deps);
  const fieldsOut = expectArray(r.fields, "fields");
  assert.equal(fieldsOut.length, 2);
  assert.equal(expectNumber(expectRecord(fieldsOut[0], "fields[0]").valueLength, "valueLength"), "秘密の値SECRETVAL".length);
  const auditText = readFileSync(logPath, "utf8");
  assert.ok(!auditText.includes("秘密の値SECRETVAL"), "fill値は監査に残さない（家規5）");
  assert.ok(!auditText.includes("SECRETVAL"), "fill値は監査に残さない");
  assert.ok(auditText.includes('"write":1'), "fillもwrite:1");
  assert.ok(auditText.includes("valueLengths"), "長さの配列のみ記録");
});

test("tools v2: page_clickはselector/xy排他・範囲検査", async () => {
  const backend = createFakeBackend();
  backend.mode = "write";
  const deps = { config: testConfig(), audit: createAudit(join(tmp, "click-audit.jsonl"), fixedClock), backend };
  await assert.rejects(callTool("page_click", { tabId: 7 }, deps), /どちらか一方/, "両方無し拒否");
  await assert.rejects(callTool("page_click", { tabId: 7, selector: "a", x: 1, y: 1 }, deps), /どちらか一方/, "両方指定拒否");
  await assert.rejects(callTool("page_click", { tabId: 7, x: -1, y: 5 }, deps), /0〜20000/, "負座標拒否");
  const r = await callTool("page_click", { tabId: 7, selector: "a#top" }, deps);
  assert.equal(expectString(r.element, "element"), "a#top");
});

test("tools v2: page_scroll方向・量検査", async () => {
  const backend = createFakeBackend();
  backend.mode = "write";
  const deps = { config: testConfig(), audit: createAudit(join(tmp, "scroll-audit.jsonl"), fixedClock), backend };
  await assert.rejects(callTool("page_scroll", { tabId: 7, direction: "sideways" }, deps), /up.*down/, "方向検査");
  await assert.rejects(callTool("page_scroll", { tabId: 7, direction: "down", amount: 99999 }, deps), /1〜10000/, "量上限");
  const r = await callTool("page_scroll", { tabId: 7, direction: "down" }, deps);
  assert.equal(expectNumber(r.scrollY, "scrollY"), 600, "既定600で動きscrollYが返る");
});

test("tools v2: tabId型検査（全書込み共通）", async () => {
  const backend = createFakeBackend();
  backend.mode = "write";
  const deps = { config: testConfig(), audit: createAudit(join(tmp, "tabid-audit.jsonl"), fixedClock), backend };
  await assert.rejects(callTool("close_tab", { tabId: " siete" }, deps), /tabId/, "文字列tabId拒否");
  await assert.rejects(callTool("reload_tab", {}, deps), /tabId/, "tabId無し拒否");
});

// ============ 3b. config v2（書込み系env） ============

test("config v2: 新4envの既定値", () => {
  const c = validateEnvironment({ RINKA_TOKEN: TOKEN }, tmp);
  assert.equal(c.writeTimeoutSec, 1800, "WRITE自動落ち既定1800秒");
  assert.equal(c.sudoFill, false, "sudo既定false");
  assert.deepEqual(c.sudoFillUrls, [], "allowlist既定空");
  assert.equal(c.fillMaxBytes, 4096, "fill上限既定4096");
});

test("config v2: RINKA_SUDO_FILL はboolStrict（不正値は起動拒否）", () => {
  assert.equal(validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_SUDO_FILL: "yes" }, tmp).sudoFill, true);
  assert.equal(validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_SUDO_FILL: "0" }, tmp).sudoFill, false);
  assert.throws(() => validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_SUDO_FILL: "maybe" }, tmp), /true\/false/, "あいまい値は拒否");
  assert.throws(() => validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_WRITE_TIMEOUT_SECONDS: "0" }, tmp), /1〜86400/, "0秒は拒否");
});

test("config v2: RINKA_SUDO_FILL_URLS はhttp/httpsのみ・カンマ区切り", () => {
  const c = validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_SUDO_FILL_URLS: "https://a.example/, http://b.example/path" }, tmp);
  assert.equal(c.sudoFillUrls.length, 2, "カンマ分割");
  assert.throws(() => validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_SUDO_FILL_URLS: "ftp://x.example/" }, tmp), /http\/https/, "ftp拒否");
  assert.throws(() => validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_SUDO_FILL_URLS: "not a url" }, tmp), /不正なURL/, "非URL拒否");
});

test("audit v2: 書込みタグはwrite:1+URL・URL無しは書かない", () => {
  const logPath = join(tmp, "audit-v2.jsonl");
  const audit = createAudit(logPath, fixedClock);
  audit.record("open_tab", { url: "https://x.example/p" }, { write: true, url: "https://x.example/p" });
  audit.record("read_tab", { tabId: 7 });
  const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => expectRecord(JSON.parse(l), "監査行"));
  assert.equal(lines[0].write, 1, "write:1");
  assert.equal(lines[0].url, "https://x.example/p", "実行前URL");
  assert.equal(lines[1].write, undefined, "読み取りにはwriteが無い");
  assert.equal(lines[1].url, undefined);
});

test("audit v2: プリミティブ配列は通す・オブジェクト混じりは落とす", () => {
  const logPath = join(tmp, "audit-arr.jsonl");
  const audit = createAudit(logPath, fixedClock);
  audit.record("page_fill", { tabId: 7, valueLengths: [5, 30] }, { write: true, url: "https://x.example/" });
  audit.record("evil", { fields: [{ selector: "a", value: "leak" }] });
  const text = readFileSync(logPath, "utf8");
  assert.ok(text.includes("[5,30]"), "プリミ配列は記録される");
  assert.ok(!text.includes("leak"), "オブジェクト配列は監査に落とす");
  assert.ok(!text.includes("selector"), "オブジェクト要素は記録しない");
});

// ============ 6. mcp ============

const mcpDeps: ToolDeps = { config: testConfig(), audit: createAudit(join(tmp, "mcp-audit.jsonl"), fixedClock), backend: createFakeBackend() };

test("mcp: initialize protocolVersion一致", async () => {
  const r = await handleRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: SUPPORTED_PROTOCOL, capabilities: {}, clientInfo: {} } }, mcpDeps);
  assert.ok(isRpcOk(r), "応答がある");
  assert.ok(r !== null);
  assert.equal(expectString(r.result.protocolVersion, "protocolVersion"), SUPPORTED_PROTOCOL);
  const info = expectRecord(r.result.serverInfo, "serverInfo");
  assert.equal(expectString(info.name, "serverInfo.name"), "rinka");
});

test("mcp: ping / tools/list", async () => {
  const p = await handleRpcMessage({ jsonrpc: "2.0", id: 2, method: "ping" }, mcpDeps);
  assert.ok(isRpcOk(p));
  assert.ok(p !== null);
  assert.deepEqual(p.result, {});
  const l = await handleRpcMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, mcpDeps);
  assert.ok(isRpcOk(l));
  assert.ok(l !== null);
  assert.equal(expectArray(l.result.tools, "tools").length, 14);
});

test("mcp: 通知はnull（HTTP層が202）", async () => {
  const r = await handleRpcMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, mcpDeps);
  assert.equal(r, null);
});

test("mcp: 未知メソッド -32601 / 未知ツール -32602 / 無効JSONRPC -32600", async () => {
  const m = await handleRpcMessage({ jsonrpc: "2.0", id: 4, method: "no/such" }, mcpDeps);
  assert.ok(m !== null && "error" in m);
  assert.equal(m.error.code, -32601);
  const t = await handleRpcMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "steal_passwords", arguments: {} } }, mcpDeps);
  assert.ok(t !== null && "error" in t);
  assert.equal(t.error.code, -32602);
  const i = await handleRpcMessage({ id: 6, method: "ping" }, mcpDeps);
  assert.ok(i !== null && "error" in i);
  assert.equal(i.error.code, -32600);
});

test("mcp: tools/call実行エラーはisError:true（プロトコルエラーにしない）", async () => {
  const boom = createFakeBackend();
  boom.readTab = async (): Promise<never> => {
    throw new Error("ブーム");
  };
  const deps = { config: testConfig(), audit: createAudit(join(tmp, "boom-audit.jsonl"), fixedClock), backend: boom };
  const r = await handleRpcMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_tab", arguments: { tabId: 7 } } }, deps);
  assert.ok(isRpcOk(r));
  assert.ok(r !== null);
  assert.equal(r.result.isError, true);
  const content = expectArray(r.result.content, "content");
  assert.ok(expectString(expectRecord(content[0], "content[0]").text, "content[0].text").includes("ブーム"), "エラー文が乗る");
});

test("mcp: resources/prompts は未サポート（-32601・空stubは返さない）", async () => {
  const r1 = await handleRpcMessage({ jsonrpc: "2.0", id: 8, method: "resources/list" }, mcpDeps);
  assert.ok(r1 !== null && "error" in r1);
  assert.equal(r1.error.code, -32601);
  const r2 = await handleRpcMessage({ jsonrpc: "2.0", id: 9, method: "prompts/list" }, mcpDeps);
  assert.ok(r2 !== null && "error" in r2);
  assert.equal(r2.error.code, -32601);
});

// ============ 7. http 素（セッションレス） ============

const auditPathHttp = join(tmp, "http-audit.jsonl");
let srv: RunningServer | undefined;
let base = "";
const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
const PING = '{"jsonrpc":"2.0","id":1,"method":"ping"}';

before(async () => {
  srv = await startServer({ config: testConfig({ auditPath: auditPathHttp }), audit: createAudit(auditPathHttp, fixedClock), backend: createFakeBackend() });
  base = `http://127.0.0.1:${srv.port}/mcp`;
});

after(async () => {
  if (srv !== undefined) await srv.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("http: tokenMatches 一致・不一致・欠落", () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches("y".repeat(40), TOKEN), false);
  assert.equal(tokenMatches("xy", TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
});

test("http: Bearer無し401 / GETは404", async () => {
  assert.equal((await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(base, { method: "GET", headers: H })).status, 404);
});

test("http: Origin付きは403 / localhost Originは通す", async () => {
  assert.ok(srv !== undefined, "beforeで起動済み");
  assert.equal((await fetch(base, { method: "POST", headers: { ...H, Origin: "https://evil.example" }, body: PING })).status, 403);
  assert.equal((await fetch(base, { method: "POST", headers: { ...H, Origin: `http://localhost:${srv.port}` }, body: PING })).status, 200);
});

test("http: 壊JSONは400 -32700", async () => {
  const r = await fetch(base, { method: "POST", headers: H, body: "{oops" });
  assert.equal(r.status, 400);
  const j = expectRecord(await r.json(), "error json");
  assert.equal(expectNumber(expectRecord(j.error, "error").code, "error.code"), -32700);
});

test("http: initialize→tools/call往復→通知202（セッションレス）", async () => {
  const i = await fetch(base, { method: "POST", headers: H, body: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"${SUPPORTED_PROTOCOL}"}}` });
  assert.equal(i.status, 200);
  assert.equal(i.headers.get("mcp-session-id"), null, "セッションは発行しない");

  const c = await fetch(base, { method: "POST", headers: H, body: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}' });
  assert.equal(c.status, 200);
  const j = expectRecord(await c.json(), "list_tabs json");
  const sc = expectRecord(j.result, "result").structuredContent;
  const tabs = expectArray(expectRecord(sc, "structuredContent").tabs, "tabs");
  assert.equal(tabs.length, 1);
  assert.equal(expectNumber(expectRecord(tabs[0], "tabs[0]").tabId, "tabId"), 7);

  const n = await fetch(base, { method: "POST", headers: H, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
  assert.equal(n.status, 202);
});

// ============ 8. E2E: host spawn + アドオン役 ============

/** E2Eでアドオン役を演じる: req 1通に応答を返す（cmdに応じた固定応答・未実装はエラー）。 */
const writeE2eResp = (write: (b: Buffer) => void, req: Record<string, unknown>, tab42: Record<string, unknown>): void => {
  const id = req.id;
  if (req.cmd === "tabs/list") {
    write(encodeNativeFrame(JSON.stringify({ t: "resp", id, ok: true, result: { tabs: [tab42] } })));
  } else if (req.cmd === "tabs/capture") {
    write(encodeNativeFrame(JSON.stringify({ t: "resp", id, ok: true, result: { tab: tab42, base64: "QUJDRUZH" } })));
  } else if (req.cmd === "tabs/open") {
    write(encodeNativeFrame(JSON.stringify({ t: "resp", id, ok: true, result: { tab: { tabId: 55, url: "https://example.invalid/opened", title: "開いた", active: true } } })));
  } else {
    write(encodeNativeFrame(JSON.stringify({ t: "resp", id, ok: false, error: `E2E未実装cmd: ${req.cmd}` })));
  }
};


test("E2E: ready→cfg→401→initialize→list_tabs→screenshot単一resp→WRITE往復→exit 0", { timeout: 30000 }, async () => {
  const e2eAudit = join(tmp, "e2e-audit.jsonl");
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "native-host/src/index.ts")], {
    cwd: ROOT,
    env: { ...process.env, RINKA_TOKEN: TOKEN, RINKA_PORT: "0", RINKA_AUDIT_PATH: e2eAudit },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

  const reader = createNativeReader();
  const frames: Record<string, unknown>[] = [];
  let readyPort = 0;
  let cfgSeen = 0;
  const tab42 = { tabId: 42, url: "https://example.invalid/e2e", title: "E2E", active: true };
  child.stdout.on("data", (d: Buffer) => {
    for (const f of reader.push(d)) {
      const obj = expectRecord(JSON.parse(f), "E2E frame");
      frames.push(obj);
      if (obj.t === "req") {
        writeE2eResp((b) => child.stdin.write(b), obj, tab42);
      }
      if (obj.t === "ready" && typeof obj.port === "number") readyPort = obj.port;
      // v2: ready直後に {t:"cfg", writeTimeoutSec} が来る（index.ts）
      if (obj.t === "cfg" && typeof obj.writeTimeoutSec === "number") cfgSeen = obj.writeTimeoutSec;
    }
  });

  // ready待ち（Date.now不使用: 25ms刻み×200回=最大5秒の回数上限ループ）
  for (let i = 0; i < 200 && readyPort === 0; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(readyPort > 0, `readyが来ない: ${stderr}`);

  const e2eBase = `http://127.0.0.1:${readyPort}/mcp`;
  const e2eH = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

  // 401: Bearer無し
  assert.equal((await fetch(e2eBase, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);

  // initialize（セッションレス）
  const i = await fetch(e2eBase, { method: "POST", headers: e2eH, body: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"${SUPPORTED_PROTOCOL}"}}` });
  assert.equal(i.status, 200);

  // tools/call list_tabs → hostがreqをstdoutへ → アドオン役が応答
  const c = await fetch(e2eBase, { method: "POST", headers: e2eH, body: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}' });
  assert.equal(c.status, 200);
  const cj = expectRecord(await c.json(), "list_tabs json");
  const sc = expectRecord(expectRecord(cj.result, "result").structuredContent, "structuredContent");
  const tabs = expectArray(sc.tabs, "tabs");
  const tab0 = expectRecord(tabs[0], "tabs[0]");
  assert.equal(expectNumber(tab0.tabId, "tabId"), 42);
  assert.equal(expectString(tab0.url, "url"), "https://example.invalid/e2e");

  // tools/call screenshot → resp1通で受ける
  const s = await fetch(e2eBase, { method: "POST", headers: e2eH, body: '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"screenshot","arguments":{"tabId":42}}}' });
  assert.equal(s.status, 200);
  const sj = expectRecord(await s.json(), "screenshot json");
  const ssc = expectRecord(expectRecord(sj.result, "result").structuredContent, "structuredContent");
  assert.equal(expectString(ssc.pngBase64, "pngBase64"), "QUJDRUZH");
  assert.equal(expectNumber(expectRecord(ssc.tab, "tab").tabId, "tabId"), 42);

  // v2: cfg フレーム（WRITE自動落ち秒数の通知）
  assert.ok(cfgSeen === 1800, "ready直後にcfg(writeTimeoutSec=1800)が来るはず");

  // v2: READ状態での open_tab → 二次modeガードでisError（addon reqは出ない）
  const w1 = await fetch(e2eBase, { method: "POST", headers: e2eH, body: '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"open_tab","arguments":{"url":"https://example.invalid/opened"}}}' });
  const w1j = expectRecord(expectRecord(await w1.json(), "READ拒否 json").result, "result");
  assert.equal(w1j.isError, true, "READでは書込み拒否");
  assert.ok(expectString(expectRecord(expectArray(w1j.content, "content")[0], "content[0]").text, "text").includes("WRITE"), "案内文言が乗る");

  // v2: アドオン役が {t:"mode", v:"write"} を通知 → WRITE状態
  child.stdin.write(encodeNativeFrame(JSON.stringify({ t: "mode", v: "write" })));

  // v2: WRITE状態での open_tab → hostがtabs/open reqをstdoutへ → 往復成功
  const w2 = await fetch(e2eBase, { method: "POST", headers: e2eH, body: '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"open_tab","arguments":{"url":"https://example.invalid/opened"}}}' });
  assert.equal(w2.status, 200);
  const w2j = expectRecord(expectRecord(await w2.json(), "WRITE json").result, "result");
  assert.equal(w2j.isError, false, "WRITEでは書込みが通る");
  const w2sc = expectRecord(w2j.structuredContent, "structuredContent");
  assert.equal(expectNumber(expectRecord(w2sc.tab, "tab").tabId, "tabId"), 55);
  assert.equal(expectString(expectRecord(w2sc.tab, "tab").url, "url"), "https://example.invalid/opened");

  // 監査ログ: ツール名とwriteタグはある・fill値相当の漏洩は無い
  const auditText = readFileSync(e2eAudit, "utf8");
  assert.ok(auditText.includes("list_tabs"), "監査にlist_tabsが残る");
  assert.ok(auditText.includes('"write":1'), "open_tab監査にwrite:1");

  // OFFトグル相当: stdinを閉じる → host終了
  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
    child.stdin.end();
  });
  assert.equal(exitCode, 0);

  // 応答が全部来たか（reqは3通: list_tabs / screenshot / open_tab（READ拒否はreq自体が出ない））
  const reqs = frames.filter((f) => f.t === "req");
  assert.equal(reqs.length, 3);
  assert.equal(reqs[2].cmd, "tabs/open", "WRITE時のみtabs/open reqが出る");
});

// ============ 9. xpi ビルド（依存ゼロの配布物 packager） ============

test("xpi: build→central directory解釈→stored実byte一致（往復）", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from('{"a":1}', "utf8") },
    { name: "icons/icon.svg", data: Buffer.from("<svg/>", "utf8") },
  ];
  const xpi = buildXpi(entries);
  verifyStored(xpi, entries); // 壊れていればthrow
  const records = readCentralDirectory(xpi);
  assert.equal(records.length, 2);
  assert.equal(records[0].name, "manifest.json");
  assert.equal(records[1].name, "icons/icon.svg");
  // 大きめのデータでCRC/サイズ検査も実質的に踏む
  const big = Buffer.alloc(5000, 7);
  const xpi2 = buildXpi([{ name: "big.bin", data: big }]);
  verifyStored(xpi2, [{ name: "big.bin", data: big }]);
});

test("xpi: 検체が壊れていればverifyStoredが弾く（fail-closed）", () => {
  const entries = [{ name: "a.txt", data: Buffer.from("hello", "utf8") }];
  const xpi = buildXpi(entries);
  const broken = Buffer.from(xpi); // 複製してデータ部1byteを壊す（dataStart は central directory から実測）
  const rec = readCentralDirectory(broken)[0];
  const dataStart = rec.offset + 30 + "a.txt".length; // local header 30byte + name（extra無しを検証側契約として壊す）
  broken[dataStart] ^= 0xff;
  assert.throws(() => verifyStored(broken, entries), /検証NG/, "壊れた格納データは検証で弾く");
});

test("SERVER_INFO は manifest と同じ識別子", () => {
  assert.equal(SERVER_INFO.name, "rinka");
});
