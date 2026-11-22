/**
 * rinka native-host/src/types.ts — 型の中心。
 *
 * Backend = 「Firefoxから情報を引けるもの」の抽象。v1ではAddonBackend（Native Messaging経由）のみ。
 * v0のMarionette実装とplaces.sqlite直接読みは廃止。
 * v2: 書込み系のifaceとmode（READ/WRITE）を追加。対象ガード・スキーム検査はaddon側、
 *     modeガードの二次（host側）はtools.ts、一次（addon側）はbackground.js。
 */

export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
}

export interface HistoryRow {
  url: string;
  title: string;
  visitCount: number;
  lastVisit: string; // ISO 8601（無ければ null）
}

export type BackendMode = "read" | "write";

/** page_fill の入力欄（1..20）。valueの監査記録は長さのみ（家規5）。 */
export interface FillField {
  selector: string;
  value: string;
}

export interface FillFieldResult {
  selector: string;
  valueLength: number;
}

export interface Backend {
  /** タブ一覧。privateウィンドウは manifest の incognito:not_allowed により不可視。 */
  listTabs(): Promise<{ tabs: TabInfo[] }>;
  /** 指定タブの本文（innerText・maxCharsはbackend側で計算済み）。 */
  readTab(tabId: number): Promise<{ tab: TabInfo; text: string }>;
  /** 指定タブのPNG（base64・1メッセージで受ける）。 */
  screenshot(tabId: number): Promise<{ tab: TabInfo; base64: string }>;
  /** 履歴検索（browser.history API 経由のみ・新しい順）。 */
  searchHistory(query: string, limit: number): Promise<HistoryRow[]>;

  // ---- v2 書込み（ここから下は WRITE 状態のみ。mode追跡は {t:"mode"} フレーム） ----
  /** 現在のmode。初期値read。addonからの {t:"mode"} 通知で変わる。 */
  getMode(): BackendMode;
  /** tab = 実行後の新タブ。open は対象ガードで無条件に可（自開タブになる）。 */
  openTab(url: string, active: boolean): Promise<{ tab: TabInfo }>;
  /** tab = 実行前に採取した tabInfo（close後は取得不能なため。監査の正本）。 */
  closeTab(tabId: number): Promise<{ tab: TabInfo }>;
  /** activate は全タブ可（対象ガード外）。tab = 実行前採取。 */
  activateTab(tabId: number): Promise<{ tab: TabInfo }>;
  /** tab = 実行前採取、tabAfter = 遷移直後。 */
  navigateTab(tabId: number, url: string): Promise<{ tab: TabInfo; tabAfter: TabInfo }>;
  /** tab = 実行前採取。 */
  reloadTab(tabId: number, bypassCache: boolean): Promise<{ tab: TabInfo }>;
  /** go_back / go_forward 共用。tab = 実行前採取（戻り先は事前検証不能・既知限界）。 */
  goTab(tabId: number, dir: "back" | "forward"): Promise<{ tab: TabInfo }>;
  /** click。element = クリック先要素の概要（tagName#id など）。tab = 実行前採取。 */
  pageClick(tabId: number, target: { selector?: string; x?: number; y?: number }): Promise<{ tab: TabInfo; element: string }>;
  /** fill（一括・全欄事前検査）。sudo は password 欄の許可（RINKA_SUDO_FILL / _URLS、境界照合はin-page）。 */
  pageFill(tabId: number, fields: FillField[], sudo: { fill: boolean; urls: string[] }): Promise<{ tab: TabInfo; fields: FillFieldResult[] }>;
  /** scroll。tab = 実行前採取。scrollY = 実行後のスクロール位置。 */
  pageScroll(tabId: number, direction: "up" | "down", amount: number): Promise<{ tab: TabInfo; scrollY: number }>;
}
