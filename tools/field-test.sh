#!/usr/bin/env bash
# rinka tools/field-test.sh — 実機疎通のOS観察点を一括で回す検収スクリプト（curl + jq 要）。
#
# 使い方（FirefoxでrinkaをONにしてから）:
#   bash tools/field-test.sh               # 全観察点（OFF確認は対話）
#   SKIP_IDLE=1 bash tools/field-test.sh   # 30秒放置（event page観察）を飛ばす
#
# 見る点: initialize / tools/list / list_tabs / 401 / screenshot（活性・非活性・サイズ）/
#         read_tab wrapper / search_history / event page持続 / OFF＝プロセス消失 / 監査本文なし

set -uo pipefail

URL="${RINKA_URL:-http://127.0.0.1:8765/mcp}"
TOKEN_FILE="${RINKA_TOKEN_PATH:-$HOME/.config/rinka/token}"
AUDIT="${RINKA_AUDIT_PATH:-$HOME/.config/rinka/audit.jsonl}"
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
FAILED=0

ok()   { printf '  [OK] %s\n' "$1"; }
fail() { printf '  [NG] %s\n' "$1"; FAILED=$((FAILED + 1)); }
head_() { head -c 200 <<<"$1" | tr '\n' ' '; printf '\n'; }

req() { # req <json> → 応答本文（接続断は空文字）
  curl -sS -X POST "$URL" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$1" 2>/dev/null || true
}

j() { # j <json> [jqオプション…] <filter> → そのJSONに適用（失敗は代替値）
  local json="$1"; shift
  jq "$@" 2>/dev/null <<<"$json" || echo "$_JQX_FALLBACK"
}

command -v curl >/dev/null || { echo "curl が必要です"; exit 64; }
command -v jq  >/dev/null || { echo "jq が必要です"; exit 64; }
[[ -n "$TOKEN" ]] || { echo "トークンが読めません: $TOKEN_FILE"; exit 64; }

echo "== rinka 実機検収: $URL =="

# ---- 1. initialize ----
R="$(req '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}')"
_JQX_FALLBACK='""'
NAME="$(j "$R" -r '.result.serverInfo.name // empty')"
[[ "$NAME" == "rinka" ]] && ok "initialize: serverInfo.name=rinka" || { fail "initialize応答が不正"; head_ "$R"; }

# ---- 2. tools/list ----
R="$(req '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
_JQX_FALLBACK=0
N="$(j "$R" '.result.tools | length')"
[[ "$N" == "4" ]] && ok "tools/list: 4ツール" || { fail "tools/listが4ツールでない($N)"; head_ "$R"; }

# ---- 3. list_tabs（活性と非活性のIDを採る） ----
R="$(req '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}')"
_JQX_FALLBACK='[]'
TABS="$(j "$R" -c '.result.structuredContent.tabs')"
NT="$(jq 'length' <<<"$TABS" 2>/dev/null || echo 0)"
if [[ "$NT" -gt 0 ]]; then
  ok "list_tabs: ${NT}枚"
  ACTIVE_ID="$(jq '[.[] | select(.active == true)][0].tabId' <<<"$TABS")"
  BG_ID="$(jq '[.[] | select(.active != true)][0].tabId' <<<"$TABS")"
  echo "  activeTabId=$ACTIVE_ID  backgroundTabId=$BG_ID"
else
  fail "list_tabsでタブが取れない"; head_ "$R"; ACTIVE_ID=""; BG_ID=""
fi

# ---- 4. Bearer無しは401（家規2） ----
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" -H 'Content-Type: application/json' -d '{}' || true)"
[[ "$CODE" == "401" ]] && ok "Bearer無し → 401" || fail "Bearer無しの応答が $CODE（401想定）"

# ---- 5. screenshot: 活性タブ（サイズ実測＝メッセージ上限観察） ----
_JQX_FALLBACK=0
LEN=0
if [[ -n "$ACTIVE_ID" ]]; then
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"screenshot\",\"arguments\":{\"tabId\":$ACTIVE_ID}}}")"
  LEN="$(j "$R" -r '.result.structuredContent.pngBase64 // "" | length')"
  if [[ "$LEN" -gt 0 ]]; then
    BYTES=$((LEN * 3 / 4))
    ok "screenshot(活性): base64 ${LEN}字 ≈ ${BYTES}B を1メッセージで移送"
    (( LEN > 524288 )) && echo "  ※ 512KB超の単一メッセージ（chunk廃止の実測点として記録に値する）"
  else
    fail "screenshot(活性)が取れない"; head_ "$R"
  fi
