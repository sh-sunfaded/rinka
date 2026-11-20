/**
 * rinka native-host/src/config.ts — 環境変数とトークンの規律（家規1・2の入口）。
 *
 * - RINKA_* の既知varは8種だけ。未知のRINKA_*があれば起動拒否（typo・乗取り防止）。
 * - RINKA_HOST は localhost 系のみ（0.0.0.0 等は拒否。家規1：露出は使用時のみかつ自機のみ）。
 * - トークン: RINKA_TOKEN env（テスト/CLI上書き用）> 0600 のトークンファイル
 *   ~/.config/rinka/token。権限が緩い（group/otherに読める/書ける）なら起動拒否。
 * - ポート: 1〜65535、または0（ephemeral。テストと ready 報告用）。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  host: string;
  port: number;
  token: string;
  readMaxBytes: number;
  screenshotMaxBytes: number;
  historyMaxRows: number;
  auditPath: string;
}

const KNOWN_VARS: ReadonlySet<string> = new Set([
  "RINKA_TOKEN",
  "RINKA_TOKEN_PATH",
  "RINKA_HOST",
  "RINKA_PORT",
  "RINKA_READ_MAX_BYTES",
  "RINKA_SCREENSHOT_MAX_BYTES",
  "RINKA_HISTORY_MAX_ROWS",
  "RINKA_AUDIT_PATH",
]);

const LOCALHOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

const MIN_TOKEN_LEN = 32;

function intRange(name: string, raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`rinka: ${name} は ${min}〜${max} の整数で指定してください（実測: ${raw}）`);
  }
  return n;
}

/** トークン読み込み: env RINKA_TOKEN > RINKA_TOKEN_PATH のファイル > ~/.config/rinka/token。 */
export function loadToken(env: Record<string, string | undefined>, homeDir: string): string {
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
}

export function validateEnvironment(env: Record<string, string | undefined>, homeDir: string): Config {
  for (const key of Object.keys(env)) {
    if (key.startsWith("RINKA_") && !KNOWN_VARS.has(key)) {
      throw new Error(`rinka: 未知の環境変数です: ${key}（既知は $(RINKA_TOKEN, RINKA_TOKEN_PATH, RINKA_HOST, RINKA_PORT, RINKA_READ_MAX_BYTES, RINKA_SCREENSHOT_MAX_BYTES, RINKA_HISTORY_MAX_ROWS, RINKA_AUDIT_PATH)）`);
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

  const token = loadToken(env, homeDir);

  return { host, port, token, readMaxBytes, screenshotMaxBytes, historyMaxRows, auditPath };
}
