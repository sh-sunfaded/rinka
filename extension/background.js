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
 *   addon→host: {t:"resp", id, ok:bool, result|error}
 *               {t:"chunk", id, part} （スクリーンショットbase64の512KB分割。respで締める）
 *
 * privateウィンドウは manifest の incognito:"not_allowed" により、このアドオンからは
 * 機械的に不可視（家規4の最強形）。履歴も history API 経由のみで生ファイルは触らない。
 */

const CH = 512 * 1024; // 1 chunk は 512KB まで（Native Messaging 上限対策）

let port = null; // browser.runtime.Port
let live = false;

function tabInfo(t) {
  return { tabId: t.id, url: t.url ?? "", title: t.title ?? "", active: t.active };
}

async function handleReq(m) {
  const { id, cmd, args } = m;
  try {
    if (cmd === "tabs/list") {
      const tabs = await browser.tabs.query({});
      return { tabs: tabs.map(tabInfo) };
    }
    if (cmd === "tabs/read") {
      const tab = await browser.tabs.get(args.tabId);
      const results = await browser.scripting.executeScript({
        target: { tabId: args.tabId },
        func: (maxChars) => {
          const el = document.body;
          const text = el ? el.innerText : "";
          return text.length > maxChars ? text.slice(0, maxChars) : text;
        },
        args: [args.maxChars],
      });
      const text = results && results[0] && typeof results[0].result === "string" ? results[0].result : "";
      return { tab: tabInfo(tab), text };
    }
    if (cmd === "tabs/capture") {
      const tab = await browser.tabs.get(args.tabId);
      const dataUrl = await browser.tabs.captureTab(args.tabId);
      const b64 = String(dataUrl).split(",")[1] ?? "";
      for (let i = 0; i < b64.length; i += CH) {
        port.postMessage({ t: "chunk", id, part: b64.slice(i, i + CH) });
      }
      return { tab: tabInfo(tab) }; // base64本体はchunk送り。host側で合成
    }
    if (cmd === "history/search") {
      const items = await browser.history.search({
        text: args.query,
        startTime: 0,
        maxResults: Math.min(args.limit, 1000),
      });
      const rows = items
        .map((it) => ({
          url: it.url ?? "",
          title: it.title ?? "",
          visitCount: it.visitCount ?? 0,
          lastVisit: typeof it.lastVisitTime === "number" ? new Date(it.lastVisitTime).toISOString() : null,
        }))
        .sort((a, b) => (a.lastVisit ?? "").localeCompare(b.lastVisit ?? "") * -1);
      return { rows };
    }
    throw new Error(`未知のcmd: ${cmd}`);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
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
