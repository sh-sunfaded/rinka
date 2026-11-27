/**
 * rinka native-host/src/backend.ts — AddonBackend（Native Messaging port上の相手）。
 *
 * host→addon: {t:"req", id, cmd, args} / {t:"cfg", writeTimeoutSec}
 * addon→host: {t:"resp", id, ok:bool, result|error} / {t:"mode", v:"read"|"write"}
 * - 家規: 要求は15秒で打ち切る（MCP応答を無限吊りにしない）
 * - 家規: 応答の形が不正なら fail-closed（寛容に解釈しない）
 * - 大容量（screenshot）も1メッセージで流す。32MBフレーム上限（native.ts）が防衛になる
 * - v2: mode を追跡（host側modeガードの二次用。一次はaddon側）。書込みcmd 10本。
 * - 構文規約: クラス不使用。可変状態（pending・mode）はclosureの中に閉じる。
 *   応答欄は as断言でなく形状ガード（types.ts）で絞り込み、不正ならfail-closedで落とす。
 */

import { isFillFieldResult, isHistoryRow, isRecord, isSelectInfo, isTabInfo } from "./types.ts";
import type { Backend, BackendMode, FillField, FillFieldResult, HistoryRow, SelectInfo, TabInfo } from "./types.ts";

export const BACKEND_CALL_TIMEOUT_MS = 15000;

