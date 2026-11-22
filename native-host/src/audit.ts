/**
 * rinka native-host/src/audit.ts — 監査ログ（家規5: 本文を記録しない）。
 *
 * - 1件 = 1行 JSONL。tool名と安全な引数のみ。ページ本文・screenshot・検索結果は書かない。
 * - ファイルが64KBに達したら path → path.1 へローテーション（世代1つ、肥大化防止）。
 *   サイズ確認は毎回 stat で行う（行数カウンタと違い、プロセス再起動を跨いでも正しい）。
 * - 0600 で作成。監査ログの失敗で本体を止めない（副次系。ただし失敗は空catchでなく
 *   stderrに記録して握り痕を残す）。
 * - 時刻は here-and-now を使わず注入するClock（決定性規約: 時刻と乱数は外から渡す。
 *   index.ts が実測時計を渡し、テストは固定時計で決定的に検査する）。
 * - 文字列は200字で頭を切る。呼び出し側（tools.ts）が安全な引数のみ渡すのが第一防衛。
 * - v2: 書込み系は record(tool, args, {write:true, url}) で対象URLを実行前採取値と共に
 *   トップレベルに記録（close_tab は実行後採取不能なため全書込みで実行前に統一）。
 *   fill の value は絶対に書かない（tools.ts が長さのみを渡す）。
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const ROTATE_BYTES = 64 * 1024;

/** 監査1件のts欄を出す時計（ISO 8601文字列）。index.tsが実測時計を注入する。 */
export type Clock = () => string;

const safeValue = (v: unknown): unknown => {
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return v;
  if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) + "…" : v;
  if (Array.isArray(v)) {
    // プリミティブのみの配列は通す（valueLengths 等）。1レベルのみ。オブジェクト混じりは落とす。
    const arr = v.map(safeValue);
    return arr.every((x) => x !== undefined) ? arr : undefined;
  }
  return undefined; // オブジェクト・その他は記録しない
};

export type AuditWriteTag = {
  write?: boolean;
  url?: string;
};

export type Audit = {
  record: (tool: string, args: Record<string, unknown>, tag?: AuditWriteTag) => void;
};

export const createAudit = (path: string, now: Clock): Audit => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      appendFileSync(path, "", { mode: 0o600 });
      chmodSync(path, 0o600);
    }
  } catch (e) {
    // 監査ログ初期化失敗でも本体は止めない。握り痕をstderrに残す（空catch禁止規約）
    console.error("rinka: 監査ログの初期化に失敗しました（本体は続行）:", e instanceof Error ? e.message : e);
  }

  return {
    record: (tool: string, args: Record<string, unknown>, tag?: AuditWriteTag) => {
      try {
        if (existsSync(path) && statSync(path).size >= ROTATE_BYTES) {
          renameSync(path, path + ".1");
        }
        const safe: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) {
          const sv = safeValue(v);
          if (sv !== undefined || v === null) safe[k] = sv;
        }
        const entry: Record<string, unknown> = { ts: now(), tool, args: safe };
        if (tag?.write === true) entry.write = 1;
        if (typeof tag?.url === "string" && tag.url.length > 0) {
          entry.url = tag.url.length > 200 ? tag.url.slice(0, 200) + "…" : tag.url;
        }
        appendFileSync(path, JSON.stringify(entry) + "\n");
      } catch (e) {
        // 家規: 監査は副次系なので本体は止めない。ただし握り痕はstderrに残す（空catch禁止規約）
        console.error("rinka: 監査ログの書込に失敗しました（本体は続行）:", e instanceof Error ? e.message : e);
      }
    },
  };
};
