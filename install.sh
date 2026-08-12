#!/usr/bin/env bash
#
# dsh-mygo 首次安装脚本：把 mygo / mygo-api / mygo-panel / BOM 脚手架装进一个
# dsh 0809/0810 checkout，接线 tsconfig 与 web profile，并记录“已安装版本”供检查更新使用。
#
# 用法：
#   ./install.sh                          # 自动定位 dsh checkout（dsh 命令 / ~/.dsh/source/current）
#   DSH_CHECKOUT=/path/to/dsh ./install.sh
#   DSH_HOME=/path/to/home ./install.sh   # 默认 ~/.dsh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MYGO_URL="$(git -C "$HERE" config --get remote.origin.url 2>/dev/null || true)"
MYGO_URL="${MYGO_URL:-https://github.com/dsh-external/dsh-mygo.git}"
MYGO_COMMIT="$(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo unknown)"
MYGO_REF="HEAD"

# ---- 1. 定位 dsh checkout ---------------------------------------------------
resolve_checkout() {
  if [ -n "${DSH_CHECKOUT:-}" ]; then
    printf '%s\n' "$DSH_CHECKOUT"
    return
  fi
  if command -v dsh >/dev/null 2>&1; then
    local launcher
    launcher="$(readlink -f "$(command -v dsh)" 2>/dev/null || command -v dsh)"
    local dir="${launcher%/bin/dsh}"
    if [ -f "$dir/packages/client/tsdown.client.ts" ]; then
      printf '%s\n' "$dir"
      return
    fi
  fi
  printf '%s\n' "${HOME}/.dsh/source/current"
}

CHECKOUT="$(resolve_checkout)"
if [ ! -f "$CHECKOUT/packages/client/tsdown.client.ts" ] \
  || [ ! -d "$CHECKOUT/vendor/cordis" ] \
  || [ ! -d "$CHECKOUT/packages/core/session" ]; then
  echo "错误：$CHECKOUT 不是有效的 dsh 0809/0810 checkout（缺少 packages/client/tsdown.client.ts / vendor/cordis / packages/core/session）" >&2
  exit 1
fi
echo "==> 目标 dsh checkout: $CHECKOUT"

# ---- 2. 复制包（排除 node_modules / lib / 构建缓存 / .git） -----------------
copy_pkg() {
  local src="$1" dst="$2"
  mkdir -p "$dst"
  tar -C "$src" --exclude=node_modules --exclude=lib --exclude=tsconfig.tsbuildinfo --exclude=.git -cf - . \
    | tar -C "$dst" -xf -
}

echo "==> 复制 mygo / mygo-api / mygo-panel"
copy_pkg "$HERE/packages/core/mygo-api" "$CHECKOUT/packages/core/mygo-api"
copy_pkg "$HERE/packages/cordis/mygo" "$CHECKOUT/packages/cordis/mygo"
copy_pkg "$HERE/vendor/dsh-mygo-panel" "$CHECKOUT/vendor/dsh-mygo-panel"
if [ -f "$CHECKOUT/vendor/cordis/package.json" ] \
  && grep -q '"name": "@deepseek-ai/cordis"' "$CHECKOUT/vendor/cordis/package.json" 2>/dev/null; then
  echo "==> checkout 已内置 @deepseek-ai/cordis（0811+），跳过 dev 别名复制"
else
  copy_pkg "$HERE/vendor/cordis-alias" "$CHECKOUT/vendor/cordis-alias"
fi

# ---- 3. tsconfig 接线 --------------------------------------------------------
node - "$CHECKOUT/tsconfig.base.json" <<'NODE'
const fs = require('node:fs')
const path = process.argv[2]
let text = fs.readFileSync(path, 'utf8')
const inserts = [
  ['        "./packages/hooks/*/src/invariant.ts",\n        "./packages/cordis/*/src/invariant.ts",',
   '        "./packages/hooks/*/src/invariant.ts",'],
  ['        "./packages/hooks/*/src",\n        "./packages/cordis/*/src",',
   '        "./packages/hooks/*/src",'],
]
let changed = false
for (const [wanted, anchor] of inserts) {
  if (text.includes(wanted)) continue
  if (!text.includes(anchor)) {
    console.error(`tsconfig.base.json: 未找到锚点 ${anchor.trim()}`)
    process.exit(1)
  }
  text = text.replace(anchor, wanted)
  changed = true
}
if (changed) fs.writeFileSync(path, text)
NODE

