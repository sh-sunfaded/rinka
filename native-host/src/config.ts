/**
 * rinka native-host/src/config.ts — 環境変数とトークンの規律（家規1・2の入口）。
 *
 * - RINKA_* の既知varは12種だけ。未知のRINKA_*があれば起動拒否（typo・乗取り防止）。
 * - RINKA_HOST は localhost 系のみ（0.0.0.0 等は拒否。家規1：露出は使用時のみかつ自機のみ）。
 * - トークン: RINKA_TOKEN env（テスト/CLI上書き用）> 0600 のトークンファイル
 *   ~/.config/rinka/token。権限が緩い（group/otherに読める/書ける）なら起動拒否。
 * - ポート: 1〜65535、または0（ephemeral。テストと ready 報告用）。
 * - v2 書込み系: RINKA_WRITE_TIMEOUT_SECONDS（WRITE自動落ち・既定1800）、
 *   RINKA_SUDO_FILL（password欄fill許可・既定false）、
 *   RINKA_SUDO_FILL_URLS（allowlist・カンマ区切り。sudo有効時に空は起動拒否。境界照合はin-page）、
 *   RINKA_FILL_MAX_BYTES（fill値の1欄あたり上限・既定4096）。
 * - v3 マクロ: RINKA_MACRO_BUDGET_SECONDS（run_macro全体の予算・既定300。
 *   ステップ毎の15秒打ち切りと合わせ、アドオンのWRITE自動落下とは別系統のhost側上限）。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Config = {
  host: string;
  port: number;
  token: string;
  readMaxBytes: number;
  screenshotMaxBytes: number;
  historyMaxRows: number;
  auditPath: string;
  /** WRITE自動落ちまでの秒（家規: 書き忘れ対策。既定30分）。host→addon へ {t:"cfg"} で渡す。 */
  writeTimeoutSec: number;
  /** password欄へのfillが許可されているか（sudo権限。既定false）。 */
  sudoFill: boolean;
  /** sudo有効時のURL allowlist。sudo=1で空なら起動拒否（fail-closed・仕様会議第3回）。境界照合（startsWith不採用）はin-page。 */
  sudoFillUrls: string[];
  /** page_fill 1欄あたりのvalueバイト上限。 */
  fillMaxBytes: number;
  /** run_macro の全体予算秒（仕様会議第1回・既定300）。超過で打ち切って部分レポート。 */
  macroBudgetSec: number;
};

const KNOWN_VARS: ReadonlySet<string> = new Set([
  "RINKA_TOKEN",
  "RINKA_TOKEN_PATH",
  "RINKA_HOST",
  "RINKA_PORT",
  "RINKA_READ_MAX_BYTES",
  "RINKA_SCREENSHOT_MAX_BYTES",
  "RINKA_HISTORY_MAX_ROWS",
  "RINKA_AUDIT_PATH",
  "RINKA_WRITE_TIMEOUT_SECONDS",
  "RINKA_SUDO_FILL",
  "RINKA_SUDO_FILL_URLS",
  "RINKA_FILL_MAX_BYTES",
  "RINKA_MACRO_BUDGET_SECONDS",
]);

const LOCALHOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

const MIN_TOKEN_LEN = 32;

const intRange = (name: string, raw: string | undefined, def: number, min: number, max: number): number => {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`rinka: ${name} は ${min}〜${max} の整数で指定してください（実測: ${raw}）`);
  }
  return n;
};

