/**
 * rinka native-host/src/http.ts — HTTP素。POST /mcp のみ。
 *
 * - Bearer トークン必須（定数時間比較）。不一致は401（tokenMatchesをexportしてテストも見る）
 * - Origin 絡みの防御: Originヘッダが付いていて localhost 系でなければ403
 *   （ブラウザ以外のMCPクライアントは通常Originを送らない）
 * - セッション: initialize でのみ発行（Mcp-Session-Idヘッダ）、以後必須・不明なら404
 * - ボディ上限 1MB、超過は413
 * - JSONパース失敗は -32700 を 400 で返す
 * - 通知（応答null）は 202
 */

import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { handleRpcMessage } from "./mcp.ts";
import type { ToolDeps } from "./tools.ts";
import type { Config } from "./config.ts";
import type { Backend } from "./types.ts";
import type { Audit } from "./audit.ts";

export interface HttpDeps {
  config: Config;
  audit: Audit;
  backend: Backend;
}

const BODY_MAX = 1024 * 1024;
const LOCAL_ORIGIN = /^https?:\\/\\/(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?$/i;

/** 定数時間比較（長さが違っても速攻で抜けないよう、自身と比較してタイミングを均す）。 */
export function tokenMatches(received: string | undefined, expected: string): boolean {
  if (typeof received !== "string" || received.length === 0) return false;
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a); // 長さ比較のタイミングを潰す
    return false;
  }
  return timingSafeEqual(a, b);
}

function readBearer(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return undefined;
  return h.slice("Bearer ".length).trim();
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const json = body === null || body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(json);
}

export interface RunningServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startServer(deps: HttpDeps): Promise<RunningServer> {
  const { config } = deps;
  const toolDeps: ToolDeps = { config, audit: deps.audit, backend: deps.backend };
  const sessions = new Set<string>();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        // ---- 素の絞り: POST /mcp のみ ----
        if (req.method !== "POST" || req.url !== "/mcp") {
          send(res, 404, { error: "rinka: POST /mcp のみ受け付けます" });
          return;
        }

        // ---- Origin 防御（DNS rebinding向け） ----
        const origin = req.headers.origin;
        if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) {
          send(res, 403, { error: "rinka: 許可しない Origin です" });
          return;
        }

        // ---- 鍵一つ: Bearer ----
        if (!tokenMatches(readBearer(req), config.token)) {
          send(res, 401, { error: "rinka: Bearer トークンが不正です" });
          return;
        }

        // ---- ボディ受信（上限1MB） ----
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > BODY_MAX) {
            send(res, 413, { error: "rinka: リクエストが大きすぎます" });
            return;
          }
          chunks.push(c as Buffer);
        }
        const text = Buffer.concat(chunks).toString("utf8");

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "rinka: JSONパース失敗（Parse error）" } });
          return;
        }

        // ---- セッション ----
        const sessionId = Array.isArray(req.headers["mcp-session-id"]) ? req.headers["mcp-session-id"][0] : req.headers["mcp-session-id"];
        const isInitialize =
          typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).method === "initialize";
        let extra: Record<string, string> | undefined;
        if (isInitialize) {
          const sid = crypto.randomUUID();
          sessions.add(sid);
          extra = { "Mcp-Session-Id": sid };
        } else {
          if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
            send(res, 404, { error: "rinka: 未知のセッションです（先に initialize してください）" });
            return;
          }
        }

        // ---- 応答 ----
        const response = await handleRpcMessage(parsed, toolDeps);
        if (response === null) {
          send(res, 202, null, extra);
          return;
        }
        send(res, 200, response, extra);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!res.headersSent) {
          send(res, 500, { error: `rinka: 内部エラー: ${message}` });
        } else {
          res.end();
        }
      }
    })();
  });

  return await new Promise<RunningServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("rinka: listen アドレスが不明です"));
        return;
      }
      const port = addr.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((r) => {
            // keep-aliveの残泥を落としてからclose（closeだけだと接続が残り終了が遅れる）
            try {
              server.closeAllConnections();
            } catch {
              /* Node 18.2未満では無い */
            }
            server.close(() => r());
          }),
      });
    });
  });
}
