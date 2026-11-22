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
 */

import { TOOLS, callTool, isKnownTool } from "./tools.ts";
import type { ToolDeps } from "./tools.ts";

export const SUPPORTED_PROTOCOL = "2025-06-18";
export const SERVER_INFO = { name: "rinka", version: "0.2.0" };

type RpcError = { code: number; message: string };
type RpcResponse =
  | { jsonrpc: "2.0"; id: unknown; result: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: unknown; error: RpcError };

function ok(id: unknown, result: Record<string, unknown>): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(id: unknown, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const JSONRPC_ERRORS = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
} as const;

export async function handleRpcMessage(raw: unknown, deps: ToolDeps): Promise<RpcResponse | null> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(null, JSONRPC_ERRORS.INVALID_REQUEST, "rinka: リクエストはJSONオブジェクトである必要があります");
  }
  const msg = raw as Record<string, unknown>;

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
      const p = (params ?? {}) as Record<string, unknown>;
      const name = typeof p.name === "string" ? p.name : "";
      if (!isKnownTool(name)) {
        return err(id, JSONRPC_ERRORS.INVALID_PARAMS, `rinka: 未知のツールです: ${name || "(なし)"}`);
      }
      try {
        const toolArgs = typeof p.arguments === "object" && p.arguments !== null ? p.arguments : {};
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
}
