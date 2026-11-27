#!/usr/bin/env bash
# rinka tools/field-test.sh — 実機疎通のOS観察点を一括で回す検収スクリプト（curl + jq 要）。
#
# 使い方（FirefoxでrinkaをONにしてから）:
#   bash tools/field-test.sh               # 全観察点（OFF確認は対話）
#   SKIP_IDLE=1 bash tools/field-test.sh   # 30秒放置（event page観察）を飛ばす
#
# 差し替え可能な検査URL（example.comが到達不能な環境向け）:
#   RINKA_FT_URL      既定 https://example.com/   open_tab/page_click用（<a>が1点だけのページであること）
#   RINKA_FT_URL2     既定 https://example.org/   navigate_tab用
#   RINKA_FT_FORM_URL 既定 https://httpbin.org/forms/post  page_fill用（[name=custname]/[name=custtel]があること）
#   FT_WAIT           既定 15  読込コミット待ちの上限秒
#
# 見る点: initialize / tools/list(15) / list_tabs / 401 / screenshot（活性・非活性・サイズ）/
#         read_tab wrapper / search_history / event page持続 / READ時書込み拒否 /
#         v3マクロ（READ静的検査dryRun・READ読み取り実行・READ書込みstep停止・WRITE open→close往復・監査受付1行）/
#         WRITE書込み10本往復（open→click→back→forward→navigate→reload→scroll→fill→close）/
#         対象ガード（非活性ユーザータブ拒否）/ 監査write:1+url / OFF＝プロセス消失 / 監査本文なし
# WRITE自動落ちの観察はRINKA_WRITE_TIMEOUT_SECONDS（既定1800）が絡むためFirefox起動時に
# 環境変数を与える必要がある。デフォルトでは検証しない（下の注記参照）。

set -uo pipefail

URL="${RINKA_URL:-http://127.0.0.1:8765/mcp}"
TOKEN_FILE="${RINKA_TOKEN_PATH:-$HOME/.config/rinka/token}"
AUDIT="${RINKA_AUDIT_PATH:-$HOME/.config/rinka/audit.jsonl}"
FT_URL="${RINKA_FT_URL:-https://example.com/}"
FT_URL2="${RINKA_FT_URL2:-https://example.org/}"
FT_FORM_URL="${RINKA_FT_FORM_URL:-https://httpbin.org/forms/post}"
FT_WAIT="${FT_WAIT:-15}"
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

tab_url() { # tab_url <tabId> → そのタブのURL（list_tabs実測。取れなければ空）
  local r ur
  r="$(req '{"jsonrpc":"2.0","id":90,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}')"
  ur="$(jq -r --argjson t "$1" '[.result.structuredContent.tabs[] | select(.tabId == $t)][0].url // ""' <<<"$r" 2>/dev/null || echo '')"
  printf '%s' "$ur"
}

wait_tab_http() { # wait_tab_http <tabId> [tries] → タブがhttp(s)に遷移するまで待つ（既定15回×1秒）
  local i u
  for ((i = 0; i < ${2:-$FT_WAIT}; i++)); do
    u="$(tab_url "$1")"
    [[ "$u" == http* ]] && return 0
    sleep 1
  done
  return 1
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
[[ "$N" == "15" ]] && ok "tools/list: 15ツール（読み取り4＋書込み10＋マクロ1）" || { fail "tools/listが15ツールでない($N)"; head_ "$R"; }

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

# ---- 11. v2: READ状態での書込み拒否（一次/二次modeガード） ----
echo ""
R="$(req "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"tools/call\",\"params\":{\"name\":\"open_tab\",\"arguments\":{\"url\":\"$FT_URL\"}}}")"
_JQX_FALLBACK=''
WERR="$(j "$R" -r '.result.content[0].text // empty')"
if [[ "$WERR" == *"WRITE"* ]]; then
  ok "READ時のopen_tabは拒否: ${WERR:0:70}…"
else
  fail "READ時のopen_tabが拒否されていない"; head_ "$R"
fi

# ---- 11m. v3: READ状態でのrun_macro dryRun（既定true=静的検査のみ。READでも通る） ----
R="$(req '{"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"run_macro","arguments":{"name":"field-dry","steps":[{"call":"list_tabs","args":{}},{"call":"search_history","args":{"query":"github","limit":3}}]}}}')"
_JQX_FALLBACK=''
DRY="$(j "$R" -r '.result.structuredContent.dryRun // empty')"
if [[ "$DRY" == "true" ]]; then
  ok "run_macro dryRun（既定true）: READでも静的検査は通る（steps=$(j "$R" '.result.structuredContent.steps | length')件・実行はしない）"
else
  fail "run_macro dryRunがREADで通らない"; head_ "$R"
fi

