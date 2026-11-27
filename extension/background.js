/**
 * rinka — background.js（event page）。v2: 3状態トグル（OFF→READ→WRITE→OFF）。
 *
 * トグル = プロセスと権限の管理:
 *   OFF → READ : browser.runtime.connectNative("rinka") → Firefoxがhostをspawn →
 *                hostがHTTPを開き {t:"ready", port} を返す → バッジ ON
 *   READ→WRITE : ここからが書込み。対象ガード初期化（WRITE突入時のアクティブタブ1枚のみ書込み可に）
 *                バッジ W（赤）、hostへ {t:"mode", v:"write"} 通知、タイマー開始
 *   WRITE→READ : 自動（RINKA_WRITE_TIMEOUT_SECONDS 既定1800秒）またはFirefoxがhostをkillしたとき
 *   WRITE→OFF  : port.disconnect() → Firefoxがhostをkill（家規1を手順でなくOSが強制）
 *
 * host ←→ addon プロトコル:
 *   host→addon: {t:"req", id, cmd, args} / {t:"ready", port} / {t:"cfg", writeTimeoutSec}
 *   addon→host: {t:"resp", id, ok:bool, result|error}（大容量もこの1形。host側の32MBフレーム上限が防衛）
 *               / {t:"mode", v:"read"|"write"}
 *
 * ガード（仕様書v1.1 §3）:
 *   一次mode  : このファイル。WRITE_CMDS は mode==="write" でなければ拒否
 *   対象ガード: WRITE区間中にrinka自身がopen_tabした自開タブ（selfTabs）＋
 *               WRITE突入時のアクティブタブ1枚（entryActiveTabId）のみ書込み可。
 *               activate_tab は全タブ可だが対象集合を拡張しない。open_tabは自開タブになるので対象ガード外
 *   固定リミッタ: 書込み対象タブのURLはhttp/httpsのみ（about:/file:/chrome:/moz-extension:/
 *               data:/javascript:/view-source: の内部ページへの書込みは固定拒否）。
 *               open/navigate のURLもhttp/httpsのみ・2048字上限
 *   sudo: password欄は RINKA_SUDO_FILL が真で、かつ RINKA_SUDO_FILL_URLS（空=全許可）の
 *               境界照合（origin完全一致＋パス境界。startsWith不採用=bank.example.evil.comバイパス対策）
 *               に通るときだけin-pageで入力する
 *   二次mode  : host側（tools.ts の requireWriteMode、不整合への保険）
 *
 * page_click/page_fill/page_scroll は合成イベント（isTrusted:false）。
 * 検査するサイトは動かないことがある（既知限界として公開）。
 *
 * privateウィンドウは manifest の incognito:"not_allowed" により、このアドオンからは
 * 機械的に不可視（家規4の最強形）。履歴も history API 経由のみで生ファイルは触らない。
 */

// ページ本文は抽出時（in-page）に100k字で切る。バイト上限（RINKA_READ_MAX_BYTES）はhost側で1点強制

let port = null; // browser.runtime.Port
let live = false;
let mode = "read"; // "read" | "write" — host側modeガードと同一情報のaddon側一次
let writeTimeoutSec = 1800; // hostから {t:"cfg"} で上書きされる（RINKA_WRITE_TIMEOUT_SECONDS）
let writeTimer = null; // WRITE自動落ちタイマー
let selfTabs = new Set(); // WRITE区間中にrinkaがopen_tabした自開タブ
let entryActiveTabId = null; // WRITE突入時のアクティブタブ（1枚だけ特別に書込み可）

