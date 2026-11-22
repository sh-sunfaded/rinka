/**
 * rinka native-host/src/backend.ts — AddonBackend（Native Messaging port上の相手）。
 *
 * host→addon: {t:"req", id, cmd, args} / {t:"cfg", writeTimeoutSec}
 * addon→host: {t:"resp", id, ok:bool, result|error} / {t:"mode", v:"read"|"write"}
 * - 家規: 要求は15秒で打ち切る（MCP応答を無限吊りにしない）
 * - 家規: 応答の形が不正なら fail-closed（寛容に解釈しない）
 * - 大容量（screenshot）も1メッセージで流す。32MBフレーム上限（native.ts）が防衛になる
 * - v2: mode を追跡（host側modeガードの二次用。一次はaddon側）。書込みcmd 10本。
 */

import type { Backend, TabInfo, HistoryRow, BackendMode, FillField, FillFieldResult } from "./types.ts";

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
  private mode: BackendMode = "read"; // addon の {t:"mode"} 通知で追従（初期はread）

  constructor(send: (o: Record<string, unknown>) => void) {
    this.send = send;
  }

  getMode(): BackendMode {
    return this.mode;
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
    if (m.t === "mode") {
      this.mode = m.v === "write" ? "write" : "read"; // 寛容に解釈しない（read以外はread）

      // mode通知は pending に影響しない（進行中の呼び出しはそのまま待つ）
      return;
    }
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
    // ready / cfg は index.ts 側、他は無視
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

  // ---- v2 書込み ----

  async openTab(url: string, active: boolean): Promise<{ tab: TabInfo }> {
    const r = await this.call<{ tab?: unknown }>("tabs/open", { url, active }, "rinka: fail-closed（タブを開けません）");
    if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（新タブ情報が不正です）");
    return { tab: r.tab as TabInfo };
  }

  async closeTab(tabId: number): Promise<{ tab: TabInfo }> {
    const r = await this.call<{ tab?: unknown }>("tabs/close", { tabId }, "rinka: fail-closed（タブを閉じられません）");
    if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
    return { tab: r.tab as TabInfo };
  }

  async activateTab(tabId: number): Promise<{ tab: TabInfo }> {
    const r = await this.call<{ tab?: unknown }>("tabs/activate", { tabId }, "rinka: fail-closed（タブを切り替えられません）");
    if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
    return { tab: r.tab as TabInfo };
  }

  async navigateTab(tabId: number, url: string): Promise<{ tab: TabInfo; tabAfter: TabInfo }> {
    const r = await this.call<{ tab?: unknown; tabAfter?: unknown }>("tabs/navigate", { tabId, url }, "rinka: fail-closed（タブを遷移させられません）");
    if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
    if (!isTabInfo(r.tabAfter)) throw new Error("rinka: fail-closed（遷移後タブ情報が不正です）");
    return { tab: r.tab as TabInfo, tabAfter: r.tabAfter as TabInfo };
  }

  async reloadTab(tabId: number, bypassCache: boolean): Promise<{ tab: TabInfo }> {
    const r = await this.call<{ tab?: unknown }>("tabs/reload", { tabId, bypassCache }, "rinka: fail-closed（タブを再読込できません）");
    if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
    return { tab: r.tab as TabInfo };
  }

  async goTab(tabId: number, dir: "back" | "forward"): Promise<{ tab: TabInfo }> {
    const r = await this.call<{ tab?: unknown }>(`tabs/${dir}`, { tabId }, `rinka: fail-closed（タブを${dir === "back" ? "戻" : "進"}められません）`);
    if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
    return { tab: r.tab as TabInfo };
  }

  async pageClick(tabId: number, target: { selector?: string; x?: number; y?: number }): Promise<{ tab: TabInfo; element: string }> {
    const args: Record<string, unknown> = { tabId };
    if (typeof target.selector === "string") args.selector = target.selector;
    if (typeof target.x === "number") args.x = target.x;
    if (typeof target.y === "number") args.y = target.y;
    const r = await this.call<{ tab?: unknown; element?: unknown }>("page/click", args, "rinka: fail-closed（クリックできません）");
    if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
    return { tab: r.tab as TabInfo, element: typeof r.element === "string" ? r.element : "" };
  }

  async pageFill(tabId: number, fields: FillField[], sudo: { fill: boolean; urls: string[] }): Promise<{ tab: TabInfo; fields: FillFieldResult[] }> {
    const r = await this.call<{ tab?: unknown; fields?: unknown }>(
      "page/fill",
      { tabId, fields, sudoFill: sudo.fill, sudoFillUrls: sudo.urls },
      "rinka: fail-closed（フォームに入力できません）",
    );
    if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
    if (!Array.isArray(r.fields)) throw new Error("rinka: fail-closed（fill結果の応答形が不正です）");
    return { tab: r.tab as TabInfo, fields: r.fields as FillFieldResult[] };
  }

  async pageScroll(tabId: number, direction: "up" | "down", amount: number): Promise<{ tab: TabInfo; scrollY: number }> {
    const r = await this.call<{ tab?: unknown; scrollY?: unknown }>("page/scroll", { tabId, direction, amount }, "rinka: fail-closed（スクロールできません）");
    if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
    return { tab: r.tab as TabInfo, scrollY: typeof r.scrollY === "number" ? r.scrollY : 0 };
  }
}