# ---- 11m'. v3: READ状態で読み取りstepのみのマクロ実行（modeガードはステップ毎なのでREADでも実行可） ----
R="$(req '{"jsonrpc":"2.0","id":25,"method":"tools/call","params":{"name":"run_macro","arguments":{"name":"field-read","dryRun":false,"steps":[{"call":"list_tabs","args":{}}]}}}')"
_JQX_FALLBACK=''
MOK="$(j "$R" '.result.structuredContent.ok')"
MTABS="$(j "$R" '.result.structuredContent.tabs | length')"
if [[ "$MOK" == "true" ]]; then
  ok "run_macro（READ・読み取りstep）: ok=true・末尾list_tabs=${MTABS}枚"
else
  fail "run_macroの読み取りstep実行がREADで失敗"; head_ "$R"
fi

# ---- 11m''. v3: READ状態で書込みstepのマクロ実行 → stepFailedで即停止（modeガードはステップ毎） ----
R="$(req "{\"jsonrpc\":\"2.0\",\"id\":26,\"method\":\"tools/call\",\"params\":{\"name\":\"run_macro\",\"arguments\":{\"name\":\"field-guard\",\"dryRun\":false,\"steps\":[{\"call\":\"open_tab\",\"tab\":\"t1\",\"args\":{\"url\":\"$FT_URL\"}}]}}}")"
_JQX_FALLBACK=''
GSTOP="$(j "$R" -r '.result.structuredContent.stoppedReason // empty')"
GERR="$(j "$R" -r '.result.structuredContent.steps[0].error // empty')"
if [[ "$GSTOP" == "stepFailed" && "$GERR" == *"WRITE"* ]]; then
  ok "READ時のマクロ書込みstepはstepFailed停止: ${GERR:0:60}…"
else
  fail "READ時のマクロ書込みstepが弾かれていない（stoppedReason=$GSTOP）"; head_ "$R"
fi

# ---- 12. v2: WRITE区間（対話: ここで1回クリックして追加で書込み状態へ） ----
echo ""
read -r -p "Firefoxのrinkaボタンをもう1回クリックしてWRITE（バッジW・赤）にしてEnter: "
R="$(req '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}')"
_JQX_FALLBACK='[]'
TABS2="$(j "$R" -c '.result.structuredContent.tabs')"
BG2="$(jq '[.[] | select(.active != true)][0].tabId' <<<"$TABS2" 2>/dev/null || echo '')"

# 12a. open_tab（自開タブになる）
R="$(req "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"tools/call\",\"params\":{\"name\":\"open_tab\",\"arguments\":{\"url\":\"$FT_URL\"}}}")"
_JQX_FALLBACK=''
SELF_ID="$(j "$R" '.result.structuredContent.tab.tabId')"
if [[ -n "$SELF_ID" && "$SELF_ID" != "null" ]]; then
  SELF_URL="$(j "$R" -r '.result.structuredContent.tab.url')"
  ok "open_tab: tabId=$SELF_ID $SELF_URL（自開タブ＝以降の書込み対象）"
else
  fail "open_tabが失敗"; head_ "$R"; SELF_ID=""
fi

# 12a'. 読込コミット待ち（Firefoxのtabs.create直後は遷移前なのでabout:blank。コミット前に書くと固定リミッタで弾かれる）
LOADED=0
if [[ -n "$SELF_ID" && "$SELF_ID" != "null" ]]; then
  echo "  $FT_URL の読込コミット待ち（最大${FT_WAIT}秒）…"
  if wait_tab_http "$SELF_ID"; then
    ok "open先タブの読込確認: $(tab_url "$SELF_ID")"
    LOADED=1
  else
    fail "自開タブがhttp URLに遷移しない: [$(tab_url "$SELF_ID")]（$FT_URL への到達性を確認: DNS/プロキシ/ファイアウォール。代替URLは RINKA_FT_URL で差し替え）"
    echo "  [info] 読込未コミットなのでclick/back/forward/navigate/reload/scroll/fillは省略（mode・対象ガードはこのログで検証済み）"
  fi
fi

# 12b. page_click（<a> が1点だけのページ想定。FT_URL差し替え時はセレクタ一意性の確認を）
if [[ "$LOADED" == "1" ]]; then
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":13,\"method\":\"tools/call\",\"params\":{\"name\":\"page_click\",\"arguments\":{\"tabId\":$SELF_ID,\"selector\":\"a\"}}}")"
  EL="$(j "$R" -r '.result.structuredContent.element // empty')"
  [[ -n "$EL" ]] && ok "page_click('a'): element=$EL" \
                  || { fail "page_clickが失敗"; head_ "$R"; }
fi

