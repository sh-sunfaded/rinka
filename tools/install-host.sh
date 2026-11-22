#!/usr/bin/env bash
# rinka tools/install-host.sh — native messaging host の登録を自動化（日常運用の入口）。
#
# 何をするか:
#   ~/.mozilla/native-messaging-hosts/rinka.json を生成する:
#     - path       = この作業コピーの rinka-host.sh への絶対path（手書きの /replace/me を廃止）
#     - allowed_extensions = extension/manifest.json の browser_specific_settings.gecko.id と同じ値
#                            （二重管理をやめて常にmanifestが正本。IDをGUID化したことで自動一致が重要）
#   既存の rinka.json があれば rinka.json.bak として1世代残す。
#
# 使い方（リポジトリのルートで）:
#   bash tools/install-host.sh
#
# 実行後の確認:
#   - FirefoxでrinkaをONにして接続できればOK。
#   - 事前に1回だけ about:addons → rinka → 権限 → 「すべてのウェブサイトのデータへの
#     アクセス」を許可する（署名済みxpiを恒久installした直後）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LAUNCHER="$ROOT/native-host/install/rinka-host.sh"
MANIFEST_SRC="$ROOT/native-host/install/rinka.json"
EXT_MANIFEST="$ROOT/extension/manifest.json"
DEST_DIR="${HOME}/.mozilla/native-messaging-hosts"
DEST="$DEST_DIR/rinka.json"

# ---- 前提検査 ----
[[ -f "$LAUNCHER" ]] || { echo "NG: launcherが見当たらない: $LAUNCHER" >&2; exit 1; }
if [[ ! -x "$LAUNCHER" ]]; then
  echo "NG: launcherに実行bitが無い（Firefoxがspawnできない）。" >&2
  echo "    ローカルで: git update-index --chmod=+x native-host/install/rinka-host.sh && git checkout -- native-host/install/rinka-host.sh" >&2
  echo "    または: chmod +x \"$LAUNCHER\"" >&2
  exit 1
fi
[[ -f "$EXT_MANIFEST" ]] || { echo "NG: extension/manifest.json が無い: $EXT_MANIFEST" >&2; exit 1; }
command -v node >/dev/null || { echo "NG: node が無い（rinka hostの実行に必要）" >&2; exit 1; }

GECKO_ID="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const id=m.browser_specific_settings.gecko.id; if(typeof id!=="string"||id.length===0){console.error("manifestにgecko.idが無い");process.exit(1)} console.log(id)' "$EXT_MANIFEST")"

# ---- 生成 ----
mkdir -p "$DEST_DIR"
if [[ -f "$DEST" ]]; then
  cp "$DEST" "$DEST.bak"
  echo "既存の rinka.json を rinka.json.bak に退避しました"
fi

node -e '
const fs = require("fs");
const out = {
  name: "rinka",
  description: "rinka: 自身のFirefoxをVibe MCPに繋ぐnative host",
  path: process.argv[1],
  type: "stdio",
  allowed_extensions: [process.argv[2]],
};
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
console.log("rinka.json を書きました:", process.argv[3]);
' "$LAUNCHER" "$GECKO_ID" "$DEST"

# ---- 書いたものを読み返して検査（信頼できない出力を残さない） ----
node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const fs = require("fs");
if (j.name !== "rinka" || j.type !== "stdio" || !Array.isArray(j.allowed_extensions) || !fs.existsSync(j.path)) {
  console.error("NG: 書いたrinka.jsonの検査に失敗"); process.exit(1);
}
console.log("検査OK: allowed_extensions =", j.allowed_extensions.join(", "));
console.log("path =", j.path);
' "$DEST"

# ---- トークン（無ければ案内だけで終わらない: 生成は1コマンド） ----
TOKEN_PATH="${RINKA_TOKEN_PATH:-$HOME/.config/rinka/token}"
if [[ ! -f "$TOKEN_PATH" ]]; then
  echo ""
  echo "トークンが無いので生成します: $TOKEN_PATH"
  bash "$LAUNCHER" token
fi

echo ""
echo "完了。次の一手:"
echo "  1. Firefox で署名済みxpiを恒久installしていること（なければ下記README「日常運用」節）"
echo "  2. about:addons → rinka → 権限 → すべてのウェブサイトのデータへのアクセスを許可（恒久install直後の1回だけ）"
echo "  3. ツールバーアイコンをクリックしてON（既定ポート8765はFunnelが転送）"
