/**
 * rinka — test/run-tests.ts 全量テスト（ツール外実行禁止・依存ゼロ）。
 *
 * 実行: node --experimental-strip-types --no-warnings test/run-tests.ts
 * ハング対策で240秒ウォッチドッグ(unref)を仕込む（run_testsは必ず終わる）。
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeNativeFrame, NativeReader, NATIVE_FRAME_MAX } from "../native-host/src/native.ts";
import { AddonBackend, BACKEND_CALL_TIMEOUT_MS } from "../native-host/src/backend.ts";
import { validateEnvironment, loadToken } from "../native-host/src/config.ts";
import { createAudit } from "../native-host/src/audit.ts";
import { TOOLS, callTool } from "../native-host/src/tools.ts";
import { handleRpcMessage, SUPPORTED_PROTOCOL } from "../native-host/src/mcp.ts";
import { tokenMatches, startServer } from "../native-host/src/http.ts";
import type { Backend, TabInfo, HistoryRow } from "../native-host/src/types.ts";
import type { Config } from "../native-host/src/config.ts";
import type { ToolDeps } from "../native-host/src/tools.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG = setTimeout(() => {
  console.error("WATCHDOG: テストが240秒以内に終わりませんでした。強制終了します");
  process.exit(124);
}, 240_000);
WATCHDOG.unref?.();

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  const t = setTimeout(() => {
    throw new Error(`test(10s timeout): ${name}`);
  }, 10_000);
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.error(`  FAIL - ${name}\n      ${msg}`);
  } finally {
    clearTimeout(t);
  }
}
function eq(name: string, a: unknown, b: unknown): void {
  if (a !== b) throw new Error(`${name}: 期待=${JSON.stringify(b)} 実測=${JSON.stringify(a)}`);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const TOKEN = "x".repeat(40);
function testConfig(over: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    readMaxBytes: 65536,
    screenshotMaxBytes: 4194304,
    historyMaxRows: 20,
    auditPath: "/dev/null",
    ...over,
  };
}

// ---------------- FakeBackend ----------------

class FakeBackend implements Backend {
  async listTabs(): Promise<{ tabs: TabInfo[] }> {
    return { tabs: [{ tabId: 7, url: "https://example.invalid/a", title: "例A", active: true }] };
  }
  async readTab(tabId: number): Promise<{ tab: TabInfo; text: string }> {
    return { tab: { tabId, url: "https://example.invalid/a", title: "例A", active: true }, text: "本文SECRETTEXT-MARKERだよ" };
  }
  async screenshot(tabId: number): Promise<{ tab: TabInfo; base64: string }> {
    return { tab: { tabId, url: "https://example.invalid/a", title: "例A", active: true }, base64: "QUJDRA==" };
  }
  async searchHistory(query: string, limit: number): Promise<HistoryRow[]> {
    return [{ url: `https://example.invalid/?q=${query}&limit=${limit}`, title: "検索", visitCount: 3, lastVisit: "2026-11-20T00:00:00.000Z" }];
  }
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rinka-test-"));

  // ============ 1. Native Messaging framing ============
  console.log("== framing ==");

  await test("encode/decode 往復", () => {
    const frame = encodeNativeFrame('{"t":"ready","port":8765}');
    const r = new NativeReader();
    const out = r.push(frame);
    eq("往復", out.length, 1);
    eq("中身", out[0], '{"t":"ready","port":8765}');
  });

  await test("分割受信", () => {
    const frame = encodeNativeFrame(JSON.stringify({ hello: "world" }));
    const r = new NativeReader();
    const a = r.push(frame.subarray(0, 3));
    eq("前半では未完成", a.length, 0);
    const b = r.push(frame.subarray(3));
    eq("後半で完成", b.length, 1);
    eq("中身", JSON.parse(b[0]).hello, "world");
  });

  await test("連続フレーム", () => {
    const r = new NativeReader();
    const out = r.push(Buffer.concat([encodeNativeFrame("1"), encodeNativeFrame("2"), encodeNativeFrame("3")]));
    eq("3件", out.join(","), "1,2,3");
  });

  await test("32MB超フレーム拒否", () => {
    const r = new NativeReader();
    const head = Buffer.alloc(4);
    head.writeUInt32LE(NATIVE_FRAME_MAX + 1, 0);
    let threw = false;
    try {
      r.push(head);
    } catch {
      threw = true;
    }
    assert(threw, "NATIVE_FRAME_MAX超でthrowすべき");
  });

  // ============ 2. AddonBackend ============
  console.log("== AddonBackend ==");

  await test("chunk再合成: captureはchunk送り→respで締める", async () => {
    const sent: Record<string, unknown>[] = [];
    const b = new AddonBackend((o) => sent.push(o), testConfig());
    const p = b.screenshot(7);
    // id=1のreqが来ているはず
    eq("req cmd", sent[0].cmd, "tabs/capture");
    const id = sent[0].id as number;
    b.onMessage({ t: "chunk", id, part: "QUFB" });
    b.onMessage({ t: "chunk", id, part: "Q0JE" });
    b.onMessage({ t: "resp", id, ok: true, result: { tab: { tabId: 7 } } });
    const r = await p;
    eq("base64合成", r.base64, "QUFBQ0JE");
    eq("tab", r.tab.tabId, 7);
  });

  await test("respエラーはreject", async () => {
    const b = new AddonBackend(() => {}, testConfig());
    const p = b.readTab(7);
    p.catch(() => {}); // unhandled回避
    b.onMessage({ t: "resp", id: 1, ok: false, error: "タブがない" });
    let msg = "";
    try {
      await p;
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes("タブがない"), `エラー文が伝わるべき: ${msg}`);
  });

  await test("chunk防御: 512KB超のpartは拒否", () => {
    const b = new AddonBackend(() => {}, testConfig());
    const p = b.screenshot(1);
    p.catch(() => {}); // pending登録のための呼び出し（結果は使わない）
    let threw = false;
    try {
      b.onMessage({ t: "chunk", id: 1, part: "x".repeat(512 * 1024 + 1) });
    } catch {
      threw = true;
    }
    assert(threw, "512KB超chunkでthrowすべき");
  });

  await test("listTabsはtabs配列検査（fail-closed）", async () => {
    const b = new AddonBackend(() => {}, testConfig());
    const p = b.listTabs();
    p.catch(() => {});
    b.onMessage({ t: "resp", id: 1, ok: true, result: {} }); // tabs無し
    let threw = false;
    try {
      await p;
    } catch {
      threw = true;
    }
    assert(threw, "tabsが無ければfail-closed");
  });

  await test("タイムアウト定数は15秒", () => {
    eq("ms", BACKEND_CALL_TIMEOUT_MS, 15000);
  });

  // ============ 3. config ============
  console.log("== config ==");

  await test("RINKA_TOKEN envでOK", () => {
    const c = validateEnvironment({ RINKA_TOKEN: TOKEN }, tmp);
    eq("token", c.token, TOKEN);
    eq("host", c.host, "127.0.0.1");
    eq("port", c.port, 8765);
  });

  await test("0600トークンファイルをloadTokenが読む", () => {
    const dir = join(tmp, "tok60");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "token");
    writeFileSync(path, TOKEN, { mode: 0o600 });
    const t = loadToken({ RINKA_TOKEN_PATH: path }, dir);
    eq("token", t, TOKEN);
  });

  await test("0644トークンファイルは拒否", () => {
    const dir = join(tmp, "tok64");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "token");
    writeFileSync(path, TOKEN, { mode: 0o644 });
    let threw = false;
    try {
      loadToken({ RINKA_TOKEN_PATH: path }, dir);
    } catch (e) {
      threw = (e as Error).message.includes("権限");
    }
    assert(threw, "権限緩いトークンファイルは拒否すべき");
  });

  await test("トークン不在は/token/入りエラー", () => {
    const dir = join(tmp, "tokMissing");
    mkdirSync(dir, { recursive: true });
    let msg = "";
    try {
      loadToken({}, dir);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes("/token") || msg.includes("token"), `案内に行き先が要る: ${msg}`);
  });

  await test("未知RINKA_*は拒否", () => {
    let threw = false;
    try {
      validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_EVIL: "1" }, tmp);
    } catch (e) {
      threw = (e as Error).message.includes("RINKA_EVIL");
    }
    assert(threw, "未知envは拒否すべき");
  });

  await test("RINKA_PORT 範囲外は拒否・0許可", () => {
    let threw = false;
    try {
      validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_PORT: "99999" }, tmp);
    } catch {
      threw = true;
    }
    assert(threw, "65535超は拒否");
    eq("port 0可", validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_PORT: "0" }, tmp).port, 0);
  });

  await test("RINKA_HOSTはlocalhostのみ", () => {
    let threw = false;
    try {
      validateEnvironment({ RINKA_TOKEN: TOKEN, RINKA_HOST: "0.0.0.0" }, tmp);
    } catch {
      threw = true;
    }
    assert(threw, "0.0.0.0は拒否（家規1）");
  });

  // ============ 4. audit ============
  console.log("== audit ==");

  await test("監査は本文を書かない・引数は書く", () => {
    const logPath = join(tmp, "audit-test.jsonl");
    const audit = createAudit(logPath);
    audit.record("read_tab", { tabId: 7 });
    audit.record("search_history", { query: "keyword", limit: 20 });
    const text = readFileSync(logPath, "utf8");
    assert(!text.includes("SECRETTEXT-MARKER"), "本文マーカーが監査ログに漏れた");
    assert(text.includes("read_tab") && text.includes("tabId"), "引数は記録されるべき");
    assert(text.includes("keyword"), "検索語は記録されるべき");
  });

  await test("ローテーション: 512件で path.1 へ", () => {
    const logPath = join(tmp, "audit-rot.jsonl");
    const audit = createAudit(logPath);
    for (let i = 0; i < 513; i++) audit.record("list_tabs", {});
    assert(statSync(logPath + ".1").size > 0, "旧ログが .1 に退避すべき");
    eq("新ログは1件", readFileSync(logPath, "utf8").trim().split("\n").length, 1);
  });

  // ============ 5. tools (FakeBackend) ============
  console.log("== tools ==");

  function toolDeps(cfg: Partial<Config> = {}): ToolDeps {
    return { config: testConfig(cfg), audit: createAudit(join(tmp, "tools-audit.jsonl")), backend: new FakeBackend() };
  }

  await test("4ツール定義", () => {
    eq("本数", TOOLS.length, 4);
    eq("名前", TOOLS.map((t) => t.name).join(","), "list_tabs,read_tab,screenshot,search_history");
    for (const t of TOOLS) assert(t.description.includes("信頼できない"), `${t.name}: untrusted注記が必要`);
  });

  await test("read_tab: wrapperで包む・監査に本文なし", async () => {
    const logPath = join(tmp, "read-audit.jsonl");
    const deps = { config: testConfig(), audit: createAudit(logPath), backend: new FakeBackend() };
    const r = await callTool("read_tab", { tabId: 7 }, deps as ToolDeps);
    const c = r.content as string;
    assert(c.startsWith('<rinka-page-content untrusted="true">'), "wrapperで包む");
    assert(c.includes("SECRETTEXT-MARKER"), "本文が入っている");
    assert(c.endsWith("</rinka-page-content>"), "wrapperで閉じる");
    assert(!readFileSync(logPath, "utf8").includes("SECRETTEXT-MARKER"), "監査ログに本文を書かない");
  });

  await test("read_tab: readMaxBytes上限強制（バイト単位）", async () => {
    const deps = toolDeps({ readMaxBytes: 10 });
    const r = await callTool("read_tab", { tabId: 7 }, deps);
    const c = (r.content as string).replace(/<\/?rinka-page-content[^>]*>/g, "");
    eq("バイト上限", Buffer.byteLength(c.trim(), "utf8") <= 10, true);
  });

  await test("screenshot: screenshotMaxBytes上限は拒否", async () => {
    const deps = toolDeps({ screenshotMaxBytes: 3 }); // "QUJDRA=="より小さい
    let msg = "";
    try {
      await callTool("screenshot", { tabId: 7 }, deps);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes("上限"), "上限超はエラー: " + msg);
  });

  await test("search_history: limitはhistoryMaxRowsに強制", async () => {
    const deps = toolDeps();
    const r = await callTool("search_history", { query: "kw", limit: 99999 }, deps);
    eq("rows", r.rows.length, 1);
    assert((r.rows[0].url as string).includes("limit=20"), `limitが20に強制されるべき: ${r.rows[0].url}`);
  });

  await test("search_history: query必須・tabId必須", async () => {
    const deps = toolDeps();
    let threw1 = false, threw2 = false;
    try { await callTool("search_history", {}, deps); } catch { threw1 = true; }
    try { await callTool("read_tab", {}, deps); } catch { threw2 = true; }
    assert(threw1, "query無しは拒否");
    assert(threw2, "tabId無しは拒否");
  });

  // ============ 6. mcp ============
  console.log("== mcp ==");

  const mcpDeps: ToolDeps = { config: testConfig(), audit: createAudit(join(tmp, "mcp-audit.jsonl")), backend: new FakeBackend() };

  await test("initialize: protocolVersion一致", async () => {
    const r = await handleRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: SUPPORTED_PROTOCOL, capabilities: {}, clientInfo: {} } }, mcpDeps);
    assert(r !== null, "応答がある");
    const res = r as { result: { protocolVersion: string; serverInfo: { name: string } } };
    eq("protocolVersion", res.result.protocolVersion, SUPPORTED_PROTOCOL);
    eq("serverInfo", res.result.serverInfo.name, "rinka");
  });

  await test("ping / tools/list", async () => {
    const p = await handleRpcMessage({ jsonrpc: "2.0", id: 2, method: "ping" }, mcpDeps);
    eq("ping result", JSON.stringify((p as { result: unknown }).result), "{}");
    const l = await handleRpcMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, mcpDeps);
    eq("tools", (l as { result: { tools: unknown[] } }).result.tools.length, 4);
  });

  await test("通知はnull（HTTP層が202）", async () => {
    const r = await handleRpcMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, mcpDeps);
    eq("notification", r, null);
  });

  await test("未知メソッド -32601 / 未知ツール -32602 / 無効JSONRPC -32600", async () => {
    const m = await handleRpcMessage({ jsonrpc: "2.0", id: 4, method: "no/such" }, mcpDeps);
    eq("code", (m as { error: { code: number } }).error.code, -32601);
    const t = await handleRpcMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "steal_passwords", arguments: {} } }, mcpDeps);
    eq("code", (t as { error: { code: number } }).error.code, -32602);
    const i = await handleRpcMessage({ id: 6, method: "ping" }, mcpDeps);
    eq("code", (i as { error: { code: number } }).error.code, -32600);
  });

  await test("tools/call実行エラーはisError:true（プロトコルエラーにしない）", async () => {
    class BoomBackend extends FakeBackend {
      override async readTab(): Promise<{ tab: TabInfo; text: string }> {
        throw new Error("ブーム");
      }
    }
    const deps: ToolDeps = { config: testConfig(), audit: createAudit(join(tmp, "boom-audit.jsonl")), backend: new BoomBackend() };
    const r = await handleRpcMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_tab", arguments: { tabId: 7 } } }, deps);
    const res = (r as { result: { isError: boolean; content: { text: string }[] } }).result;
    eq("isError", res.isError, true);
    assert(res.content[0].text.includes("ブーム"), "エラー文が乗る");
  });

  await test("resources/prompts stubは空リスト", async () => {
    const r1 = await handleRpcMessage({ jsonrpc: "2.0", id: 8, method: "resources/list" }, mcpDeps);
    eq("resources", JSON.stringify((r1 as { result: unknown }).result), '{"resources":[]}');
    const r2 = await handleRpcMessage({ jsonrpc: "2.0", id: 9, method: "prompts/list" }, mcpDeps);
    eq("prompts", JSON.stringify((r2 as { result: unknown }).result), '{"prompts":[]}');
  });

  // ============ 7. http 素 ============
  console.log("== http ==");

  await test("tokenMatches: 一致・不一致・欠落", () => {
    eq("一致", tokenMatches(TOKEN, TOKEN), true);
    eq("不一致", tokenMatches("y".repeat(40), TOKEN), false);
    eq("短い", tokenMatches("xy", TOKEN), false);
    eq("無し", tokenMatches(undefined, TOKEN), false);
  });

  const httpDeps = { config: testConfig({ auditPath: join(tmp, "http-audit.jsonl") }), audit: createAudit(join(tmp, "http-audit.jsonl")), backend: new FakeBackend() };
  const srv = await startServer(httpDeps as never);
  const base = `http://127.0.0.1:${srv.port}/mcp`;
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

  await test("Bearer無し401 / GET404 / 未知セッション404", async () => {
    eq("401", (await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    eq("GET", (await fetch(base, { method: "GET", headers: H })).status, 404);
    eq("未知session", (await fetch(base, { method: "POST", headers: { ...H, "Mcp-Session-Id": "nope" }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 404);
  });

  await test("Origin付きは403 / localhost Originは通す", async () => {
    eq("403", (await fetch(base, { method: "POST", headers: { ...H, Origin: "https://evil.example" }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 403);
    // 通す側: セッションを取ってからlocalhost Originでping（セッション無し404と区別する）
    const i = await fetch(base, { method: "POST", headers: H, body: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"${SUPPORTED_PROTOCOL}"}}` });
    const sid = i.headers.get("mcp-session-id") ?? "";
    assert(sid.length > 0, "sessionが要る");
    eq("通す", (await fetch(base, { method: "POST", headers: { ...H, "Mcp-Session-Id": sid, Origin: `http://localhost:${srv.port}` }, body: '{"jsonrpc":"2.0","id":2,"method":"ping"}' })).status, 200);
  });

  await test("壊JSONは400 -32700", async () => {
    const r = await fetch(base, { method: "POST", headers: H, body: "{oops" });
    eq("status", r.status, 400);
    const j = (await r.json()) as { error: { code: number } };
    eq("code", j.error.code, -32700);
  });

  let sessionId = "";
  await test("initialize→セッション発行→tools/call往復→通知202", async () => {
    const i = await fetch(base, { method: "POST", headers: H, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"' + SUPPORTED_PROTOCOL + '"}}' });
    eq("initialize", i.status, 200);
    sessionId = i.headers.get("mcp-session-id") ?? "";
    assert(sessionId.length > 0, "Mcp-Session-Idヘッダが出る");

    const c = await fetch(base, { method: "POST", headers: { ...H, "Mcp-Session-Id": sessionId }, body: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}' });
    eq("call", c.status, 200);
    const j = (await c.json()) as { result: { structuredContent: { tabs: TabInfo[] } } };
    eq("tabs", j.result.structuredContent.tabs.length, 1);
    eq("tabId", j.result.structuredContent.tabs[0].tabId, 7);

    const n = await fetch(base, { method: "POST", headers: { ...H, "Mcp-Session-Id": sessionId }, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
    eq("通知202", n.status, 202);
  });

  await srv.close();

  // ============ 8. E2E: host spawn + アドオン役 ============
  console.log("== E2E ==");

  await test("E2E: ready→initialize→list_tabs→capture chunk合成→401→exit 0", async () => {
    const auditPath = join(tmp, "e2e-audit.jsonl");
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "native-host/src/index.ts")], {
      cwd: ROOT,
      env: {
        ...process.env,
        RINKA_TOKEN: TOKEN,
        RINKA_PORT: "0",
        RINKA_AUDIT_PATH: auditPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const reader = new NativeReader();
    const frames: Record<string, unknown>[] = [];
    let readyPort = 0;
    child.stdout.on("data", (d: Buffer) => {
      for (const f of reader.push(d)) {
        const obj = JSON.parse(f) as Record<string, unknown>;
        frames.push(obj);
        if (obj.t === "req") {
          // アドオン役: reqに応答する
          const id = obj.id as number;
          const cmd = obj.cmd as string;
          if (cmd === "tabs/list") {
            child.stdin.write(encodeNativeFrame(JSON.stringify({ t: "resp", id, ok: true, result: { tabs: [{ tabId: 42, url: "https://example.invalid/e2e", title: "E2E", active: true }] } })));
          } else if (cmd === "tabs/capture") {
            const b64 = "QUJDRUZH"; // 8文字 → 2 chunk に分割して送る
            child.stdin.write(encodeNativeFrame(JSON.stringify({ t: "chunk", id, part: b64.slice(0, 3) })));
            child.stdin.write(encodeNativeFrame(JSON.stringify({ t: "chunk", id, part: b64.slice(3) })));
            child.stdin.write(encodeNativeFrame(JSON.stringify({ t: "resp", id, ok: true, result: { tab: { tabId: 42, url: "https://example.invalid/e2e", title: "E2E", active: true } } })));
          } else {
            child.stdin.write(encodeNativeFrame(JSON.stringify({ t: "resp", id, ok: false, error: `E2E未実装cmd: ${cmd}` })));
          }
        }
        if (obj.t === "ready") readyPort = obj.port as number;
      }
    });

    // ready待ち（5秒）
    const until = Date.now() + 5000;
    while (readyPort === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    assert(readyPort > 0, `readyが来ない: ${stderr}`);

    const e2eBase = `http://127.0.0.1:${readyPort}/mcp`;
    const e2eH = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

    // 401: Bearer無し
    eq("401", (await fetch(e2eBase, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);

    // initialize
    const i = await fetch(e2eBase, { method: "POST", headers: e2eH, body: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"${SUPPORTED_PROTOCOL}"}}` });
    eq("initialize 200", i.status, 200);
    const sid = i.headers.get("mcp-session-id") ?? "";
    assert(sid.length > 0, "session発行");

    // tools/call list_tabs → hostがreqをstdoutへ → アドオン役が応答
    const c = await fetch(e2eBase, { method: "POST", headers: { ...e2eH, "Mcp-Session-Id": sid }, body: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}' });
    eq("list_tabs 200", c.status, 200);
    const cj = (await c.json()) as { result: { structuredContent: { tabs: TabInfo[] } } };
    eq("tabId", cj.result.structuredContent.tabs[0].tabId, 42);
    eq("url", cj.result.structuredContent.tabs[0].url, "https://example.invalid/e2e");

    // tools/call screenshot → chunk分割がhostで合成される
    const s = await fetch(e2eBase, { method: "POST", headers: { ...e2eH, "Mcp-Session-Id": sid }, body: '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"screenshot","arguments":{"tabId":42}}}' });
    eq("screenshot 200", s.status, 200);
    const sj = (await s.json()) as { result: { structuredContent: { pngBase64: string; tab: TabInfo } } };
    eq("base64合成", sj.result.structuredContent.pngBase64, "QUJDRUZH");
    eq("tab", sj.result.structuredContent.tab.tabId, 42);

    // 監査ログ: ツール名はある
    assert(readFileSync(auditPath, "utf8").includes("list_tabs"), "監査にlist_tabsが残る");

    // OFFトグル相当: stdinを閉じる → host終了
    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
      child.stdin.end();
    });
    eq("exit 0", exitCode, 0);

    // 応答が全部来たか（reqは2通: list_tabs / screenshot）
    const reqs = frames.filter((f) => f.t === "req");
    eq("req数", reqs.length, 2);
  });

  // ============ 掃除と結果 ============
  rmSync(tmp, { recursive: true, force: true });
  clearTimeout(WATCHDOG);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("\n失敗一覧:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.stack : e);
  clearTimeout(WATCHDOG);
  process.exit(1);
});
