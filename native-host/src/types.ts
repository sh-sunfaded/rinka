/**
 * rinka native-host/src/types.ts — 型の中心。
 *
 * Backend = 「Firefoxから情報を引けるもの」の抽象。v1ではAddonBackend（Native Messaging経由）のみ。
 * v0のMarionette実装とplaces.sqlite直接読みは廃止。
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

export interface Backend {
  /** タブ一覧。privateウィンドウは manifest の incognito:not_allowed により不可視。 */
  listTabs(): Promise<{ tabs: TabInfo[] }>;
  /** 指定タブの本文（innerText・maxCharsはbackend側で計算済み）。 */
  readTab(tabId: number): Promise<{ tab: TabInfo; text: string }>;
  /** 指定タブのPNG（base64・chunk合成済み）。 */
  screenshot(tabId: number): Promise<{ tab: TabInfo; base64: string }>;
  /** 履歴検索（browser.history API 経由のみ・新しい順）。 */
  searchHistory(query: string, limit: number): Promise<HistoryRow[]>;
}
