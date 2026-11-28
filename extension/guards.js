/**
 * rinka — guards.js（拡張側ガードの純関数集）。manifest の background.scripts で
 * background.js より先に読み込まれ、globalThis.rinkaGuards へ一括公開する。
 *
 * ここに入るのは外部状態に触らない純関数だけ（決定論があるのでNode側で直接検査できる:
 * test/run-tests.ts が本ファイルを読み込んで検査する。仕様会議第3回 P2・P3）。
 * アドオンの状態（mode/selfTabs等）は引数の state で渡す設計。
 * in-page関数（fillFunc等）はexecuteScriptで直列化注入されるため外部スコープを参照できず、
 * ここを参照させないこと（sudo境界照合はbackgroundで計算して結果のみ渡す）。
 */

var WRITE_CMDS = new Set([
  "tabs/open",
  "tabs/close",
  "tabs/activate",
  "tabs/navigate",
  "tabs/reload",
  "tabs/back",
  "tabs/forward",
  "page/click",
  "page/fill",
  "page/scroll",
]);

var WRITE_MODE_GUIDE =
  "書き込みツールはWRITE状態でのみ実行できます。Firefoxのrinkaアイコンをもう1回クリックしてWRITE（バッジW）にしてください";
var TARGET_GUIDE =
  "対象タブは書込み許可集合の外です。WRITE開始時に開いていたユーザータブを書き換えるには、そのタブを開いた状態で WRITE に入り直すか、rinkaに open_tab から開かせてください";
var ENTRY_ORIGIN_GUIDE =
  "このタブはWRITE突入時とは別のサイト（origin）へ移動しています。突入時タブはWRITEに入った時点のoriginに固定され、移動後の書込みは拒否されます（サイトをまたぐ遷移から入力欄を守るため）。このタブを書き込むにはWRITEに入り直すか、rinkaに open_tab から開かせてください";

function msg(e) {
  return e instanceof Error ? e.message : String(e);
}

function tabInfo(t) {
  return { tabId: t.id, url: t.url ?? "", title: t.title ?? "", active: t.active };
}

/** open/navigate のURL: http/https のみ・2048字上限（固定リミッタ）。 */
function requireHttpUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("url は空でない文字列で指定してください");
  if (!/^https?:\/\//i.test(raw)) throw new Error("url は http:// または https:// で始めてください（実測: " + raw + "）");
  if (raw.length > 2048) throw new Error("url が長すぎます（2048字上限）");
  return raw;
}

/** 書込み対象タブのURL: http/https のみ（内部ページへの書込みは固定拒否）。 */
function requireHttpTab(tab) {
  const u = tab.url ?? "";
  if (u === "about:blank" || u === "") {
    // 実機 2026-11-22: open_tab 直後は遷移コミット前なのでここに入る。固定拒否は不変だが案内を分ける
    throw new Error(
      "このタブはまだページの読込が完了していません（about:blank）。画面が表示されてから書き込んでください。" +
        "ずっとabout:blankのままなら外部サイトへの到達性（ネットワーク・DNS・プロキシ）の確認を。書込み先はhttp/httpsのタブのみです"
    );
  }
  if (!/^https?:\/\//i.test(u)) {
    throw new Error("内部ページへの書込みは固定拒否です: " + u + "（書込み先はhttp/httpsのタブのみ）");
  }
}

/** 一次modeガード＋対象ガード。open/activate は対象ガード外（開いた瞬間に自開タブ化／集合を広げない）。 */
function guardWrite(cmd, args, state) {
  if (state.mode !== "write") throw new Error(WRITE_MODE_GUIDE);
  if (cmd !== "tabs/open" && cmd !== "tabs/activate") {
    const t = typeof args.tabId === "number" && Number.isInteger(args.tabId) ? args.tabId : null;
    if (t === null) throw new Error("tabId は整数で指定してください");
    if (!state.selfTabs.has(t) && t !== state.entryActiveTabId) throw new Error(TARGET_GUIDE);
  }
}

/** URL文字列のorigin（scheme://host:port）。http(s)以外はnull（about:blank等のopaque originは比較対象にしない）。 */
function originOf(raw) {
  if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * 突入時タブのorigin固定（仕様会議第3回 会議決定2）。WRITE突入時に記録したoriginと
 * 書込み時点のタブURLのoriginが一致しなければ拒否する。自開タブはrinka自身が遷移先を
 * 選ぶため脅威モデルが違い、この検査の対象外（tabIdが突入時タブでなければ素通し）。
 * 現在URLがhttp(s)でないときは素通し（requireHttpTabが固定拒否するので二重に文言を出さない）。
 * 突入時originが未記録（http以外のタブで突入）のまま現在がhttp(s)なら拒否（fail-closed）。
 */
function requireEntryOrigin(tabId, tabUrl, state) {
  if (tabId !== state.entryActiveTabId) return;
  const current = originOf(tabUrl);
  if (current === null) return;
  if (state.entryActiveTabOrigin === null || current !== state.entryActiveTabOrigin) {
    throw new Error(ENTRY_ORIGIN_GUIDE);
  }
}

/**
 * sudo fillの境界照合: origin完全一致＋パス境界。startsWith不採用＝bank.example.evil.com型バイパス対策。
 * 空allowlistは全拒否（fail-closed。host側もRINKA_SUDO_FILL=1で空リストなら起動拒否にしてある）。
 * backgroundでこの純関数を呼び、結果の真偽だけをin-pageへ渡す（in-page関数は自己完結のため複製しない）。
 */
function sudoUrlAllowed(locHref, urls) {
  if (typeof locHref !== "string") return false;
  if (!Array.isArray(urls) || urls.length === 0) return false;
  let loc;
  try {
    loc = new URL(locHref);
  } catch {
    return false;
  }
  for (const raw of urls) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue; // 無効なURL欄は読み飛ばす（host側で検査済み。保険）
    }
    if (u.origin !== loc.origin) continue;
    const ap = u.pathname && u.pathname !== "" ? u.pathname : "/";
    const lp = loc.pathname && loc.pathname !== "" ? loc.pathname : "/";
    if (ap === "/" || lp === ap || lp.startsWith(ap.endsWith("/") ? ap : ap + "/")) return true;
  }
  return false;
}

globalThis.rinkaGuards = {
  WRITE_CMDS,
  WRITE_MODE_GUIDE,
  TARGET_GUIDE,
  ENTRY_ORIGIN_GUIDE,
  msg,
  tabInfo,
  requireHttpUrl,
  requireHttpTab,
  guardWrite,
  originOf,
  requireEntryOrigin,
  sudoUrlAllowed,
};
