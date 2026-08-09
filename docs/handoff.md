# dsh-mygo Handoff（2026-08-09）

> 给下一位开发者的交接：现状、关键机制、已知坑、继续开发命令。

## 现状

- 目标 dsh：0809 快照（`test-r05En1cU`，本地工作树 `/home/rosen/workspace/dsh_dev/test-r05En1cU-0809`）。
- 运行实例：`dsh web --port 3080`，`DSH_HOME=/home/rosen/.dsh`，checkout = `~/.dsh/source/current` → `staging-20260809T193011Z`。
- 本仓库（dsh-mygo）在 commit 前：37 修改 + 23 删除（旧文档）+ 5 新增（memo、install.sh、2×tsdown.config、vendor/ 面板）。
- 测试：mygo + mygo-api 352/352（vitest；偶发 fork 超时是环境老毛病，非代码问题）。

## 关键机制（已实现）

- HMR + 插件生命周期：generation/swap/staging/dispatch、install/enable/disable/replace/uninstall/recover。
- 零侵入 raw 接入：`fromCordisPlugin` / `adoptRaw` / facade（类插件按 `new raw(ctx, config)`）。
- 停用/卸载语义：工具保持注册、dispatch 拦截；uninstall tombstone + `clearUninstallTombstone`。
- unknown-tool 零侵入：`tools/execute` waterfall。
- checkSupport + 守卫桥接：坏插件跳过挂载，不拖垮后端。
- 面板安装器：github/folder/archive；`installDeps`（剥 `link:`/`workspace:`，构建期注入 cordis/schemastery `file:` 依赖让 prepare 能过 tsc）；`setup` / `startCommand` / `skipBuild`。
- 外部应用模式：`mygo-apps` 独立根、进程组启停、sandbox none/workspace、`syncUninstall:false`、审计 JSONL。
- 远程更新：插件走 `updateRaw`（HMR）；外部应用停→换码→重启；mygo 自身自检/自更新（`~/.dsh/mygo-self.json` + Loader 热重载触发）。
- HTTP 桥：流式 pipe、二进制 body、路由 view 快照（卸载/替换安全）。
- 显式不支持：旧版工作区插件（0804/0805 + `workspace:`）、apply 内 `ctx.plugin` 组合（dsh-rewind）、渲染器能力补丁类（split-panes/working-activity）、缺 client half 的旧插件（gomoku UI）。

## 已知坑（踩过的）

- `vitest` 全量偶发 fork worker D 状态卡死（service.spec 被 timeout kill）：拆小串行跑。
- pnpm 包装脚本偶发 SIGILL：构建用 `node node_modules/typescript/bin/tsc`、`node node_modules/tsdown/dist/run.mjs` 直连。
- WSL 上 `next build`（dsh-club）偶发 SIGSEGV：跳过构建用 dev 模式，或重试。
- npm 不认 `link:`/`workspace:` 协议：面板已剥；prepare 期间缺 peer 类型：构建期注入 `file:` 依赖。
- 宿主服务高级成员（`httpServer.tapIndex` 等）facade 要透传：已知成员走受管，未知成员 `ctx.get(服务)` 转发（tapIndex 已做，其余服务未推广——见待办）。
- `dsh` launcher 用 tsx + tsconfig paths，安装端插件入口用 src/index.ts 时靠 tsx 解析。
- 重启 3080 别用 `pgrep -f 'bin.ts web --port 3080'` 的 kill 链（容易误杀当前 shell）：直接记录 PID 或先查再杀。

## 待办（详见 docs/development-memo.md）

- 三层通用修复：facade 透传通用化 / pnpm 构建兜底 / 安装策略路由。
- mygo 自更新“Loader 热重载后受管插件恢复”完整端到端验证（上次测试被手动卸载干扰，未验完）。
- 外部应用 sandbox `strict`、systemd/launchd 托管。
- 事件词表生成 hook 移植、README/i18n 补齐（旧文档已清，只留 README + memo + handoff）。

## 备份

- `/tmp/dsh-0809-to-dsh-backup.oy3nae`（0808 patch、genui、current 指向记录）
- `/tmp/dsh-0809-before-port.3gw0Xc`（0809 原始快照）
- `/tmp/dsh-mygo-steps/`（分步备份）

## 继续开发命令

```sh
# 常用变量
REPO=/home/rosen/workspace/dsh_dev/test-r05En1cU-0809
STAGE=/home/rosen/.dsh/source/staging-20260809T193011Z
MYGO=/home/rosen/workspace/dsh_dev/dsh-mygo

# 1) 改 mygo/mygo-api 后：类型检查 + 构建 + 测试
cd "$REPO"
node node_modules/typescript/bin/tsc -b packages/core/mygo-api packages/cordis/mygo --pretty false
node node_modules/tsdown/dist/run.mjs --config packages/core/mygo-api/tsdown.config.ts
node node_modules/tsdown/dist/run.mjs --config packages/cordis/mygo/tsdown.config.ts
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/mygo-api/tests packages/cordis/mygo/tests

# 2) 改面板后：构建
cd "$REPO/vendor/dsh-mygo-panel"
DSH_CHECKOUT="$REPO" node build.mjs

# 3) 同步 staging（运行实例）
rsync -a --delete --exclude node_modules "$REPO/packages/core/mygo-api/" "$STAGE/packages/core/mygo-api/"
rsync -a --delete --exclude node_modules "$REPO/packages/cordis/mygo/" "$STAGE/packages/cordis/mygo/"
rsync -a --delete "$REPO/vendor/dsh-mygo-panel/" "$STAGE/vendor/dsh-mygo-panel/"

# 4) 重启 3080（先记录 PID，别用 pgrep 链自杀）
OLD=$(pgrep -f 'bin.ts web --port 3080' | grep -v zsh | head -1)
[ -n "$OLD" ] && kill "$OLD"
cd /home/rosen && setsid -f nohup env DSH_HOME=/home/rosen/.dsh dsh web --port 3080 > /tmp/dsh-0809-3080.log 2>&1

# 5) 同步独立仓库（本仓库）
rsync -a --delete --exclude node_modules --exclude lib --exclude tsconfig.tsbuildinfo \
  "$REPO/packages/cordis/mygo/" "$MYGO/packages/cordis/mygo/"
rsync -a --delete --exclude node_modules --exclude lib --exclude tsconfig.tsbuildinfo \
  "$REPO/packages/core/mygo-api/" "$MYGO/packages/core/mygo-api/"
tar -C "$REPO/vendor/dsh-mygo-panel" --exclude=node_modules --exclude=lib -cf - . \
  | tar -C "$MYGO/vendor/dsh-mygo-panel" -xf -

# 6) 首次安装 / 自更新测试
cd "$MYGO" && ./install.sh          # DSH_CHECKOUT=... 可指定
# 自更新端到端：改 ~/.dsh/mygo-self.json 的 commit 为假值 → 面板检查更新 → POST /api/mygo/updates/mygo
```