# 12c. go_back / go_forward（直前の遷移履歴を使う）
if [[ "$LOADED" == "1" ]]; then
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":14,\"method\":\"tools/call\",\"params\":{\"name\":\"go_back\",\"arguments\":{\"tabId\":$SELF_ID}}}")"
  [[ "$(j "$R" '.result.structuredContent.tab.tabId')" == "$SELF_ID" ]] && ok "go_back: 応答OK" || { fail "go_backが失敗"; head_ "$R"; }
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":15,\"method\":\"tools/call\",\"params\":{\"name\":\"go_forward\",\"arguments\":{\"tabId\":$SELF_ID}}}")"
  [[ "$(j "$R" '.result.structuredContent.tab.tabId')" == "$SELF_ID" ]] && ok "go_forward: 応答OK" || { fail "go_forwardが失敗"; head_ "$R"; }
fi

# 12d. navigate_tab（tabAfterは遷移直後のスナップショット。コミット前ならlist_tabs再照会で刈り取り）
if [[ "$LOADED" == "1" ]]; then
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":16,\"method\":\"tools/call\",\"params\":{\"name\":\"navigate_tab\",\"arguments\":{\"tabId\":$SELF_ID,\"url\":\"$FT_URL2\"}}}")"
  AFT="$(j "$R" -r '.result.structuredContent.tabAfter.url // empty')"
  if [[ "$AFT" != *"$FT_URL2"* ]]; then
    sleep 2
    AFT2="$(tab_url "$SELF_ID")"
    if [[ "$AFT2" == *"$FT_URL2"* ]]; then
      AFT="$AFT2（list_tabs再照会: resp採取がコミット前だった）"
    fi
  fi
  [[ "$AFT" == *"$FT_URL2"* ]] && ok "navigate_tab: tabAfter=$AFT" || { fail "navigate_tabのtabAfterが不正"; head_ "$R"; }
fi

# 12e. reload_tab
if [[ "$LOADED" == "1" ]]; then
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":17,\"method\":\"tools/call\",\"params\":{\"name\":\"reload_tab\",\"arguments\":{\"tabId\":$SELF_ID,\"bypassCache\":true}}}")"
  [[ "$(j "$R" '.result.structuredContent.tab.tabId')" == "$SELF_ID" ]] && ok "reload_tab(bypassCache=true): 応答OK" || { fail "reload_tabが失敗"; head_ "$R"; }
fi

# 12f. page_scroll down/up（scrollY実測）
if [[ "$LOADED" == "1" ]]; then
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":18,\"method\":\"tools/call\",\"params\":{\"name\":\"page_scroll\",\"arguments\":{\"tabId\":$SELF_ID,\"direction\":\"down\",\"amount\":600}}}")"
  SY="$(j "$R" '.result.structuredContent.scrollY')"
  [[ -n "$SY" && "$SY" != "null" ]] && ok "page_scroll(down): scrollY=$SY" || { fail "page_scroll(down)が失敗"; head_ "$R"; }
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":19,\"method\":\"tools/call\",\"params\":{\"name\":\"page_scroll\",\"arguments\":{\"tabId\":$SELF_ID,\"direction\":\"up\",\"amount\":10000}}}")"
  SY="$(j "$R" '.result.structuredContent.scrollY')"
  [[ -n "$SY" && "$SY" != "null" ]] && ok "page_scroll(up): scrollY=$SY" || { fail "page_scroll(up)が失敗"; head_ "$R"; }
fi

# 12g. 対象ガード: WRITE開始時に開いていた非活性ユーザータブへの書込みは拒否
if [[ -n "$BG2" && "$BG2" != "null" && -n "$SELF_ID" ]]; then
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":20,\"method\":\"tools/call\",\"params\":{\"name\":\"page_scroll\",\"arguments\":{\"tabId\":$BG2,\"direction\":\"down\",\"amount\":100}}}")"
  _JQX_FALLBACK=''
  TERR="$(j "$R" -r '.result.content[0].text // empty')"
  if [[ "$TERR" == *"書込み許可集合の外"* ]]; then
    ok "対象ガード: ユーザータブ(tabId=$BG2)へのpage_scrollは拒否"
  else
    fail "対象ガードが効いていない（ユーザータブに書けてしまった可能性）"; head_ "$R"
  fi
else
  echo "  [info] 非活性タブが無いので対象ガードの実験は省略"
fi

