/**
 * rinka native-host — Firefox (Native Messaging) が spawn する host の入口。
 *
 * 起動の流れ:
 *   1. validateEnvironment（token 0600 検査・未知env拒否）
 *   2. stdin を createNativeReader でフレーム解釈し createAddonBackend へ
 *      （stdout へはフレームのみを返す）
 *   3. HTTPサーバを 127.0.0.1 で listen
 *   4. listen 後、stdout に {t:"ready", port} をフレーム送信（アドオンがバッジを点灯）
 *   5. stdin 終端（アドオン切断=Firefoxがkill）または SIGTERM で server.close + exit 0
 *
 * 注意: stdout は Native Messaging 専用。ログは一切 stdout に書かない（stderr のみ）。
 * 構文規約: 決定性のため時刻はここ（合成ルート）で実測時計として注入する。
 *   これが Date 系を直接触る唯一の場所（src内で他は Date.now/new Date を使わない）。
 */

import { validateEnvironment } from "./config.ts";
import { createAddonBackend } from "./backend.ts";
import { createAudit } from "./audit.ts";
import { startServer } from "./http.ts";
import { createNativeReader, encodeNativeFrame } from "./native.ts";

const HOME = process.env.HOME ?? "/home";
let shuttingDown = false;

const main = async (): Promise<void> => {
  const config = validateEnvironment(process.env, HOME);
  const wallClock = (): string => new Date().toISOString(); // 注入される実測時計（境界はこの1箇所）
  const audit = createAudit(config.auditPath, wallClock);
  const monoClock = (): number => performance.now(); // マクロ予算用の経過時計（注入点もこの1箇所）

  const send = (o: Record<string, unknown>): void => {
    process.stdout.write(encodeNativeFrame(JSON.stringify(o)));
  };

  const backend = createAddonBackend(send);
  const reader = createNativeReader();

  process.stdin.on("data", (chunk: Buffer) => {
    try {
      const frames = reader.push(chunk);
      for (const f of frames) backend.onMessage(JSON.parse(f));
    } catch (e) {
      console.error("rinka: stdin フレーム解釈エラー", e);
      process.exit(1);
    }
  });

  const running = await startServer({ config, audit, backend, now: monoClock });

  // ==== 準備完了をアドオンに伝える ====
  send({ t: "ready", port: running.port });
  // v2: WRITE自動落ち秒数をアドオンへ渡す（RINKA_WRITE_TIMEOUT_SECONDS。アドオン側で防御クランプ）
  send({ t: "cfg", writeTimeoutSec: config.writeTimeoutSec });

  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void running.close().finally(() => process.exit(code));
  };

  process.stdin.on("end", () => shutdown(0)); // アドオン切断（OFFトグル）
  process.stdin.on("error", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
};

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
