/**
 * rinka native-host/src/http.ts — HTTP素。POST /mcp のみ。
 *
 * - Bearer トークン必須（定数時間比較）。不一致は401（tokenMatchesをexportしてテストも見る）
 * - Origin 絡みの防御: Originヘッダは localhost 系と chat/vibe.mistral.ai
 *   （Vibe Work のコネクタ接続ダイアログの発信Origin）のみ許可。他は403
 *   （ブラウザ以外のMCPクライアントは通常Originを送らない。Originはブラウザしか
 *   付けられず偽装不可なので、認証は変わらずBearer鍵一つ）
 * - セッションレス: state はこのプロセス内に持たない（鍵はBearer一つで十分・保守点減）
 * - ボディ上限 1MB、超過は413
 * - JSONパース失敗は -32700 を 400 で返す
 * - 通知（応答null）は 202
 * - 構文規約: as断言不使用（data chunk は明示的 Buffer 注釈で受ける）・
 *   closeAllConnections は try/空catch でなく関数型検査で呼ぶ。
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { handleRpcMessage } from "./mcp.ts";
import type { ToolDeps } from "./tools.ts";
import type { Config } from "./config.ts";
import type { Backend } from "./types.ts";
import type { Audit } from "./audit.ts";

export type HttpDeps = {
  config: Config;
  audit: Audit;
  backend: Backend;
  /** マクロ予算の経過時計（index.ts から注入）。 */
  now: () => number;
};

const BODY_MAX = 1024 * 1024;
/** Origin許可リスト: localhost系（ローカルの開発用ページ）と Mistral の公式UI
 *  （Vibe Work のConnectダイアログはブラウザ側fetchでOriginを付けて検証する）。
 *  https固定・port無し。それ以外にOriginを付けて来る相手は403。 */
const ALLOWED_ORIGINS: readonly RegExp[] = [
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i,
  /^https:\/\/(chat|vibe)\.mistral\.ai$/i,
];
const originAllowed = (origin: string): boolean => ALLOWED_ORIGINS.some((re) => re.test(origin));

/** 定数時間比較（長さが違っても速攻で抜けないよう、自身と比較してタイミングを均す）。 */
export const tokenMatches = (received: string | undefined, expected: string): boolean => {
  if (typeof received !== "string" || received.length === 0) return false;
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a); // 長さ比較のタイミングを潰す
    return false;
  }
  return timingSafeEqual(a, b);
};

const readBearer = (req: { headers: Record<string, string | string[] | undefined> }): string | undefined => {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return undefined;
  return h.slice("Bearer ".length).trim();
};

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const json = body === null || body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(json);
};

export type RunningServer = {
  server: Server;
  port: number;
  close: () => Promise<void>;
};

/** ボディを受けて1MB超なら null（呼び出し側が413）。chunk は Buffer として明示的に受ける。 */
const readBody = (req: IncomingMessage): Promise<Buffer | null> =>
  new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_MAX) {
        resolve(null); // 上限超。以後のchunkは読み捨て（応答は呼び出し側で413）
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

export const startServer = async (deps: HttpDeps): Promise<RunningServer> => {
  const { config } = deps;
  const toolDeps: ToolDeps = { config, audit: deps.audit, backend: deps.backend, now: deps.now };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        // ---- 素の絞り: POST /mcp のみ ----
        if (req.method !== "POST" || req.url !== "/mcp") {
          send(res, 404, { error: "rinka: POST /mcp のみ受け付けます" });
          return;
        }

        // ---- Origin 防御（DNS rebinding向け。許可リスト外は403） ----
        const origin = req.headers.origin;
        if (origin !== undefined && !originAllowed(origin)) {
          send(res, 403, { error: "rinka: 許可しない Origin です" });
          return;
        }

        // ---- 鍵一つ: Bearer ----
        if (!tokenMatches(readBearer(req), config.token)) {
          send(res, 401, { error: "rinka: Bearer トークンが不正です" });
          return;
        }

        // ---- ボディ受信（上限1MB） ----
        const body = await readBody(req);
        if (body === null) {
          send(res, 413, { error: "rinka: リクエストが大きすぎます" });
          return;
        }
        const text = body.toString("utf8");

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "rinka: JSONパース失敗（Parse error）" } });
          return;
        }

        // ---- 応答（セッションレス。応答null=通知は202） ----
        const response = await handleRpcMessage(parsed, toolDeps);
        send(res, response === null ? 202 : 200, response);
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
            // keep-aliveの残泥を落としてからclose（closeだけだと接続が残り終了が遅れる）。
            // Node 18.2未満には closeAllConnections が無いので関数型検査で守る（空catch不使用）。
            if (typeof server.closeAllConnections === "function") server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
};
