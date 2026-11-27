/**
 * rinka native-host/src/mcp.ts — MCP (Streamable HTTP) の JSON-RPC 面。
 * HTTP の素 (http.ts) と分離。ここは純粋に「1メッセージ → 1応答オブジェクト or null」。
 *
 * - initialize / ping / tools/list / tools/call
 * - resources・prompts は未サポート（能力は initialize で tools のみ表明。
 *   呼ばれても -32601。空stubは返さない）
 * - 通知（id無し）は null（HTTP層が202を返す）
 * - エラー: -32600 (無効リクエスト) / -32601 (メソッドなし) / -32602 (引数不正)
 *   パース失敗 -32700 はJSON.parseを扱うhttp.ts側。
 * - ツール実行エラーは MCP 規約どおり result.isError:true（プロトコルエラーにしない）。
 * - 構文規約: as断言不使用（raw/params は形状ガードで絞る・as const も使わず型で固定）。
 */

import { TOOLS, callTool, isKnownTool } from "./tools.ts";
import type { ToolDeps } from "./tools.ts";
import { isRecord } from "./types.ts";

export const SUPPORTED_PROTOCOL = "2025-06-18";
export const SERVER_INFO = { name: "rinka", version: "0.3.0" }; // v3: run_macro 追加（tools/list 15本）

export type RpcOk = { jsonrpc: "2.0"; id: unknown; result: Record<string, unknown> };
export type RpcErr = { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };
export type RpcResponse = RpcOk | RpcErr;

/** 応答が result を持つ方か（テストもこれで絞って中身を見る。as断言不要にするため公開）。 */
export const isRpcOk = (r: RpcResponse | null): r is RpcOk => r !== null && "result" in r;
/** 応答が error を持つ方か。 */
export const isRpcErr = (r: RpcResponse | null): r is RpcErr => r !== null && "error" in r;

type JsonRpcErrorCode = -32600 | -32601 | -32602;
const JSONRPC_ERRORS: { INVALID_REQUEST: JsonRpcErrorCode; METHOD_NOT_FOUND: JsonRpcErrorCode; INVALID_PARAMS: JsonRpcErrorCode } = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
};

const ok = (id: unknown, result: Record<string, unknown>): RpcResponse => {
  return { jsonrpc: "2.0", id, result };
};
const err = (id: unknown, code: number, message: string): RpcResponse => {
  return { jsonrpc: "2.0", id, error: { code, message } };
};

export const handleRpcMessage = async (raw: unknown, deps: ToolDeps): Promise<RpcResponse | null> => {
  if (!isRecord(raw)) {
    return err(null, JSONRPC_ERRORS.INVALID_REQUEST, "rinka: リクエストはJSONオブジェクトである必要があります");
  }
  const msg = raw;

  const id = Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : undefined;
  const isNotification = id === undefined || id === null;
  const method = msg.method;
  const params = msg.params;

  if (msg.jsonrpc !== "2.0" || typeof method !== "string") {
    return err(id ?? null, JSONRPC_ERRORS.INVALID_REQUEST, 'rinka: jsonrpc:"2.0" と method は必須です');
  }

  // ---- 通知: 応答しない（HTTP 202） ----
  if (isNotification) {
    return null;
  }

  // ---- メソッド群 ----
  try {
    if (method === "initialize") {
      return ok(id, {
        protocolVersion: SUPPORTED_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }

    if (method === "ping") {
      return ok(id, {});
    }

    if (method === "tools/list") {
      return ok(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }

    if (method === "tools/call") {
      const p = isRecord(params) ? params : {};
      const name = typeof p.name === "string" ? p.name : "";
      if (!isKnownTool(name)) {
        return err(id, JSONRPC_ERRORS.INVALID_PARAMS, `rinka: 未知のツールです: ${name || "(なし)"}`);
      }
      try {
        const toolArgs = isRecord(p.arguments) ? p.arguments : {};
        const result = await callTool(name, toolArgs, deps);
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return ok(id, {
          content: [{ type: "text", text: `rinka tool error: ${message}` }],
          isError: true,
        });
      }
    }

    return err(id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `rinka: サポートしないメソッドです: ${method}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(id, -32603, `rinka: 内部エラー: ${message}`);
  }
};
