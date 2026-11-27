/**
 * rinka native-host/src/types.ts — 型の中心。構文規約: const アロー関数と type 中心
 * （function宣言・interface不使用・as断言不使用・any禁止・Date.now禁止・空catch禁止）。
 *
 * Backend = 「Firefoxから情報を引けるもの」の抽象。v1ではAddonBackend（Native Messaging経由）のみ。
 * v0のMarionette実装とplaces.sqlite直接読みは廃止。
 * v2: 書込み系の型とmode（READ/WRITE）を追加。対象ガード・スキーム検査はaddon側、
 *     modeガードの二次（host側）はtools.ts、一次（addon側）はbackground.js。
 * 形状ガード（isRecord等）は「応答の形が不正ならfail-closed（寛容に解釈しない）」の実行側。
 * as断言の代わりにここで絞り込んだ型だけを下流に流す。
 */

export type TabInfo = {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
};

export type HistoryRow = {
  url: string;
  title: string;
  visitCount: number;
  lastVisit: string; // ISO 8601（無ければ null）
};

export type BackendMode = "read" | "write";

/** page_fill の入力欄（1..20）。valueの監査記録は長さのみ（家規5）。 */
export type FillField = {
  selector: string;
  value: string;
};

export type FillFieldResult = {
  selector: string;
  valueLength: number;
};

export type Backend = {
  /** タブ一覧。privateウィンドウは manifest の incognito:not_allowed により不可視。 */
  listTabs: () => Promise<{ tabs: TabInfo[] }>;
  /** 指定タブの本文（innerText・maxCharsはbackend側で計算済み）。 */
  readTab: (tabId: number) => Promise<{ tab: TabInfo; text: string }>;
  /** 指定タブのPNG（base64・1メッセージで受ける）。 */
  screenshot: (tabId: number) => Promise<{ tab: TabInfo; base64: string }>;
  /** 履歴検索（browser.history API 経由のみ・新しい順）。 */
  searchHistory: (query: string, limit: number) => Promise<HistoryRow[]>;

  // ---- v2 書込み（ここから下は WRITE 状態のみ。mode追跡は {t:"mode"} フレーム） ----
  /** 現在のmode。初期値read。addonからの {t:"mode"} 通知で変わる。 */
  getMode: () => BackendMode;
  /** tab = 実行後の新タブ。open は対象ガードで無条件に可（自開タブになる）。 */
  openTab: (url: string, active: boolean) => Promise<{ tab: TabInfo }>;
  /** tab = 実行前に採取した tabInfo（close後は取得不能なため。監査の正本）。 */
  closeTab: (tabId: number) => Promise<{ tab: TabInfo }>;
  /** activate は全タブ可（対象ガード外）。tab = 実行前採取。 */
  activateTab: (tabId: number) => Promise<{ tab: TabInfo }>;
  /** tab = 実行前採取、tabAfter = 遷移直後。 */
  navigateTab: (tabId: number, url: string) => Promise<{ tab: TabInfo; tabAfter: TabInfo }>;
  /** tab = 実行前採取。 */
  reloadTab: (tabId: number, bypassCache: boolean) => Promise<{ tab: TabInfo }>;
  /** go_back / go_forward 共用。tab = 実行前採取（戻り先は事前検証不能・既知限界）。 */
  goTab: (tabId: number, dir: "back" | "forward") => Promise<{ tab: TabInfo }>;
  /** click。element = クリック先要素の概要（tagName#id など）。tab = 実行前採取。 */
  pageClick: (tabId: number, target: { selector?: string; x?: number; y?: number }) => Promise<{ tab: TabInfo; element: string }>;
  /** fill（一括・全欄事前検査）。sudo は password 欄の許可（RINKA_SUDO_FILL / _URLS、境界照合はin-page）。 */
  pageFill: (tabId: number, fields: FillField[], sudo: { fill: boolean; urls: string[] }) => Promise<{ tab: TabInfo; fields: FillFieldResult[] }>;
  /** scroll。tab = 実行前採取。scrollY = 実行後のスクロール位置。 */
  pageScroll: (tabId: number, direction: "up" | "down", amount: number) => Promise<{ tab: TabInfo; scrollY: number }>;
};

// ---- 形状ガード（as断言の代替。全下流はこれで絞り込んだ型だけを使う） ----

/** JSONオブジェクト（配列は含めない）。未知の応答はまずこれで受ける。 */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** TabInfo は4欄とも検査（fail-closed。応答は信頼しない）。 */
export const isTabInfo = (v: unknown): v is TabInfo =>
  isRecord(v) &&
  typeof v.tabId === "number" &&
  typeof v.url === "string" &&
  typeof v.title === "string" &&
  typeof v.active === "boolean";

/** 履歴行。lastVisit はISO文字列かnull。 */
export const isHistoryRow = (v: unknown): v is HistoryRow =>
  isRecord(v) &&
  typeof v.url === "string" &&
  typeof v.title === "string" &&
  typeof v.visitCount === "number" &&
  (typeof v.lastVisit === "string" || v.lastVisit === null);

/** fill応答の1欄。値そのものは応響にも乗らない（selectorと長さのみ）。 */
export const isFillFieldResult = (v: unknown): v is FillFieldResult =>
  isRecord(v) && typeof v.selector === "string" && typeof v.valueLength === "number";

// ---- v3 マクロ（run_macro・仕様会議第1回 2026-11-27採決） ----

/** ステップの期待値。語彙はurlContains/text/valueLengthsのみで、評価は当該ステップの結果欄に対して行う
 *  （遷移系の応答は操作前スナップショットのため期待値評価の対象外）。 */
export type MacroExpect = {
  urlContains?: string;
  text?: string;
  valueLengths?: number[];
};

/** run_macro の1ステップ。callは既存工具名・tabはラベル参照（argsにtabIdは入れない）。 */
export type MacroStep = {
  call: string;
  tab?: string;
  args: Record<string, unknown>;
  expect?: MacroExpect;
};

/** マクロステップの形状ガード（fail-closed。語彙・ラベル生命周期は tools.ts の静的検査が担う）。 */
export const isMacroStep = (v: unknown): v is MacroStep =>
  isRecord(v) &&
  typeof v.call === "string" &&
  v.call.length > 0 &&
  (v.tab === undefined || typeof v.tab === "string") &&
  isRecord(v.args) &&
  (v.expect === undefined || isRecord(v.expect));