node - "$CHECKOUT/tsconfig.host.json" <<'NODE'
const fs = require('node:fs')
const path = process.argv[2]
let text = fs.readFileSync(path, 'utf8')
const inserts = [
  ['    "packages/typert/generator/tests/fixtures/**",\n    "packages/cordis/mygo/tests/fixtures/**",',
   '    "packages/typert/generator/tests/fixtures/**",'],
  ['    { "path": "./packages/core/scope" },\n    { "path": "./packages/core/mygo-api" },',
   '    { "path": "./packages/core/scope" },' ],
  ['    { "path": "./packages/self-modification/repository-plugin" },\n    { "path": "./packages/cordis/mygo" },',
   '    { "path": "./packages/self-modification/repository-plugin" },' ],
  ['    { "path": "./packages/self-modification/tool-cordis" },\n    { "path": "./packages/cordis/mygo" },',
   '    { "path": "./packages/self-modification/tool-cordis" },' ],
]
let changed = false
const missing = []
for (const [wanted, anchor] of inserts) {
  if (text.includes(wanted)) {
    changed = true
    continue
  }
  if (!text.includes(anchor)) {
    missing.push(anchor.trim())
    continue
  }
  text = text.replace(anchor, wanted)
  changed = true
}
if (missing.length > 0 && !changed) {
  console.error(`tsconfig.host.json: 未找到锚点 ${missing.join(' / ')}`)
  process.exit(1)
}
if (changed) fs.writeFileSync(path, text)
NODE

# ---- 4. pnpm install ---------------------------------------------------------
if command -v pnpm >/dev/null 2>&1; then
  echo "==> pnpm install（$CHECKOUT）"
  (cd "$CHECKOUT" && pnpm install)
else
  echo "警告：PATH 上没有 pnpm，跳过 pnpm install；请安装 pnpm 后手动执行" >&2
fi

# ---- 4.5 已构建 checkout：重新编译 mygo（源码刚被更新） ---------------------
if [ -f "$CHECKOUT/packages/core/mygo-api/lib/index.js" ]; then
  echo "==> 检测到已构建 checkout，重新编译 mygo / mygo-api"
  (cd "$CHECKOUT" \
    && node node_modules/typescript/bin/tsc -b packages/core/mygo-api packages/cordis/mygo \
    && node node_modules/tsdown/dist/run.mjs --config packages/core/mygo-api/tsdown.config.ts \
    && node node_modules/tsdown/dist/run.mjs --config packages/cordis/mygo/tsdown.config.ts) \
    || echo "警告：mygo 重编失败，请稍后手动 pnpm run build" >&2
fi

# ---- 5. web profile 行 -------------------------------------------------------
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PATCH="$DSH_HOME_DIR/profiles/$PROFILE/cordis.patch.yml"
mkdir -p "$(dirname "$PATCH")"

MYGO_BLOCK="$(cat <<EOF
# --- dsh-mygo managed installs (generated by install.sh; do not edit) ---
- id: storage-domain
  config:
    backend: json
    routes:
      plugin_registry_${PROFILE}: sqlite
- insert:
    - id: storage-sqlite
      name: '@deepseek-ai/dsh-storage-sqlite'
      config:
        path: !!js dshHomePath('storages/registry.sqlite')
        journalMode: wal
    - id: dsh-mygo
      name: '@deepseek-ai/dsh-mygo'
      config:
        profile: ${PROFILE}
    - id: dsh-mygo-panel
      name: '@dsh-external/dsh-mygo-panel'
      config: {}
# --- end dsh-mygo managed installs ---
EOF
)"

