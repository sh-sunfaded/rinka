#!/usr/bin/env bash
# rinka native host launcher（Firefoxからspawnされる）
#
# 使い方:
#   rinka-host.sh              … host起動（Firefoxが使う。stdin/stdoutはNative Messaging素）
#   rinka-host.sh token        … ~/.config/rinka/token に0600で32字トークンを生成
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

exec node --experimental-strip-types --no-warnings "$HERE/../src/index.ts"
