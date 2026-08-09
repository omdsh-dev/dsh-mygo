# dsh-mygo 开发备忘录

> 记录“去掉权限核心、只保留 HMR 与插件管理”之后画过的饼、已经兑现的部分，
> 以及明确的“不做/暂不支持”边界。本文档随代码演进更新。

## 设计原则（重构后的定调）

- **只留两条主线**：HMR（generation/swap/staging/dispatch）与插件管理（安装/启停/卸载/替换/恢复）。
- **0 侵入**：mygo 直接使用宿主 API，不修改 dsh core（dsh-tools、dsh-host-webserver、storage 等保持原样）。
- **HMR 优先**：插件更新/替换走七步 replace 协议（capture → stage → swap → dispose），进程与进行中的 session 不重启。
- **显式不支持优于硬适配**：旧版工作区插件、依赖核心能力补丁的插件、无法纳入受管生命周期的插件，给出明确错误或标记，而不是把整个后端拖崩。

## 已实现（✓）

1. **HMR + 插件管理核心**：generation/swap/staging/dispatch、snapshots、sqlite registry、install / enable / disable / replace / uninstall / recover。
2. **零侵入 raw 接入**：`fromCordisPlugin` / `adoptRaw`、透明 facade（`on` / `inject` / `provide` / `tools` / `systemPrompt` / `httpServer` / `skills` / `commands` / `effect` / timer 拦截，其余透传宿主）。
3. **类插件（Service 子类）**：`adoptRaw` 识别类构造器，按 `new raw(ctx, config)` 挂载（token-meter / compact-basic 模式）。
4. **停用语义**：工具保持注册，dispatch 侧拦截并回报“插件已停用”。
5. **卸载语义**：uninstall tombstone（`status: uninstalled` + `tools[]`）持久化，重装前 `clearUninstallTombstone`；卸载后调用提示“插件不存在/已卸载”。
6. **unknown-tool 零侵入**：不改 dsh-tools，mygo 监听 `tools/execute` waterfall 拦截。
7. **启动支持检查 + 守卫桥接**：桥接动态导入 + `checkSupport`（入口形状 / requires 可用性），坏插件跳过挂载只记日志，后端照常启动。
8. **面板安装器（设置页）**：github / folder / archive 三种安装；`installDeps` 自动依赖 + 构建；`setup` 前置命令、`startCommand` 覆盖、`skipBuild`。
9. **外部应用模式**：独立 `mygo-apps` 根、启停（进程组）、卸载不同步标识（`syncUninstall: false`）、沙箱 `none` / `workspace`、操作审计 JSONL。
10. **远程更新**：GitHub 安装记录 `remote { url, ref, commit }`；扫描/检查更新（`git ls-remote`）；插件走 `updateRaw`（HMR 热替换，进程与 session 不重启），外部应用停 → 换码 → 恢复启动。
11. **mygo 自身更新**：`install.sh` 首次安装并写入 `~/.dsh/mygo-self.json`（远端 + commit）；检查更新包含 `dsh-mygo` 自身；更新时替换/重建 mygo/mygo-api/panel 并触发 Loader 热重载（受管插件由 recover() 恢复）。
12. **HTTP 桥**：`rawHttpBridge` 支持流式 `pipe` 与二进制 body（按 content-type 返回字节）；路由 view 注册时快照，卸载/替换时宿主 disposer 安全。
13. **显式不支持清单**：
    - 0804/0805 时代工作区插件（嵌套私有 `@deepseek-ai/dsh-*` + `workspace:` 协议）→ “版本过老，面板不支持直接安装”（dsh-working-activity）。
    - 依赖渲染器能力补丁的插件（split-panes 的 `SessionScope`、working-activity 的 webui patch）→ 待上游合入，面板不硬适配。
    - apply 内 `ctx.plugin` 组合子插件的插件（dsh-rewind）→ 明确报错“暂不支持”，激活失败干净回收，不再 fatal。
14. **medium-reset 适配**：0808/0809 storage-domain 无 `recovery: 'reset'` / `domain/reset` / `KvFacet.destroy`，注册表介质损坏 fail-loud（registry-domain 去 recovery、事件词表去 `domain/reset`、audit 去 `medium-reset`）。

## 画过但还没兑现（待办/饼）

- **通用修复（三层，从 dsh-sfw/tps/stickers 等失败收敛而来）**：
  1. facade 宿主透传通用化：tools / systemPrompt / commands / skills / httpServer 全部包成
     “已知成员走受管、未知成员 `ctx.get(服务)` 透传宿主”的 Proxy（tapIndex 已验证模式，未推广）；
  2. 构建环境通用化：npm 失败后用 checkout 的 pnpm 兜底（原生支持 `workspace:`/`link:`、
     prepare 能解析 workspace 类型），或把插件临时注册为 checkout workspace 包构建；
  3. 安装策略路由：按 manifest 特征自动选路（client half 无产物→build；workspace: 协议→pnpm；
     build 不可移植→prepare；宿主高级 API→透传+支持检查；实在不行→显式拒绝并给原因）。
- 外部应用沙箱 `strict` 档（目前只有 `none` / `workspace`）。
- systemd / launchd 自启托管、进程自启检测。
- apply 内 `ctx.plugin` 子插件组合的真实支持（把子挂载纳入 mygo 生命周期；目前显式拒绝）。
- 渲染器能力类插件在 0809 的适配（split-panes 补丁、working-activity、gomoku 缺 client half）。
- 事件词表生成 hook（`gen-cordis-catalog`）移植到 0809；README / i18n / 文档补齐。
- 旧受管权限 API 开发文档：**不写**（权限层已删，生态插件原生支持，不需要旧式权限 API 文档）。
- 明确不做：往 storage-domain 回补 medium-reset（与 0 侵入冲突）。

## 已知边界

- 0 侵入只保证 mygo 自身不改核心；生态插件若依赖核心能力补丁（如 `SessionScope`），需上游合入或显式标记不支持。
- 守卫桥接保护正常安装流程；Loader 层“行引用的包完全不存在”仍会失败（正常安装不会产生这种行）。
- 远程更新仅覆盖带 `remote` 记录的 GitHub 安装；folder / archive 安装按前提不参与。