# 12h. page_fill: フォームに2欄一括入力（フォーム先が落ちなら手動観察に格下げ）
FILL_J=""
if [[ "$LOADED" == "1" ]]; then
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":21,\"method\":\"tools/call\",\"params\":{\"name\":\"navigate_tab\",\"arguments\":{\"tabId\":$SELF_ID,\"url\":\"$FT_FORM_URL\"}}}")"
  AFT="$(j "$R" -r '.result.structuredContent.tabAfter.url // empty')"
  if ! wait_tab_http "$SELF_ID" 10; then
    echo "  [info] フォーム先（$FT_FORM_URL）が読込未コミット。page_fillは手動観察に格下げ"
  else
    R="$(req "{\"jsonrpc\":\"2.0\",\"id\":22,\"method\":\"tools/call\",\"params\":{\"name\":\"page_fill\",\"arguments\":{\"tabId\":$SELF_ID,\"fields\":[{\"selector\":\"[name=custname]\",\"value\":\"rinka実機テスト\"},{\"selector\":\"[name=custtel]\",\"value\":\"09000000000\"}]}}}")"
    F_N="$(j "$R" '.result.structuredContent.fields | length')"
    if [[ "$F_N" == "2" ]]; then
      ok "page_fill: 2欄一括入力（custname/custtel on $AFT）"
      echo "  ※ Firefox側のタブで入力欄が埋まっているか目視確認を（合成イベントなので送信は押さない）"
    else
      echo "  [info] page_fillが2欄でない($F_N)。フォーム先が落ちていれば手動観察に格下げ: $(head -c 120 <<<"$R" | tr '\n' ' ')"
    fi
  fi
fi

# 12h'. v3: run_macro（WRITE・dryRun:false）: open_tab→close_tab のラベル往復を実行
#   ※ マクロ内にopen_tab直後のpage_scrollを入れない理由: tabs.create直後は遷移コミット前
#      （about:blank）なので固定リミッタに確実に弾かれる。マクロに待ちステップはないため、
#      実機観察はコミット状態に依存しない open→close 往復で取る（page直書きは単体工具で既に観察済み）。
R="$(req "{\"jsonrpc\":\"2.0\",\"id\":27,\"method\":\"tools/call\",\"params\":{\"name\":\"run_macro\",\"arguments\":{\"name\":\"field-macro\",\"dryRun\":false,\"steps\":[{\"call\":\"open_tab\",\"tab\":\"ft\",\"args\":{\"url\":\"$FT_URL\",\"active\":false}},{\"call\":\"close_tab\",\"tab\":\"ft\",\"args\":{}}]}}}")"
_JQX_FALLBACK=''
WOK="$(j "$R" '.result.structuredContent.ok')"
WSTEPS="$(j "$R" '.result.structuredContent.steps | length')"
WTABS="$(j "$R" '.result.structuredContent.tabs | length')"
if [[ "$WOK" == "true" && "$WSTEPS" == "2" ]]; then
  ok "run_macro（WRITE実行）: open_tab→close_tab往復 ok=true（steps=2・末尾list_tabs=${WTABS}枚）"
else
  fail "run_macroのWRITE実行が失敗（ok=$WOK steps=$WSTEPS）"; head_ "$R"
fi

# 12i. close_tab: 自開タブを閉じて原状復帰
if [[ -n "$SELF_ID" && "$SELF_ID" != "null" ]]; then
  R="$(req "{\"jsonrpc\":\"2.0\",\"id\":23,\"method\":\"tools/call\",\"params\":{\"name\":\"close_tab\",\"arguments\":{\"tabId\":$SELF_ID}}}")"
  CLOSED_URL="$(j "$R" -r '.result.structuredContent.tab.url // empty')"
  [[ -n "$CLOSED_URL" ]] && ok "close_tab($SELF_ID): 実行前URL=$CLOSED_URL（監査の正本として応答に残る）" \
                          || { fail "close_tabが失敗"; head_ "$R"; }
fi

# 12j. 監査に書込み記録（write:1 + 実行前URL）
if [[ -f "$AUDIT" ]]; then
  if grep -q '"write":1' "$AUDIT"; then
    ok "監査にwrite:1あり（直近の書込み: $(grep '"write":1' "$AUDIT" | tail -1 | head -c 160)…）"
  else
    fail "監査にwrite:1が無い"
  fi
  # 12j'. v3: run_macro受付1行（家規5: 名前・ステップ数・dryRunのみ。steps本文は書かない）
  if grep -q '"tool":"run_macro"' "$AUDIT"; then
    ok "監査にrun_macro受付1行あり: $(grep '"tool":"run_macro"' "$AUDIT" | tail -1 | head -c 160)…"
    if grep '"tool":"run_macro"' "$AUDIT" | grep -q '{"call"'; then
      fail "監査のrun_macro行にsteps本文相当が混入している"
    fi
  else
    fail "監査にrun_macro受付行が無い"
  fi
fi

# 12k. 補足: WRITE自動落下の観察法（Firefox起動時に限る）
echo "  [info] WRITE自動落ちの観察は RINKA_WRITE_TIMEOUT_SECONDS=20 でFirefoxを起動し直し、"
echo "         WRITEのまま放置して20秒後にreadが弾かれることで見る（このスクリプトの外の一手順）"

# ---- 13. OFF＝プロセス消失（家規1・対話） ----
echo ""
read -r -p "Firefoxのrinkaボタンをもう1回クリックしてOFFにしてEnterを押してください: "
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
