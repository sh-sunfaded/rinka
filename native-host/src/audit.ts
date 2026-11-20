/**
 * rinka native-host/src/audit.ts — 監査ログ（家規5: 本文を記録しない）。
 *
 * - 1件 = 1行 JSONL。tool名と安全な引数のみ。ページ本文・screenshot・検索結果は書かない。
 * - ファイルが64KBに達したら path → path.1 へローテーション（世代1つ、肥大化防止）。
 *   サイズ確認は毎回 stat で行う（行数カウンタと違い、プロセス再起動を跨いでも正しい）。
 * - 0600 で作成。監査ログの失敗で本体を止めない（書込エラーは握り潰す）。
 * - 文字列は200字で頭を切る。呼び出し側（tools.ts）が安全な引数のみ渡すのが第一防衛。
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const ROTATE_BYTES = 64 * 1024;

function safeValue(v: unknown): unknown {
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return v;
  if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) + "…" : v;
  return undefined; // オブジェクト・配列・その他は記録しない
}

export interface Audit {
  record(tool: string, args: Record<string, unknown>): void;
}

export function createAudit(path: string): Audit {
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
        if (existsSync(path) && statSync(path).size >= ROTATE_BYTES) {
          renameSync(path, path + ".1");
        }
        const safe: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) {
          const sv = safeValue(v);
          if (sv !== undefined || v === null) safe[k] = sv;
        }
        appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), tool, args: safe }) + "\n");
      } catch {
        // 握り潰す（家規: 監査は副次系）
      }
    },
  };
}
