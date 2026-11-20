/**
 * rinka — test/run-tests.ts 全量テスト（node:test + node:assert。ハーネス自作なし・依存ゼロ）。
 *
 * 実行: node --experimental-strip-types --no-warnings test/run-tests.ts
 * 成功失敗は終了コードに出る（失敗で非0）。ハングはper-testタイムアウトと
 * 実行側の `timeout` ラップで落とす（240秒を目安に）。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeNativeFrame, NativeReader, NATIVE_FRAME_MAX } from "../native-host/src/native.ts";
import { AddonBackend, BACKEND_CALL_TIMEOUT_MS } from "../native-host/src/backend.ts";
import { validateEnvironment, loadToken } from "../native-host/src/config.ts";
import { createAudit } from "../native-host/src/audit.ts";
import { TOOLS, callTool } from "../native-host/src/tools.ts";
import { handleRpcMessage, SUPPORTED_PROTOCOL } from "../native-host/src/mcp.ts";
import { startServer, tokenMatches, type RunningServer } from "../native-host/src/http.ts";
import type { Backend, TabInfo, HistoryRow } from "../native-host/src/types.ts";
import type { Config } from "../native-host/src/config.ts";
import type { ToolDeps } from "../native-host/src/tools.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "rinka-test-"));
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

// ============ 1. Native Messaging framing ============

test("framing: encode/decode 往復", () => {
  const frame = encodeNativeFrame('{"t":"ready","port":8765}');
  const out = new NativeReader().push(frame);
  assert.equal(out.length, 1);
  assert.equal(out[0], '{"t":"ready","port":8765}');
});

test("framing: 分割受信", () => {
  const frame = encodeNativeFrame(JSON.stringify({ hello: "world" }));
  const r = new NativeReader();
  assert.equal(r.push(frame.subarray(0, 3)).length, 0, "前半では未完成");
  const b = r.push(frame.subarray(3));
  assert.equal(b.length, 1, "後半で完成");
  assert.equal(JSON.parse(b[0]).hello, "world");
});

test("framing: 連続フレーム", () => {
  const r = new NativeReader();
  const out = r.push(Buffer.concat([encodeNativeFrame("1"), encodeNativeFrame("2"), encodeNativeFrame("3")]));
  assert.equal(out.join(","), "1,2,3");
});

test("framing: 32MB超フレーム拒否", () => {
  const r = new NativeReader();
  const head = Buffer.alloc(4);
  head.writeUInt32LE(NATIVE_FRAME_MAX + 1, 0);
  assert.throws(() => r.push(head), "NATIVE_FRAME_MAX超でthrowすべき");
});

// ============ 2. AddonBackend ============

test("backend: captureはresp1通でbase64を受け取る（chunkなし）", async () => {
  const sent: Record<string, unknown>[] = [];
  const b = new AddonBackend((o) => sent.push(o));
  const p = b.screenshot(7);
  assert.equal(sent[0].cmd, "tabs/capture");
  const id = sent[0].id as number;
  b.onMessage({ t: "resp", id, ok: true, result: { tab: { tabId: 7 }, base64: "QUJDRUZH" } });
  const r = await p;
  assert.equal(r.base64, "QUJDRUZH");
  assert.equal(r.tab.tabId, 7);
});

test("backend: respエラーはreject", async () => {
  const b = new AddonBackend(() => {});
  const p = b.readTab(7);
  p.catch(() => {}); // unhandled回避
  b.onMessage({ t: "resp", id: 1, ok: false, error: "タブがない" });
  await assert.rejects(p, /タブがない/, "エラー文が伝わるべき");
});

test("backend: listTabsはtabs配列検査（fail-closed）", async () => {
  const b = new AddonBackend(() => {});
  const p = b.listTabs();
  p.catch(() => {});
  b.onMessage({ t: "resp", id: 1, ok: true, result: {} }); // tabs無し
  await assert.rejects(p, "tabsが無ければfail-closed");
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

test("audit: 本文を書かない・引数は書く", () => {
  const logPath = join(tmp, "audit-test.jsonl");
  const audit = createAudit(logPath);
  audit.record("read_tab", { tabId: 7 });
  audit.record("search_history", { query: "keyword", limit: 20 });
  const text = readFileSync(logPath, "utf8");
  assert.ok(!text.includes("SECRETTEXT-MARKER"), "本文マーカーが監査ログに漏れた");
  assert.ok(text.includes("read_tab") && text.includes("tabId"), "引数は記録されるべき");
  assert.ok(text.includes("keyword"), "検索語は記録されるべき");
});

test("audit: ローテーション 64KB超で path.1 へ（再起動を跨ぐサイズ方式）", () => {
  const logPath = join(tmp, "audit-rot.jsonl");
  const audit = createAudit(logPath);
  const big = "k".repeat(120);
  for (let i = 0; i < 700; i++) audit.record("search_history", { query: big, limit: 20 });
  assert.ok(existsSync(logPath + ".1"), "旧ログが .1 に退避すべき");
});

// ============ 5. tools (FakeBackend) ============

function toolDeps(cfg: Partial<Config> = {}): ToolDeps {
  return { config: testConfig(cfg), audit: createAudit(join(tmp, "tools-audit.jsonl")), backend: new FakeBackend() };
}

test("tools: 4ツール定義", () => {
  assert.equal(TOOLS.length, 4);
  assert.deepEqual(TOOLS.map((t) => t.name), ["list_tabs", "read_tab", "screenshot", "search_history"]);
  for (const t of TOOLS) assert.ok(t.description.includes("信頼できない"), `${t.name}: untrusted注記が必要`);
});

test("tools: read_tab wrapperで包む・監査に本文なし", async () => {
  const logPath = join(tmp, "read-audit.jsonl");
  const deps = { config: testConfig(), audit: createAudit(logPath), backend: new FakeBackend() };
  const r = await callTool("read_tab", { tabId: 7 }, deps as ToolDeps);
  const c = r.content as string;
  assert.ok(c.startsWith('<rinka-page-content untrusted="true">'), "wrapperで包む");
  assert.ok(c.includes("SECRETTEXT-MARKER"), "本文が入っている");
  assert.ok(c.endsWith("</rinka-page-content>"), "wrapperで閉じる");
  assert.ok(!readFileSync(logPath, "utf8").includes("SECRETTEXT-MARKER"), "監査ログに本文を書かない");
});

test("tools: read_tab readMaxBytes上限強制（バイト単位・UTF-8境界）", async () => {
  // CJK交じり（「本文」は3byte/字）で上限10byte: きっちり10byteに切り、壊れ尾はU+FFFDを捨てる
  const deps = toolDeps({ readMaxBytes: 10 });
  const r = await callTool("read_tab", { tabId: 7 }, deps);
  const c = (r.content as string).replace(/<\/?rinka-page-content[^>]*>/g, "").trim();
  assert.ok(Buffer.byteLength(c, "utf8") <= 10, `バイト上限内: ${Buffer.byteLength(c, "utf8")}`);
  assert.ok(!c.endsWith("�"), "末尾の壊れたUTF-8は捨てる");
});

test("tools: screenshot screenshotMaxBytes上限は拒否", async () => {
  const deps = toolDeps({ screenshotMaxBytes: 3 }); // "QUJDRA=="より小さい
  await assert.rejects(callTool("screenshot", { tabId: 7 }, deps), /上限/, "上限超はエラー");
});

test("tools: search_history limitはhistoryMaxRowsに強制", async () => {
  const deps = toolDeps();
  const r = await callTool("search_history", { query: "kw", limit: 99999 }, deps);
  assert.equal(r.rows.length, 1);
  assert.ok((r.rows[0].url as string).includes("limit=20"), "limitが20に強制されるべき");
});

test("tools: query必須・tabId必須", async () => {
  const deps = toolDeps();
  await assert.rejects(callTool("search_history", {}, deps), "query無しは拒否");
  await assert.rejects(callTool("read_tab", {}, deps), "tabId無しは拒否");
});

// ============ 6. mcp ============

const mcpDeps: ToolDeps = { config: testConfig(), audit: createAudit(join(tmp, "mcp-audit.jsonl")), backend: new FakeBackend() };

test("mcp: initialize protocolVersion一致", async () => {
  const r = await handleRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: SUPPORTED_PROTOCOL, capabilities: {}, clientInfo: {} } }, mcpDeps);
  assert.ok(r !== null, "応答がある");
  const res = r as { result: { protocolVersion: string; serverInfo: { name: string } } };
  assert.equal(res.result.protocolVersion, SUPPORTED_PROTOCOL);
  assert.equal(res.result.serverInfo.name, "rinka");
});

test("mcp: ping / tools/list", async () => {
  const p = await handleRpcMessage({ jsonrpc: "2.0", id: 2, method: "ping" }, mcpDeps);
  assert.deepEqual((p as { result: unknown }).result, {});
  const l = await handleRpcMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, mcpDeps);
  assert.equal((l as { result: { tools: unknown[] } }).result.tools.length, 4);
});

test("mcp: 通知はnull（HTTP層が202）", async () => {
  const r = await handleRpcMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, mcpDeps);
  assert.equal(r, null);
});

test("mcp: 未知メソッド -32601 / 未知ツール -32602 / 無効JSONRPC -32600", async () => {
  const m = await handleRpcMessage({ jsonrpc: "2.0", id: 4, method: "no/such" }, mcpDeps);
  assert.equal((m as { error: { code: number } }).error.code, -32601);
  const t = await handleRpcMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "steal_passwords", arguments: {} } }, mcpDeps);
  assert.equal((t as { error: { code: number } }).error.code, -32602);
  const i = await handleRpcMessage({ id: 6, method: "ping" }, mcpDeps);
  assert.equal((i as { error: { code: number } }).error.code, -32600);
});

test("mcp: tools/call実行エラーはisError:true（プロトコルエラーにしない）", async () => {
  class BoomBackend extends FakeBackend {
    override async readTab(): Promise<{ tab: TabInfo; text: string }> {
      throw new Error("ブーム");
    }
  }
  const deps: ToolDeps = { config: testConfig(), audit: createAudit(join(tmp, "boom-audit.jsonl")), backend: new BoomBackend() };
  const r = await handleRpcMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_tab", arguments: { tabId: 7 } } }, deps);
  const res = (r as { result: { isError: boolean; content: { text: string }[] } }).result;
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes("ブーム"), "エラー文が乗る");
});

test("mcp: resources/prompts は未サポート（-32601・空stubは返さない）", async () => {
  const r1 = await handleRpcMessage({ jsonrpc: "2.0", id: 8, method: "resources/list" }, mcpDeps);
  assert.equal((r1 as { error: { code: number } }).error.code, -32601);
  const r2 = await handleRpcMessage({ jsonrpc: "2.0", id: 9, method: "prompts/list" }, mcpDeps);
  assert.equal((r2 as { error: { code: number } }).error.code, -32601);
});

// ============ 7. http 素（セッションレス） ============

const auditPathHttp = join(tmp, "http-audit.jsonl");
let srv!: RunningServer;
let base = "";
const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
const PING = '{"jsonrpc":"2.0","id":1,"method":"ping"}';

before(async () => {
  srv = await startServer({ config: testConfig({ auditPath: auditPathHttp }), audit: createAudit(auditPathHttp), backend: new FakeBackend() } as never);
  base = `http://127.0.0.1:${srv.port}/mcp`;
});

after(async () => {
  await srv.close();
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
  assert.equal((await fetch(base, { method: "POST", headers: { ...H, Origin: "https://evil.example" }, body: PING })).status, 403);
  assert.equal((await fetch(base, { method: "POST", headers: { ...H, Origin: `http://localhost:${srv.port}` }, body: PING })).status, 200);
});

test("http: 壊JSONは400 -32700", async () => {
  const r = await fetch(base, { method: "POST", headers: H, body: "{oops" });
  assert.equal(r.status, 400);
  const j = (await r.json()) as { error: { code: number } };
  assert.equal(j.error.code, -32700);
});

test("http: initialize→tools/call往復→通知202（セッションレス）", async () => {
  const i = await fetch(base, { method: "POST", headers: H, body: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"${SUPPORTED_PROTOCOL}"}}` });
  assert.equal(i.status, 200);
  assert.equal(i.headers.get("mcp-session-id"), null, "セッションは発行しない");

  const c = await fetch(base, { method: "POST", headers: H, body: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}' });
  assert.equal(c.status, 200);
  const j = (await c.json()) as { result: { structuredContent: { tabs: TabInfo[] } } };
  assert.equal(j.result.structuredContent.tabs.length, 1);
  assert.equal(j.result.structuredContent.tabs[0].tabId, 7);

  const n = await fetch(base, { method: "POST", headers: H, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
  assert.equal(n.status, 202);
});

// ============ 8. E2E: host spawn + アドオン役 ============

test("E2E: ready→401→initialize→list_tabs→screenshot単一resp→exit 0", { timeout: 30000 }, async () => {
  const e2eAudit = join(tmp, "e2e-audit.jsonl");
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "native-host/src/index.ts")], {
    cwd: ROOT,
    env: { ...process.env, RINKA_TOKEN: TOKEN, RINKA_PORT: "0", RINKA_AUDIT_PATH: e2eAudit },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

  const reader = new NativeReader();
  const frames: Record<string, unknown>[] = [];
  let readyPort = 0;
  const tab42 = { tabId: 42, url: "https://example.invalid/e2e", title: "E2E", active: true };
  child.stdout.on("data", (d: Buffer) => {
    for (const f of reader.push(d)) {
      const obj = JSON.parse(f) as Record<string, unknown>;
      frames.push(obj);
      if (obj.t === "req") {
        const id = obj.id as number;
        if (obj.cmd === "tabs/list") {
          child.stdin.write(encodeNativeFrame(JSON.stringify({ t: "resp", id, ok: true, result: { tabs: [tab42] } })));
        } else if (obj.cmd === "tabs/capture") {
          child.stdin.write(encodeNativeFrame(JSON.stringify({ t: "resp", id, ok: true, result: { tab: tab42, base64: "QUJDRUZH" } })));
        } else {
          child.stdin.write(encodeNativeFrame(JSON.stringify({ t: "resp", id, ok: false, error: `E2E未実装cmd: ${obj.cmd}` })));
        }
      }
      if (obj.t === "ready") readyPort = obj.port as number;
    }
  });

  // ready待ち（5秒）
  const until = Date.now() + 5000;
  while (readyPort === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
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
  const cj = (await c.json()) as { result: { structuredContent: { tabs: TabInfo[] } } };
  assert.equal(cj.result.structuredContent.tabs[0].tabId, 42);
  assert.equal(cj.result.structuredContent.tabs[0].url, "https://example.invalid/e2e");

  // tools/call screenshot → resp1通で受ける
  const s = await fetch(e2eBase, { method: "POST", headers: e2eH, body: '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"screenshot","arguments":{"tabId":42}}}' });
  assert.equal(s.status, 200);
  const sj = (await s.json()) as { result: { structuredContent: { pngBase64: string; tab: TabInfo } } };
  assert.equal(sj.result.structuredContent.pngBase64, "QUJDRUZH");
  assert.equal(sj.result.structuredContent.tab.tabId, 42);

  // 監査ログ: ツール名はある
  assert.ok(readFileSync(e2eAudit, "utf8").includes("list_tabs"), "監査にlist_tabsが残る");

  // OFFトグル相当: stdinを閉じる → host終了
  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
    child.stdin.end();
  });
  assert.equal(exitCode, 0);

  // 応答が全部来たか（reqは2通: list_tabs / screenshot）
  const reqs = frames.filter((f) => f.t === "req");
  assert.equal(reqs.length, 2);
});
