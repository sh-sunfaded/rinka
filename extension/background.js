/**
 * rinka — background.js（event page）。
 *
 * トグル = プロセス管理:
 *   ON : browser.runtime.connectNative("rinka") → Firefoxがhostをspawn → hostがHTTPを開き
 *        {t:"ready", port} を返す → バッジ点灯
 *   OFF: port.disconnect() → Firefoxがhostをkill → HTTPリスナー消滅（家規1を手順でなくOSが強制）
 *
 * host ←→ addon プロトコル:
 *   host→addon: {t:"req", id, cmd, args} / {t:"ready", port}
 *   addon→host: {t:"resp", id, ok:bool, result|error}（大容量もこの1形。host側の32MBフレーム上限が防衛）
 *
 * privateウィンドウは manifest の incognito:"not_allowed" により、このアドオンからは
 * 機械的に不可視（家規4の最強形）。履歴も history API 経由のみで生ファイルは触らない。
 */

// ページ本文は抽出時（in-page）に100k字で切る。バイト上限（RINKA_READ_MAX_BYTES）はhost側で1点強制

let port = null; // browser.runtime.Port
let live = false;

function tabInfo(t) {
  return { tabId: t.id, url: t.url ?? "", title: t.title ?? "", active: t.active };
}

async function handleReq(m) {
  const { cmd, args } = m;
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
          (e instanceof Error ? e.message : String(e)) +
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
  throw new Error(`未知のcmd: ${cmd}`);
}

function setBadge(on) {
  browser.action.setBadgeText({ text: on ? "ON" : "" });
  if (on) browser.action.setBadgeBackgroundColor({ color: "#b45309" });
}

async function onPortMessage(m) {
  if (!m || typeof m !== "object") return;
  if (m.t === "ready") {
    live = true;
    setBadge(true);
    return;
  }
  if (m.t === "req") {
    try {
      const result = await handleReq(m);
      port.postMessage({ t: "resp", id: m.id, ok: true, result });
    } catch (e) {
      port.postMessage({ t: "resp", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

function onDisconnect() {
  port = null;
  live = false;
  setBadge(false);
}

browser.action.onClicked.addListener(() => {
  if (port) {
    // OFF: Firefoxがhostプロセスをkillし、HTTPリスナーは消滅する
    port.disconnect();
    onDisconnect();
    return;
  }
  // ON: Firefoxがnative hostをspawnする
  port = browser.runtime.connectNative("rinka");
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(onDisconnect);
});
