/**
 * rinka native-host/src/audit.ts — 監査ログ（家規5: 本文を記録しない）。
 *
 * - 1件 = 1行 JSONL。tool名と安全な引数のみ。ページ本文・screenshot・検索結果は書かない。
 * - 512件に達したら path → path.1 へローテーション（世代1つ、肥大化防止）。
 * - 0600 で作成。監査ログの失敗で本体を止めない（書込エラーは握り潰す）。
 * - 安全な引数の記録は呼び出し側（tools.ts）が whitelisted args を渡す方針:
 *   ここでは更に防衛的に、文字列は200字で頭を切る。
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const ROTATE_LINES = 512;

function safeValue(v: unknown): unknown {
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return v;
  if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) + "…" : v;
  return undefined; // オブジェクト・配列・その他は記録しない
}

export interface Audit {
  record(tool: string, args: Record<string, unknown>): void;
}

export function createAudit(path: string): Audit {
  let lines = 0;
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      appendFileSync(path, "", { mode: 0o600 });
      chmodSync(path, 0o600);
    }
  } catch {
    // 監査ログ初期化失敗でも本体は止めない
  }

  return {
    record(tool: string, args: Record<string, unknown>) {
      try {
        if (lines >= ROTATE_LINES) {
          renameSync(path, path + ".1");
          lines = 0;
        }
        const safe: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) {
          const sv = safeValue(v);
          if (sv !== undefined || v === null) safe[k] = sv;
        }
        appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), tool, args: safe }) + "\n");
        lines++;
      } catch {
        // 握り潰す（家規: 監査は副次系）
      }
    },
  };
}
