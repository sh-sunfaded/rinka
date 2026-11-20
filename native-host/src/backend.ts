/**
 * rinka native-host/src/backend.ts — AddonBackend（Native Messaging port上の相手）。
 *
 * host→addon: {t:"req", id, cmd, args} / addon→host: {t:"resp", id, ok:bool, result|error}
 * - 家規: 要求は15秒で打ち切る（MCP応答を無限吊りにしない）
 * - 家規: 応答の形が不正なら fail-closed（寛容に解釈しない）
 * - 大容量（screenshot）も1メッセージで流す。32MBフレーム上限（native.ts）が防衛になる
 */

import type { Backend, TabInfo, HistoryRow } from "./types.ts";

export const BACKEND_CALL_TIMEOUT_MS = 15000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isTabInfo(v: unknown): v is TabInfo {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.tabId === "number";
}

export class AddonBackend implements Backend {
  private readonly send: (o: Record<string, unknown>) => void;
  private idSeq = 0;
  private pending = new Map<number, Pending>();

  constructor(send: (o: Record<string, unknown>) => void) {
    this.send = send;
  }

  private call<T>(cmd: string, args: Record<string, unknown>, failClosed: string): Promise<T> {
    const id = ++this.idSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(failClosed));
      }, BACKEND_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.send({ t: "req", id, cmd, args });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`rinka: アドオンへの送信に失敗: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  /** アドオンからの応答1件（index.ts がフレーム解釈して渡す）。 */
  onMessage(o: unknown): void {
    if (typeof o !== "object" || o === null) return;
    const m = o as Record<string, unknown>;
    if (m.t === "resp" && typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (p === undefined) return; // 未知id（二重resp等）は無視
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.ok !== true) {
        p.reject(new Error(String(m.error ?? "アドオンがエラーを返しました（詳細なし）")));
        return;
      }
      const result = m.result;
      p.resolve(result === null || typeof result !== "object" ? {} : result);
    }
    // ready は index.ts 側、他は無視
  }

  async listTabs(): Promise<{ tabs: TabInfo[] }> {
    const r = await this.call<{ tabs?: unknown }>("tabs/list", {}, "rinka: fail-closed（タブ一覧を取得できません）");
    if (!Array.isArray(r.tabs)) {
      throw new Error("rinka: fail-closed（タブ一覧の応答形が不正です）");
    }
    return { tabs: r.tabs as TabInfo[] };
  }

  async readTab(tabId: number): Promise<{ tab: TabInfo; text: string }> {
    const r = await this.call<{ tab?: unknown; text?: unknown }>("tabs/read", { tabId }, "rinka: fail-closed（本文を取得できません）");
    if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
    if (typeof r.text !== "string") throw new Error("rinka: fail-closed（本文が文字列ではありません）");
    return { tab: r.tab as TabInfo, text: r.text };
  }

  async screenshot(tabId: number): Promise<{ tab: TabInfo; base64: string }> {
    const r = await this.call<{ tab?: unknown; base64?: unknown }>("tabs/capture", { tabId }, "rinka: fail-closed（スクリーンショットを取得できません）");
    if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
    if (typeof r.base64 !== "string" || r.base64.length === 0) {
      throw new Error("rinka: fail-closed（スクリーンショットが空/不正です）");
    }
    return { tab: r.tab as TabInfo, base64: r.base64 };
  }

  async searchHistory(query: string, limit: number): Promise<HistoryRow[]> {
    const r = await this.call<{ rows?: unknown }>("history/search", { query, limit }, "rinka: fail-closed（履歴を検索できません）");
    if (!Array.isArray(r.rows)) {
      throw new Error("rinka: fail-closed（履歴の応答形が不正です）");
    }
    return r.rows as HistoryRow[];
  }
}