const WRITE_CMDS = new Set([
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

const WRITE_MODE_GUIDE =
  "書き込みツールはWRITE状態でのみ実行できます。Firefoxのrinkaアイコンをもう1回クリックしてWRITE（バッジW）にしてください";
const TARGET_GUIDE =
  "対象タブは書込み許可集合の外です。WRITE開始時に開いていたユーザータブを書き換えるには、そのタブを開いた状態で WRITE に入り直すか、rinkaに open_tab から開かせてください";

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
function guardWrite(cmd, args) {
  if (mode !== "write") throw new Error(WRITE_MODE_GUIDE);
  if (cmd !== "tabs/open" && cmd !== "tabs/activate") {
    const t = typeof args.tabId === "number" && Number.isInteger(args.tabId) ? args.tabId : null;
    if (t === null) throw new Error("tabId は整数で指定してください");
    if (!selfTabs.has(t) && t !== entryActiveTabId) throw new Error(TARGET_GUIDE);
  }
}

/** in-page実行の共通化。 throwingの代わりに {ok:false, error} を返すfuncと組で使う。 */
async function runInPage(tabId, func, args) {
  let results;
  try {
    results = await browser.scripting.executeScript({ target: { tabId }, func, args });
  } catch (e) {
    // Firefox MV3は host_permissions を optional 扱いにする。未許可のタブでは scripting が拒否される
    throw new Error(
      "in-page実行が拒否されました（" +
        msg(e) +
        "）。about:addons → rinka → 「権限」で「すべてのウェブサイトのデータへのアクセス」を許可してください"
    );
  }
  const r = results && results[0] && results[0].result;
  if (!r || typeof r !== "object" || r.ok !== true) {
    throw new Error(r && typeof r.error === "string" ? r.error : "in-page実行が失敗しました（詳細なし）");
  }
  return r;
}

// ---- in-page関数（自己完結・外部スコープに触らない。executeScriptで直列化されて注入される） ----

function clickFunc(target) {
  try {
    let el = null;
    if (typeof target.selector === "string") {
      const hits = document.querySelectorAll(target.selector);
      if (hits.length === 0) return { ok: false, error: "click: セレクタに一致する要素がありません: " + target.selector };
      if (hits.length > 1) return { ok: false, error: "click: セレクタが複数要素に一致します（一意にしてください）: " + target.selector };
      el = hits[0];
    } else {
      el = document.elementFromPoint(target.x, target.y);
      if (!el) return { ok: false, error: "click: 座標 (" + target.x + "," + target.y + ") に要素がありません" };
    }
    let element = el.tagName ? el.tagName.toLowerCase() : "?";
    if (el.id) element += "#" + el.id;
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    // 合成イベント（isTrusted:false）。検査するサイトは動かないことがある（既知限界）
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch { /* PointerEvent非対応環境 */ }
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch { /* 同上 */ }
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    return { ok: true, element };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function fillFunc(fields, sudoFill, sudoFillUrls) {
  try {
    const loc = new URL(location.href);
    // 境界照合: origin完全一致＋パス境界。startsWith不採用＝bank.example.evil.comバイパス対策
    function sudoUrlAllowed() {
      if (!Array.isArray(sudoFillUrls) || sudoFillUrls.length === 0) return true; // 空allowlistは全URL許可
      for (const raw of sudoFillUrls) {
        let u;
        try { u = new URL(raw); } catch { continue; }
        if (u.origin !== loc.origin) continue;
        const ap = u.pathname && u.pathname !== "" ? u.pathname : "/";
        const lp = loc.pathname && loc.pathname !== "" ? loc.pathname : "/";
        if (ap === "/" || lp === ap || lp.startsWith(ap.endsWith("/") ? ap : ap + "/")) return true;
      }
      return false;
    }
    const allowedInput = { "": true, text: true, search: true, email: true, url: true, tel: true, password: true, number: true };
    // パス1: 全欄を事前検査（1欄不合格で全欄不実行）
    const targets = [];
    for (const f of fields) {
      const hits = document.querySelectorAll(f.selector);
      if (hits.length === 0) return { ok: false, error: "fill: セレクタに一致する要素がありません: " + f.selector };
      if (hits.length > 1) return { ok: false, error: "fill: セレクタが複数要素に一致します: " + f.selector };
      const el = hits[0];
      const tag = el.tagName ? el.tagName.toLowerCase() : "";
      if (tag === "input") {
        const type = el.type || "text"; // 空typeは既定text
        if (!allowedInput[type]) return { ok: false, error: "fill: このinput種別は拒否です（type=" + type + "）: " + f.selector };
        if (type === "password" && sudoFill !== true) {
          return { ok: false, error: "fill: password欄への入力はRINKA_SUDO_FILL設定で許可されたときのみ可能です" };
        }
        if (type === "password" && !sudoUrlAllowed()) {
          return { ok: false, error: "fill: このURLはRINKA_SUDO_FILL_URLSの境界照合に通りません（origin完全一致＋パス境界）" };
        }
      } else if (tag === "textarea" || tag === "select") {
        if (tag === "select" && !Array.from(el.options).some((o) => String(o.value) === String(f.value))) {
          return { ok: false, error: "fill: selectにこの値のoptionがありません: " + f.selector };
        }
      } else {
        return { ok: false, error: "fill: 対象は input/textarea/select のみです: " + f.selector };
      }
      targets.push({ el, tag: tag === "input" ? el.type || "text" : tag, f });
    }
    // パス2: 実行（ここまで来たら全欄検査済み）
    const results = [];
    for (const t of targets) {
      const el = t.el;
      el.focus?.();
      el.value = t.f.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      results.push({ selector: t.f.selector, valueLength: t.f.value.length });
    }
    return { ok: true, fields: results };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function scrollFunc(direction, amount) {
  try {
    window.scrollBy(0, direction === "up" ? -amount : amount);
    return { ok: true, scrollY: window.scrollY };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// select選択肢の列挙。上限: 8select・各50option・各文字列60字（超分は「…」付きで切る。
// valueを切ったものはpage_fillのselect事前検査に通り得ないため、長い値は元のselectを絞って使う運用）
function selectsFunc(selector) {
  var MAX_SELECTS = 8;
  var MAX_OPTIONS = 50;
  var MAX_STR = 60;
  function cut(v) {
    var s = v === null || v === undefined ? "" : String(v);
    return s.length > MAX_STR ? s.slice(0, MAX_STR) + "…" : s;
  }
  try {
    var hits = Array.from(document.querySelectorAll(selector));
    var selects = hits.filter(function (el) { return el.tagName && el.tagName.toLowerCase() === "select"; });
    if (selects.length === 0) {
      return {
        ok: false,
        error:
          "selects: セレクタに一致するselect要素がありません: " + selector +
          (hits.length > 0 ? "（一致" + hits.length + "要素のうちselectは0。" : "（一致0要素。") +
          "selectを含むセレクタを指定してください）",
      };
    }
    var out = selects.slice(0, MAX_SELECTS).map(function (el, i) {
      var opts = Array.from(el.options || []);
      return {
        index: i,
        id: cut(el.id || ""),
        name: cut(el.name || ""),
        multiple: el.multiple === true,
        optionCount: opts.length,
        options: opts.slice(0, MAX_OPTIONS).map(function (o) {
          return { value: cut(o.value ?? ""), text: cut(o.text ?? ""), selected: o.selected === true };
        }),
      };
    });
    return { ok: true, selects: out };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ---- cmdハンドラ（READ系5 + WRITE系10） ----

async function handleReq(m) {
  const { cmd, args } = m;

  // ---- READ系（READ/WRITE両状態で可） ----
  if (cmd === "tabs/list") {
    const tabs = await browser.tabs.query({});
    return { tabs: tabs.map(tabInfo) };
  }
  if (cmd === "tabs/read") {
    const tab = await browser.tabs.get(args.tabId);
    let text;
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId: args.tabId },
        func: () => {
          const el = document.body;
          const text = el ? el.innerText : "";
          return text.length > 100000 ? text.slice(0, 100000) : text;
        },
      });
      text = results && results[0] && typeof results[0].result === "string" ? results[0].result : "";
    } catch (e) {
      // Firefox MV3は host_permissions を optional 扱いにする。未許可のタブでは scripting が拒否される
      throw new Error(
        "本文の取得が拒否されました（" +
          msg(e) +
          "）。about:addons → rinka → 「権限」で「すべてのウェブサイトのデータへのアクセス」を許可してください"
      );
    }
    return { tab: tabInfo(tab), text };
  }
  if (cmd === "tabs/capture") {
    if (typeof browser.tabs.captureTab !== "function") {
      // Firefox MV3は host権限が許可されるまで captureTab をAPIに生やさない（2026-11-22 実機で確認）
      throw new Error(
        "screenshotが実行できません: <all_urls> host権限が未許可です。about:addons → rinka → 「権限」で「すべてのウェブサイトのデータへのアクセス」を許可してください（1回だけ）"
      );
    }
    const tab = await browser.tabs.get(args.tabId);
    const dataUrl = await browser.tabs.captureTab(args.tabId);
    const b64 = String(dataUrl).split(",")[1] ?? "";
    return { tab: tabInfo(tab), base64: b64 };
  }
  if (cmd === "history/search") {
    const items = await browser.history.search({
      text: args.query,
      startTime: 0,
      maxResults: Math.min(args.limit, 1000),
    });
    const rows = items.map((it) => ({
      url: it.url ?? "",
      title: it.title ?? "",
      visitCount: it.visitCount ?? 0,
      lastVisit: typeof it.lastVisitTime === "number" ? new Date(it.lastVisitTime).toISOString() : null,
    }));
    rows.sort((a, b) => (b.lastVisit ?? "").localeCompare(a.lastVisit ?? ""));
    return { rows };
  }
  if (cmd === "selects/list") {
    const tab = await browser.tabs.get(args.tabId);
    const r = await runInPage(args.tabId, selectsFunc, [args.selector]);
    return { tab: tabInfo(tab), selects: r.selects };
  }

  // ---- WRITE系（一次modeガード＋対象ガード＋固定リミッタ） ----
  if (cmd === "tabs/open") {
    guardWrite(cmd, args);
    requireHttpUrl(args.url);
    const active = args.active !== false; // 既定true
    const tab = await browser.tabs.create({ url: args.url, active });
    selfTabs.add(tab.id); // 開いた瞬間に自開タブ＝書込み対象になる
    const info = tabInfo(tab);
    // Firefox既知挙動（MDN記載・2026-11-22実機で確認）: tabs.create 直後の Tab.url は遷移コミット前なので
    // about:blankを返す。open_tabのresp/監査の正本は「開こうとしたURL」。実コミット状態はlist_tabsで観察する
    if (info.url === "" || info.url === "about:blank") info.url = args.url;
    return { tab: info };
  }
  if (cmd === "tabs/close") {
    guardWrite(cmd, args);
    const tab = await browser.tabs.get(args.tabId); // 実行前採取（close後は二度と取れない。監査の正本）
    await browser.tabs.remove(args.tabId);
    selfTabs.delete(args.tabId);
    return { tab: tabInfo(tab) };
  }
  if (cmd === "tabs/activate") {
    guardWrite(cmd, args); // 対象ガード外: 全タブ切り替え可。ただし対象集合は広げない
    const tab = await browser.tabs.get(args.tabId);
    await browser.tabs.update(args.tabId, { active: true });
    return { tab: tabInfo(tab) };
  }
  if (cmd === "tabs/navigate") {
    guardWrite(cmd, args);
    requireHttpUrl(args.url);
    const tab = await browser.tabs.get(args.tabId);
    requireHttpTab(tab);
    await browser.tabs.update(args.tabId, { url: args.url });
    let tabAfter;
    try {
      tabAfter = tabInfo(await browser.tabs.get(args.tabId));
    } catch {
      tabAfter = { ...tabInfo(tab), url: args.url };
    }
    return { tab: tabInfo(tab), tabAfter };
  }
  if (cmd === "tabs/reload") {
    guardWrite(cmd, args);
    const tab = await browser.tabs.get(args.tabId);
    requireHttpTab(tab);
    await browser.tabs.reload(args.tabId, { bypassCache: args.bypassCache === true });
    return { tab: tabInfo(tab) };
  }
  if (cmd === "tabs/back" || cmd === "tabs/forward") {
    guardWrite(cmd, args);
    const tab = await browser.tabs.get(args.tabId);
    requireHttpTab(tab);
    await runInPage(args.tabId, cmd === "tabs/back" ? () => { history.back(); return { ok: true }; } : () => { history.forward(); return { ok: true }; }, []);
    return { tab: tabInfo(tab) };
  }
  if (cmd === "page/click") {
    guardWrite(cmd, args);
    const tab = await browser.tabs.get(args.tabId);
    requireHttpTab(tab);
    const target = typeof args.selector === "string" ? { selector: args.selector } : { x: args.x, y: args.y };
    const r = await runInPage(args.tabId, clickFunc, [target]);
    return { tab: tabInfo(tab), element: r.element };
  }
  if (cmd === "page/fill") {
    guardWrite(cmd, args);
    const tab = await browser.tabs.get(args.tabId);
    requireHttpTab(tab);
    const r = await runInPage(args.tabId, fillFunc, [
      args.fields,
      args.sudoFill === true,
      Array.isArray(args.sudoFillUrls) ? args.sudoFillUrls : [],
    ]);
    return { tab: tabInfo(tab), fields: r.fields };
  }
  if (cmd === "page/scroll") {
    guardWrite(cmd, args);
    const tab = await browser.tabs.get(args.tabId);
    requireHttpTab(tab);
    const r = await runInPage(args.tabId, scrollFunc, [args.direction, args.amount]);
    return { tab: tabInfo(tab), scrollY: r.scrollY };
  }

  throw new Error(`未知のcmd: ${cmd}`);
}

// ---- 状態とバッジ ----

function setBadge(state) {
  if (state === "write") {
    browser.action.setBadgeText({ text: "W" });
    browser.action.setBadgeBackgroundColor({ color: "#b91c1c" });
    return;
  }
  browser.action.setBadgeText({ text: state === "read" ? "ON" : "" });
  if (state === "read") browser.action.setBadgeBackgroundColor({ color: "#b45309" });
}

function sendMode(v) {
  if (port) {
    try { port.postMessage({ t: "mode", v }); } catch { /* host落ち。onDisconnectが後処理する */ }
  }
}

function resetWriteTimer() {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (mode === "write") {
    writeTimer = setTimeout(exitWriteToRead, writeTimeoutSec * 1000); // 書込みcmd毎にリセット
  }
}

/** WRITE→READ（自動落ち・host死亡時共通）。対象集合を消すので以後の書込みは自開タブも不可になる。 */
function exitWriteToRead() {
  mode = "read";
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  selfTabs.clear();
  entryActiveTabId = null;
  setBadge("read");
  sendMode("read");
}

async function enterWrite() {
  selfTabs.clear();
  entryActiveTabId = null;
  try {
    const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length > 0) entryActiveTabId = tabs[0].id; // 1枚だけ特別に書込み可
  } catch {
    // 取れなければ対象はrinka自開タブのみ（安全側）
  }
  mode = "write";
  setBadge("write");
  sendMode("write");
  resetWriteTimer();
}

async function onPortMessage(m) {
  if (!m || typeof m !== "object") return;
  if (m.t === "ready") {
    live = true;
    setBadge(mode === "write" ? "write" : "read");
    return;
  }
  if (m.t === "cfg") {
    // hostからのWRITE自動落ち設定（RINKA_WRITE_TIMEOUT_SECONDS。host側で1〜86400に検査済み。防御クランプ）
    if (typeof m.writeTimeoutSec === "number" && Number.isInteger(m.writeTimeoutSec) && m.writeTimeoutSec >= 1 && m.writeTimeoutSec <= 86400) {
      writeTimeoutSec = m.writeTimeoutSec;
    }
    if (mode === "write") resetWriteTimer();
    return;
  }
  if (m.t === "req") {
    const isWriteCmd = WRITE_CMDS.has(m.cmd);
    try {
      if (isWriteCmd && mode !== "write") {
        // 一次modeガード。ここを通らない書込みcmdはない
        throw new Error(WRITE_MODE_GUIDE);
      }
      const result = await handleReq(m); // 内部でもう一度mode/対象/リミッタを検査（二重だが独立に安全）
      port.postMessage({ t: "resp", id: m.id, ok: true, result });
    } catch (e) {
      port.postMessage({ t: "resp", id: m.id, ok: false, error: msg(e) });
    }
    // 書込みcmd毎に自動落ちタイマーをリセット（成否を問わず。呼び出しがある＝使っている）
    if (isWriteCmd) resetWriteTimer();
  }
}

function onDisconnect() {
  port = null;
  live = false;
  // hostプロセスはFirefoxにkillされる。WRITE状態なら二次的な落下処理（状態のみ初期化）
  mode = "read";
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  selfTabs.clear();
  entryActiveTabId = null;
  setBadge(false);
}

browser.action.onClicked.addListener(async () => {
  if (port) {
    if (mode === "read") {
      // READ→WRITE: 対象ガード初期化（WRITE突入時のアクティブタブ1枚のみ書込み可になる）
      await enterWrite();
      return;
    }
    // WRITE→OFF: Firefoxがhostプロセスをkillし、HTTPリスナーは消滅する
    port.disconnect();
    onDisconnect();
    return;
  }
  // OFF→READ: Firefoxがnative hostをspawnする
  port = browser.runtime.connectNative("rinka");
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(onDisconnect);
});