type Pending = {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Backend操作に加えて、index.tsがフレーム解釈後に渡す onMessage だけを公開する。 */
export type AddonBackend = Backend & { onMessage: (o: unknown) => void };

export const createAddonBackend = (send: (o: Record<string, unknown>) => void): AddonBackend => {
  let idSeq = 0;
  let mode: BackendMode = "read"; // addon の {t:"mode"} 通知で追従（初期はread）
  const pending = new Map<number, Pending>();

  const call = (cmd: string, args: Record<string, unknown>, failClosed: string): Promise<Record<string, unknown>> => {
    const id = ++idSeq;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(failClosed));
      }, BACKEND_CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        send({ t: "req", id, cmd, args });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`rinka: アドオンへの送信に失敗: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  };

  /** 取得系の共通検査: 応答はrecordであること（それ以外はfail-closed）。 */
  const callRecord = (cmd: string, args: Record<string, unknown>, failClosed: string): Promise<Record<string, unknown>> =>
    call(cmd, args, failClosed).then((r) => {
      if (!isRecord(r)) throw new Error(failClosed);
      return r;
    });

  return {
    getMode: (): BackendMode => mode,

    /** アドオンからの応答1件（index.ts がフレーム解釈して渡す）。 */
    onMessage: (o: unknown): void => {
      if (!isRecord(o)) return;
      if (o.t === "mode") {
        mode = o.v === "write" ? "write" : "read"; // 寛容に解釈しない（read以外はread）
        // mode通知は pending に影響しない（進行中の呼び出しはそのまま待つ）
        return;
      }
      if (o.t === "resp" && typeof o.id === "number") {
        const p = pending.get(o.id);
        if (p === undefined) return; // 未知id（二重resp等）は無視
        clearTimeout(p.timer);
        pending.delete(o.id);
        if (o.ok !== true) {
          p.reject(new Error(String(o.error ?? "アドオンがエラーを返しました（詳細なし）")));
          return;
        }
        p.resolve(isRecord(o.result) ? o.result : {});
      }
      // ready / cfg は index.ts 側、他は無視
    },

    listTabs: async (): Promise<{ tabs: TabInfo[] }> => {
      const r = await callRecord("tabs/list", {}, "rinka: fail-closed（タブ一覧を取得できません）");
      const raw = r.tabs;
      if (!Array.isArray(raw)) {
        throw new Error("rinka: fail-closed（タブ一覧の応答形が不正です）");
      }
      const tabs = raw.filter(isTabInfo);
      if (tabs.length !== raw.length) throw new Error("rinka: fail-closed（タブ情報が不正です）");
      return { tabs };
    },

    readTab: async (tabId: number): Promise<{ tab: TabInfo; text: string }> => {
      const r = await callRecord("tabs/read", { tabId }, "rinka: fail-closed（本文を取得できません）");
      if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
      if (typeof r.text !== "string") throw new Error("rinka: fail-closed（本文が文字列ではありません）");
      return { tab: r.tab, text: r.text };
    },

    screenshot: async (tabId: number): Promise<{ tab: TabInfo; base64: string }> => {
      const r = await callRecord("tabs/capture", { tabId }, "rinka: fail-closed（スクリーンショットを取得できません）");
      if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
      if (typeof r.base64 !== "string" || r.base64.length === 0) {
        throw new Error("rinka: fail-closed（スクリーンショットが空/不正です）");
      }
      return { tab: r.tab, base64: r.base64 };
    },

    searchHistory: async (query: string, limit: number): Promise<HistoryRow[]> => {
      const r = await callRecord("history/search", { query, limit }, "rinka: fail-closed（履歴を検索できません）");
      const raw = r.rows;
      if (!Array.isArray(raw)) {
        throw new Error("rinka: fail-closed（履歴の応答形が不正です）");
      }
      const rows = raw.filter(isHistoryRow);
      if (rows.length !== raw.length) throw new Error("rinka: fail-closed（履歴行が不正です）");
      return rows;
    },

    selectOptions: async (tabId: number, selector: string): Promise<{ tab: TabInfo; selects: SelectInfo[] }> => {
      const r = await callRecord("selects/list", { tabId, selector }, "rinka: fail-closed（select一覧を取得できません）");
      if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
      const raw = r.selects;
      if (!Array.isArray(raw)) {
        throw new Error("rinka: fail-closed（select一覧の応答形が不正です）");
      }
      const selects = raw.filter(isSelectInfo);
      if (selects.length !== raw.length) throw new Error("rinka: fail-closed（select情報が不正です）");
      return { tab: r.tab, selects };
    },

    // ---- v2 書込み ----

    openTab: async (url: string, active: boolean): Promise<{ tab: TabInfo }> => {
      const r = await callRecord("tabs/open", { url, active }, "rinka: fail-closed（タブを開けません）");
      if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（新タブ情報が不正です）");
      return { tab: r.tab };
    },

    closeTab: async (tabId: number): Promise<{ tab: TabInfo }> => {
      const r = await callRecord("tabs/close", { tabId }, "rinka: fail-closed（タブを閉じられません）");
      if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
      return { tab: r.tab };
    },

    activateTab: async (tabId: number): Promise<{ tab: TabInfo }> => {
      const r = await callRecord("tabs/activate", { tabId }, "rinka: fail-closed（タブを切り替えられません）");
      if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
      return { tab: r.tab };
    },

    navigateTab: async (tabId: number, url: string): Promise<{ tab: TabInfo; tabAfter: TabInfo }> => {
      const r = await callRecord("tabs/navigate", { tabId, url }, "rinka: fail-closed（タブを遷移させられません）");
      if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
      if (!isTabInfo(r.tabAfter)) throw new Error("rinka: fail-closed（遷移後タブ情報が不正です）");
      return { tab: r.tab, tabAfter: r.tabAfter };
    },

    reloadTab: async (tabId: number, bypassCache: boolean): Promise<{ tab: TabInfo }> => {
      const r = await callRecord("tabs/reload", { tabId, bypassCache }, "rinka: fail-closed（タブを再読込できません）");
      if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
      return { tab: r.tab };
    },

    goTab: async (tabId: number, dir: "back" | "forward"): Promise<{ tab: TabInfo }> => {
      const r = await callRecord(`tabs/${dir}`, { tabId }, `rinka: fail-closed（タブを${dir === "back" ? "戻" : "進"}められません）`);
      if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
      return { tab: r.tab };
    },

    pageClick: async (tabId: number, target: { selector?: string; x?: number; y?: number }): Promise<{ tab: TabInfo; element: string }> => {
      const args: Record<string, unknown> = { tabId };
      if (typeof target.selector === "string") args.selector = target.selector;
      if (typeof target.x === "number") args.x = target.x;
      if (typeof target.y === "number") args.y = target.y;
      const r = await callRecord("page/click", args, "rinka: fail-closed（クリックできません）");
      if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
      return { tab: r.tab, element: typeof r.element === "string" ? r.element : "" };
    },

    pageFill: async (tabId: number, fields: FillField[], sudo: { fill: boolean; urls: string[] }): Promise<{ tab: TabInfo; fields: FillFieldResult[] }> => {
      const r = await callRecord(
        "page/fill",
        { tabId, fields, sudoFill: sudo.fill, sudoFillUrls: sudo.urls },
        "rinka: fail-closed（フォームに入力できません）",
      );
      if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
      const raw = r.fields;
      if (!Array.isArray(raw)) throw new Error("rinka: fail-closed（fill結果の応答形が不正です）");
      const results = raw.filter(isFillFieldResult);
      if (results.length !== raw.length) throw new Error("rinka: fail-closed（fill結果が不正です）");
      return { tab: r.tab, fields: results };
    },

    pageScroll: async (tabId: number, direction: "up" | "down", amount: number): Promise<{ tab: TabInfo; scrollY: number }> => {
      const r = await callRecord("page/scroll", { tabId, direction, amount }, "rinka: fail-closed（スクロールできません）");
      if (!isTabInfo(r.tab)) throw new Error("rinka: fail-closed（タブ情報が不正です）");
      return { tab: r.tab, scrollY: typeof r.scrollY === "number" ? r.scrollY : 0 };
    },
  };
};