if ! grep -q -- '- id: dsh-mygo' "$PATCH"; then
  # 空占位（不存在 / 全注释 / 只有 []）直接覆盖成单个 YAML 文档，
  # 否则会把 [] 和新增行拼成两个文档导致 web 启动解析失败。
  body="$(sed '/^[[:space:]]*#/d;/^[[:space:]]*$/d' "$PATCH" 2>/dev/null || true)"
  if [ ! -f "$PATCH" ] || [ -z "$body" ] || [ "$body" = "[]" ]; then
    printf '%s\n' "$MYGO_BLOCK" > "$PATCH"
  else
    printf '\n%s\n' "$MYGO_BLOCK" >> "$PATCH"
  fi
  echo "==> 已写入 profile 行：$PATCH"
else
  echo "==> profile 已有 dsh-mygo 行，跳过"
fi

# ---- 5.5 模块回退链接（$DSH_HOME/profiles/node_modules 扁平回退） -------------
# web 启动会 healing 出 dsh 应用闭包的链接，但 mygo/mygo-api/storage-sqlite/panel
# 不在闭包里，必须显式补链接，否则 profile 行里的包名解析不到。
FALLBACK="$DSH_HOME_DIR/profiles/node_modules"
mkdir -p "$FALLBACK/@deepseek-ai" "$FALLBACK/@dsh-external"
ln -sfn "$CHECKOUT/packages/cordis/mygo" "$FALLBACK/@deepseek-ai/dsh-mygo"
ln -sfn "$CHECKOUT/packages/core/mygo-api" "$FALLBACK/@deepseek-ai/dsh-mygo-api"
ln -sfn "$CHECKOUT/packages/storage/storage-sqlite" "$FALLBACK/@deepseek-ai/dsh-storage-sqlite"
ln -sfn "$CHECKOUT/vendor/dsh-mygo-panel" "$FALLBACK/@dsh-external/dsh-mygo-panel"
echo "==> 已写入模块回退链接：$FALLBACK"

# ---- 6. 记录 mygo 自身版本（供检查更新） -------------------------------------
SELF_STATE="$DSH_HOME_DIR/mygo-self.json"
MYGO_VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo unknown)"
printf '{"url":"%s","ref":"%s","commit":"%s","version":"%s","installedAt":%s}\n' \
  "$MYGO_URL" "$MYGO_REF" "$MYGO_COMMIT" "$MYGO_VERSION" "$(date +%s)" > "$SELF_STATE"
echo "==> 已记录 mygo 版本：$SELF_STATE（$MYGO_VERSION @ $MYGO_COMMIT）"

# ---- 6.5 BOM 目录与脚手架（P4 依赖参考物） -----------------------------------
BOMS_DIR="$DSH_HOME_DIR/mygo-boms"
mkdir -p "$BOMS_DIR"
if [ -f "$HERE/scripts/bom-scaffold.mjs" ]; then
  cp "$HERE/scripts/bom-scaffold.mjs" "$BOMS_DIR/bom-scaffold.mjs"
  chmod +x "$BOMS_DIR/bom-scaffold.mjs"
  echo "==> 已安装 BOM 脚手架：$BOMS_DIR/bom-scaffold.mjs"
fi

# ---- 7. 构建面板（可选） ------------------------------------------------------
if [ -f "$CHECKOUT/vendor/dsh-mygo-panel/build.mjs" ]; then
  echo "==> 构建 mygo-panel"
  (cd "$CHECKOUT/vendor/dsh-mygo-panel" && DSH_CHECKOUT="$CHECKOUT" node build.mjs) \
    || echo "警告：面板构建失败（可能 client 库未构建），可稍后手动重试" >&2
fi

echo
echo "安装完成。下一步："
echo "  1. 构建 dsh（如尚未构建）：cd $CHECKOUT && pnpm run build；已构建的 checkout 会自动重编 mygo"
echo "  2. 重启：dsh web"
echo "  3. 打开设置页查看“受管插件 / 外部应用”，或运行 dsh web 后直接使用"
echo "  4. 检查 mygo 自身更新：面板 → 检查更新"
echo "  5. 导出 BOM 依赖参考物：POST /api/mygo/bom/export（生成 $DSH_HOME_DIR/mygo-boms/$PROFILE/dsh.bom.{json,md}）"
echo "  6. 新插件脚手架：node $DSH_HOME_DIR/mygo-boms/bom-scaffold.mjs <id> --bom $DSH_HOME_DIR/mygo-boms/$PROFILE/dsh.bom.json"
