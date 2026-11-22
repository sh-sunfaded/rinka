#!/usr/bin/env bash
# rinka tools/ts-style-check.sh — 構文規約をgrepで機械検査する（exit 0=規約どおり）。
#
# 規約（tech-profile より）:
#   - const アロー関数と type 中心（function宣言・interfaceで書かない）
#   - any / as断言 / 非null断言 / 空 catch / Date.now 禁止
#   - 決定性: 時刻の直参照は index.ts の時計注入点だけ許可
# 対象: native-host/src test/run-tests.ts tools/build-xpi.ts
# 注意: 非null断言(!)は文法的に誤検出が多いためgrep対象外（レビューで見る）。
#   コメント行（// か * 始まり）は除外する。
set -u

cd "$(dirname "$0")/.." || exit 1
fail=0

# codecheck <EREPattern> <description> [除外grep...]
codecheck() {
  local pat="$1"; shift
  local desc="$1"; shift
  local out
  out="$(grep -rEn -- "$pat" native-host/src test tools/build-xpi.ts 2>/dev/null | grep -Ev ':[[:space:]]*(//|\*)' || true)"
  local excl
  for excl in "$@"; do
    out="$(echo "$out" | { grep -Ev -- "$excl" || true; })"
  done
  if [[ -n "$out" ]]; then
    echo "[NG] $desc"
    echo "$out"
    fail=1
  fi
}

codecheck '^[[:space:]]*(export[[:space:]]+)?(async[[:space:]]+)?function[[:space:]]' "function宣言（constアローで書く）"
codecheck '(^|[^A-Za-z])interface[[:space:]]' "interface（typeで書く）"
codecheck ':[[:space:]]*any\b|as[[:space:]]+any\b' "明示any"
codecheck '\bas[[:space:]]+[A-Za-z_]' "as断言（as const を含む。型はガード/typeで表す）"
codecheck 'Date\.now' "Date.now（時刻は注入する）"
codecheck 'new[[:space:]]+Date' "new Date（時計は index.ts のwallClock注入点のみ）" '^native-host/src/index\.ts:'
codecheck 'catch[[:space:]]*(\([A-Za-z_$][A-Za-z0-9_$]*\))?[[:space:]]*\{[[:space:]]*\}' "空catch（握るなら握り痕をstderrに残す）"

if [[ "$fail" -eq 0 ]]; then
  echo "[OK] ts-style-check: 規約違反 0件（src/test/build-xpiともfunction宣言・interface・any・as断言・Date系直参照・空catchなし）"
  exit 0
fi
echo "[NG] ts-style-check: 上記の規約違反を直してからcommit/pushすること"
exit 1