fi

# ---- 6. screenshot: 非活性タブ（captureTab観察） ----
if [[ -n "$BG_ID" && "$BG_ID" != "null" ]]; then
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"screenshot\",\"arguments\":{\"tabId\":$BG_ID}}}")"
  LEN2="$(j "$R" -r '.result.structuredContent.pngBase64 // "" | length')"
  [[ "${LEN2:-0}" -gt 0 ]] && ok "screenshot(非活性tabId=$BG_ID): ${LEN2}字（非活性も撮れる）" \
                        || { fail "非活性タブの撮影に失敗"; head_ "$R"; }
else
  echo "  背景タブが無いので非活性撮影は省略"
fi

# ---- 7. read_tab: untrusted wrapper確認 ----
if [[ -n "$ACTIVE_ID" ]]; then
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"read_tab\",\"arguments\":{\"tabId\":$ACTIVE_ID}}}")"
  _JQX_FALLBACK=''
  TXT="$(j "$R" -r '.result.structuredContent.content // empty')"
  if [[ "$TXT" == '<rinka-page-content untrusted="true">'* ]]; then
    ok "read_tab: rinka-page-contentで包装（内容${#TXT}字）: $(head -c 80 <<<"$TXT" | tr '\n' ' ')"
  else
    fail "read_tabのwrapperが無い/内容が空"; head_ "$R"
  fi
fi

# ---- 8. search_history ----
R="$(req '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"search_history","arguments":{"query":"github","limit":5}}}')"
_JQX_FALLBACK=-1
ROWS="$(j "$R" '.result.structuredContent.rows | length')"
[[ "${ROWS:-0}" -gt 0 ]] && ok "search_history('github'): rows=${ROWS}" \
                       || echo "  [info] search_history rows=${ROWS}（'github'が履歴に無いだけの可能性）"

# ---- 9. event page持続（放置して再応答） ----
if [[ "${SKIP_IDLE:-0}" == "1" ]]; then
  echo "  SKIP_IDLE=1 で省略"
else
  echo "  ${IDLE:-30}秒放置します…"
  sleep "${IDLE:-30}"
  R="$(req '{"jsonrpc":"2.0","id":8,"method":"ping"}')"
  _JQX_FALLBACK=''
  P="$(j "$R" -r '.result')"
  [[ -n "$P" ]] && ok "放置後もping応答（event pageはport接続中も存続）" \
              || { fail "放置後に応答なし（event pageが死んだ疑い）"; head_ "$R"; }
fi

# ---- 10. 監査ログ（家規5: 本文なし・引数あり） ----
if [[ -f "$AUDIT" ]]; then
  echo "  --- tail -2 ---"
  tail -2 "$AUDIT" | sed 's/^/  /'
  if grep -qE '"(pngBase64|content)"\s*:' "$AUDIT"; then
    fail "監査ログにpngBase64/content相当の語がある"
  else
    ok "監査に本文様フィールドなし"
  fi
  [[ -f "$AUDIT.1" ]] && echo "  ローテーション: ${AUDIT}.1 あり"
else
  echo "  監査ログがまだ無い: $AUDIT"
fi

# ---- 11. OFF＝プロセス消失（家規1・対話） ----
echo ""
read -r -p "FirefoxのrinkaボタンをOFFにしてEnterを押してください: "
if curl -s -o /dev/null --max-time 3 -X POST "$URL" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":9,"method":"ping"}' 2>/dev/null; then
  fail "まだ繋がる（プロセスが消えていない）"
else
  ok "接続拒否 = OFF = プロセス消失"
fi

echo ""
if [[ "$FAILED" -eq 0 ]]; then
  echo "判定: 全観察点OK"
  exit 0
else
  echo "判定: ${FAILED}件のNG（上の[NG]行を報告に貼ること）"
  exit 1
fi