/** トークン読み込み: env RINKA_TOKEN > RINKA_TOKEN_PATH のファイル > ~/.config/rinka/token。 */
export const loadToken = (env: Record<string, string | undefined>, homeDir: string): string => {
  const envToken = env.RINKA_TOKEN;
  if (typeof envToken === "string" && envToken.length > 0) {
    if (envToken.length < MIN_TOKEN_LEN) {
      throw new Error(`rinka: トークンが短すぎます（${MIN_TOKEN_LEN}字以上）`);
    }
    return envToken;
  }
  const path = env.RINKA_TOKEN_PATH ?? join(homeDir, ".config", "rinka", "token");
  if (!existsSync(path)) {
    throw new Error(
      `rinka: トークンファイルがありません（${path}）。rinka-host.sh token で生成するか、RINKA_TOKEN 環境変数を渡してください`,
    );
  }
  const st = statSync(path);
  const badBits = st.mode & 0o177; // group/other の読み書き実行
  if (badBits !== 0) {
    throw new Error(`rinka: トークンファイルの権限が緩いです（0600にしてください）: ${path}`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (token.length < MIN_TOKEN_LEN) {
    throw new Error(`rinka: トークンが短すぎます（${MIN_TOKEN_LEN}字以上）: ${path}`);
  }
  return token;
};

/** bool env: "1"/"true"/"yes" はtrue、"0"/"false"/"no"/未設定 はfalse、他は拒否（typo防止）。 */
const boolStrict = (name: string, raw: string | undefined): boolean => {
  if (raw === undefined || raw === "") return false;
  const v = raw.toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  throw new Error(`rinka: ${name} は true/false で指定してください（実測: ${raw}）`);
};

/** allowlistの空エントリ除去＋URL形式検査（境界照合自体は in-page で行う）。 */
const parseUrlList = (name: string, raw: string | undefined): string[] => {
  if (raw === undefined || raw.trim() === "") return [];
  const items = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const it of items) {
    const u = parseHttpUrl(it);
    if (u === null) {
      throw new Error(`rinka: ${name} に不正なURLがあります: ${it}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`rinka: ${name} は http/https のURLで指定してください（実測: ${it}）`);
    }
  }
  return items;
};

/** new URL の成否を null で返す判別関数（空catchを書かずにURL検査するための小さな閉包）。 */
const parseHttpUrl = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

export const validateEnvironment = (env: Record<string, string | undefined>, homeDir: string): Config => {
  for (const key of Object.keys(env)) {
    if (key.startsWith("RINKA_") && !KNOWN_VARS.has(key)) {
      throw new Error(`rinka: 未知の環境変数です: ${key}（既知は $(RINKA_TOKEN, RINKA_TOKEN_PATH, RINKA_HOST, RINKA_PORT, RINKA_READ_MAX_BYTES, RINKA_SCREENSHOT_MAX_BYTES, RINKA_HISTORY_MAX_ROWS, RINKA_AUDIT_PATH, RINKA_WRITE_TIMEOUT_SECONDS, RINKA_SUDO_FILL, RINKA_SUDO_FILL_URLS, RINKA_FILL_MAX_BYTES, RINKA_MACRO_BUDGET_SECONDS)）`);
    }
  }

  const host = env.RINKA_HOST ?? "127.0.0.1";
  if (!LOCALHOSTS.has(host)) {
    throw new Error(`rinka: RINKA_HOST は localhost 系のみです（実測: ${host}）`);
  }

  let port: number;
  if (env.RINKA_PORT === undefined || env.RINKA_PORT === "") {
    port = 8765;
  } else {
    const n = Number(env.RINKA_PORT);
    // 0 = ephemeral（テスト・ready報告用）。実用は 1〜65535。
    if (!Number.isInteger(n) || (n !== 0 && (n < 1 || n > 65535))) {
      throw new Error(`rinka: RINKA_PORT は 0〜65535 の整数で指定してください（実測: ${env.RINKA_PORT}）`);
    }
    port = n;
  }

  const readMaxBytes = intRange("RINKA_READ_MAX_BYTES", env.RINKA_READ_MAX_BYTES, 65536, 1, 10 * 1024 * 1024);
  const screenshotMaxBytes = intRange("RINKA_SCREENSHOT_MAX_BYTES", env.RINKA_SCREENSHOT_MAX_BYTES, 4 * 1024 * 1024, 1, 64 * 1024 * 1024);
  const historyMaxRows = intRange("RINKA_HISTORY_MAX_ROWS", env.RINKA_HISTORY_MAX_ROWS, 20, 1, 1000);
  // 既定は ~/.config/rinka/audit.jsonl（Firefox spawn の working directory が不定なため相対パスは避ける）
  const auditPath = env.RINKA_AUDIT_PATH ?? join(homeDir, ".config", "rinka", "audit.jsonl");

  const writeTimeoutSec = intRange("RINKA_WRITE_TIMEOUT_SECONDS", env.RINKA_WRITE_TIMEOUT_SECONDS, 1800, 1, 86400);
  const sudoFill = boolStrict("RINKA_SUDO_FILL", env.RINKA_SUDO_FILL);
  const sudoFillUrls = parseUrlList("RINKA_SUDO_FILL_URLS", env.RINKA_SUDO_FILL_URLS);
  // sudo有効時にallowlist空は起動拒否（fail-closed。仕様会議第3回・2026-11-28採決）
  if (sudoFill && sudoFillUrls.length === 0) {
    throw new Error("rinka: RINKA_SUDO_FILL=1 のときは RINKA_SUDO_FILL_URLS に許可URLを列挙してください（空のallowlistでの全URL許可は廃止・起動拒否）");
  }
  const fillMaxBytes = intRange("RINKA_FILL_MAX_BYTES", env.RINKA_FILL_MAX_BYTES, 4096, 1, 65536);
  const macroBudgetSec = intRange("RINKA_MACRO_BUDGET_SECONDS", env.RINKA_MACRO_BUDGET_SECONDS, 300, 1, 86400);

  const token = loadToken(env, homeDir);

  return { host, port, token, readMaxBytes, screenshotMaxBytes, historyMaxRows, auditPath, writeTimeoutSec, sudoFill, sudoFillUrls, fillMaxBytes, macroBudgetSec };
};
