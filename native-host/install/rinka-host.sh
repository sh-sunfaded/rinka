#!/usr/bin/env bash
# rinka native host launcher（Firefoxからspawnされる）
#
# 使い方:
#   rinka-host.sh              … host起動（Firefoxが使う。stdin/stdoutはNative Messaging素）
#   rinka-host.sh token        … ~/.config/rinka/token に0600で32字トークンを生成
#   rinka-host.sh check [URL]  … 接続点検。正トークン+許可Origin（chat.mistral.ai）で
#                                pingを撃ち、応答から原因を1秒で断定する（要 curl）:
#                                200/202=hostは正常（Vibe Work側の登録を見直す）
#                                401=トークン不一致 / 403=Origin/funnel経路
#                                404=URLが/mcpに届かない / 接続不能=host/funnel落ち
#                                URL省略時は http://$RINKA_HOST:$RINKA_PORT/mcp
#                                （funnel経由は https://<tailnet>.ts.net/mcp を渡す）
#
# Node 22（--experimental-strip-types）必須。tsx等の依存ゼロ。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RINKA_TOKEN_PATH="${RINKA_TOKEN_PATH:-$HOME/.config/rinka/token}"

if [[ "${1:-}" == "token" ]]; then
  mkdir -p "$(dirname "$RINKA_TOKEN_PATH")"
  head -c 32 /dev/urandom | base64 > "$RINKA_TOKEN_PATH"
  chmod 600 "$RINKA_TOKEN_PATH"
  echo "rinka: トークンを $RINKA_TOKEN_PATH に生成しました（0600）"
  exit 0
fi

if [[ "${1:-}" == "check" ]]; then
  # host/portは config.ts と同じ既定（127.0.0.1 / 8765）。::1 はURL組み立てのためだけ括る。
  rhost="${RINKA_HOST:-127.0.0.1}"
  if [[ "$rhost" == *:* ]]; then rhost="[$rhost]"; fi
  rurl="${2:-http://${rhost}:${RINKA_PORT:-8765}/mcp}"

  # トークン: env RINKA_TOKEN > RINKA_TOKEN_PATH のファイル（config.ts の loadToken と同じ順）
  if [[ -n "${RINKA_TOKEN:-}" ]]; then
    rtok="$RINKA_TOKEN"
    rsrc="環境変数 RINKA_TOKEN"
  else
    if [[ ! -f "$RINKA_TOKEN_PATH" ]]; then
      echo "rinka: check → トークンファイルがありません（$RINKA_TOKEN_PATH）。rinka-host.sh token で生成してください"
      exit 1
    fi
    rtok="$(tr -d ' \t\r\n' < "$RINKA_TOKEN_PATH")"
    rsrc="$RINKA_TOKEN_PATH"
  fi

  # 正トークン+許可Originで ping を撃つ。応答コードだけで切る（本文は読まない）。
  curl_rc=0
  rstatus="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
    -X POST \
    -H "Authorization: Bearer ${rtok}" \
    -H 'Origin: https://chat.mistral.ai' \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' \
    "$rurl" 2>/dev/null)" || curl_rc=$?

  if [[ "$curl_rc" -eq 127 ]]; then
    echo "rinka: check → curl が見つかりません。インストールしてください"
    exit 1
  fi
  if [[ "$curl_rc" -ne 0 ]]; then
    echo "rinka: check → $rurl へ接続できません（curl終了コード ${curl_rc}）＝ host/funnel落ち"
    echo "  トグルがOFFならONに。funnel経由なら tailscale funnel 8765 の状態を確認"
    exit 1
  fi
  case "$rstatus" in
    200|202)
      echo "rinka: check → ${rstatus}（正常）。host・トークン・Originは通っています"
      echo "  繋がらないならVibe Work側の登録（URL・Bearer）を見直してください"
      ;;
    401)
      echo "rinka: check → 401。hostは稼働中ですがトークンが違います（${rsrc} とhost側の鍵の食い違い。token再生成後にhostをspawnし直していない等）"
      exit 1
      ;;
    403)
      echo "rinka: check → 403。Origin/funnel経路の問題です（funnel URLの誤り・リスナーが現行hostでない疑い）"
      exit 1
      ;;
    404)
      echo "rinka: check → 404。URLが POST /mcp に届いていません（URL末尾の /mcp を確認）"
      exit 1
      ;;
    *)
      echo "rinka: check → 想定外の応答 ${rstatus}。~/.config/rinka/audit.jsonl を確認してください"
      exit 1
      ;;
  esac
  exit 0
fi

exec node --experimental-strip-types --no-warnings "$HERE/../src/index.ts"
