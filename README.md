# 🐋 dsh-mygo

> 给 DSH 装上“受管插件”：HMR 热替换 + 完整插件生命周期，0 侵入。
> 名字致敬《BanG Dream! It's MyGO!!!!!》（迷途之子）——插件们各怀心思，
> 但总有一个地方会把它们聚在一起。

**版本：0.1.0 · 2026-08-09 快照**

mygo 是 DSH 的受管插件层：插件不再是裸的 Cordis 行，而是有安装/启停/卸载/替换/恢复语义、
能热替换（HMR）、坏插件不会拖垮后端的“受管对象”。权限核心已移除，只保留 HMR 与插件管理两条主线，
并通过透明 facade 直接用宿主 API——不需要改 dsh core。

## 版本要求（重要）

目标 dsh：**0809 快照**（`test-r05En1cU`）。

- 0808/0809 的 `storage-domain` 已移除 `recovery: 'reset'` / `domain/reset` / `KvFacet.destroy`：
  注册表介质损坏时 mygo **fail-loud**（打开报错，不会自动清库重建），人工删
  `~/.dsh/storages/registry.sqlite` 后重启即可。
- 0 侵入只对 mygo 自身成立：依赖 dsh 核心能力补丁的生态插件（如 split-panes 的 `SessionScope`、
  working-activity 的 webui patch）需要上游合入，mygo **显式不支持**，不会硬适配。

## 快速开始

首次安装直接用仓库里的 `install.sh`（自动复制包、接线 tsconfig、装依赖、写 profile 行、记录自身版本）：

```sh
git clone https://github.com/dsh-external/dsh-mygo.git
cd dsh-mygo
./install.sh                        # 自动定位 dsh checkout（或 DSH_CHECKOUT=/path/to/dsh ./install.sh）
```

也可以手动接线（等价的 profile patch 内容）：

```yaml
- id: dsh-mygo
  name: '@deepseek-ai/dsh-mygo'
  config:
    profile: web
- id: dsh-mygo-panel
  name: '@dsh-external/dsh-mygo-panel'
  config: {}
```

重启 `dsh web` 后，设置页会出现“受管插件”和“外部应用”两个分区：

- 插件安装：GitHub 仓库 / 本地文件夹 / zip·tar.gz；可勾选“自动安装依赖并构建”
  （`npm install` + 仓库 build，自动剔除 `link:`/`workspace:` 协议）
- 外部应用安装：独立进程（Electron/Next 等），带沙箱档位与“卸载不同步”标识
- 检查更新：远程（GitHub）安装的插件/应用可扫描远端 commit；插件更新走 **HMR 热替换**，
  进行中的 session 与进程不重启
- **mygo 自身更新**：检查更新里包含 `dsh-mygo` 自身（基于 `~/.dsh/mygo-self.json` 记录的远端与 commit）；
  更新时替换并重建 mygo/mygo-api/panel 源码，随后触发 Loader 热重载（受管插件由 recover() 恢复）

## 它能做什么

- **HMR 插件管理**：install / enable / disable / replace / uninstall / recover，七步替换协议
  （capture → stage → swap → dispose）
- **零侵入 raw 接入**：`fromCordisPlugin` / `adoptRaw` 直接把任意 Cordis 插件纳入管理，
  facade 拦截注册面（tools/systemPrompt/httpServer/skills/commands/effect/timers），其余透传宿主
- **类插件支持**：Service 子类（token-meter / compact-basic 模式）按 `new raw(ctx, config)` 挂载
- **停用/卸载语义**：停用后工具保持注册、dispatch 拦截回报；卸载持久化 tombstone，
  重装自动清除，卸载后调用提示“插件不存在/已卸载”
- **unknown-tool 零侵入**：不改 dsh-tools，监听 `tools/execute` waterfall 拦截
- **启动守卫**：桥接动态导入 + `checkSupport`（入口形状 / requires 可用性），坏插件跳过挂载只记日志
- **HTTP 桥**：流式 `pipe` 与二进制响应（按 content-type 返回字节），路由卸载/替换时 disposer 安全
- **外部应用模式**：独立 `mygo-apps` 根，进程组启停，沙箱 `none` / `workspace`，
  `syncUninstall: false` 标识 + 操作审计
- **远程更新**：记录安装 commit，`git ls-remote` 对比，插件走 `updateRaw` HMR 热替换

## 原生支持 / 显式不支持

| 插件类型 | 结论 |
|---|---|
| 标准 Cordis 函数 / `apply` 对象插件 | ✅ 原生支持 |
| Service 子类插件（类即插件） | ✅ 原生支持 |
| 带浏览器 client half 的插件 | ✅ 桥接投影进 client roster（需 `exports["./client"]` + `dshClient`） |
| 需要 npm 依赖 / 构建的插件 | ✅ `installDeps` 自动装依赖并构建 |
| 0804/0805 时代工作区插件（`workspace:` 协议） | ❌ “版本过老”，显式报错 |
| apply 内 `ctx.plugin` 组合子插件（如 dsh-rewind） | ❌ 暂不支持，明确报错、干净回收 |
| 依赖渲染器核心补丁的插件（split-panes / working-activity） | ❌ 待上游合入 |

## 开发

```sh
pnpm install
pnpm run typecheck   # tsc -b mygo-api + mygo
pnpm run test        # 352 tests（vitest）
```

目录：

- `packages/core/mygo-api`：Cordis-free 的上层插件契约（definePlugin / facade / PluginError / fake-env）
- `packages/cordis/mygo`：管理器（生命周期引擎 / dispatch / registry / 审计）
- `docs/development-memo.md`：开发备忘录（去权限层后的饼与已实现清单）

## Roadmap（已评估项）

| 方向 | 结论 |
|---|---|
| 外部应用模式（sandbox none/workspace、卸载不同步标识） | ✅ 已做 |
| 远程更新 + HMR 热替换 | ✅ 已做 |
| mygo 自身更新（检查 + Loader 热重载） | ✅ 已做 |
| 启动支持检查 + 守卫桥接 | ✅ 已做 |
| 类插件 / 零侵入 raw 接入 | ✅ 已做 |
| 旧受管权限 API 开发文档 | 不写（权限层已删，生态插件原生支持） |
| `ctx.plugin` 子插件组合的真实支持 | 不做（显式不支持） |
| storage-domain medium-reset 回补 | 不做（0 侵入冲突） |
| 外部应用 sandbox `strict` 档 / systemd·launchd 托管 | 待办 |
| 渲染器能力类插件的 0809 适配 | 待上游合入 |
| 通用修复：facade 宿主透传 / pnpm 构建兜底 / 安装策略路由 | 待办 |
| author-guide / catalog 等旧文档重写 | 待补（旧文档已清除） |

## 常见问题

- **装插件报“版本过老”？** 0804/0805 时代工作区插件（嵌套 `@deepseek-ai/dsh-*` + `workspace:` 协议），
  需要放进 dsh 源码仓库安装；请用作者的新版独立包。
- **装 dsh-rewind 报“暂不支持 ctx.plugin”？** 该插件在 apply 内组合 Service/工具子插件，
  mygo 暂不纳入生命周期；请作者改为直接注册或拆成独立插件。
- **后端起不来？** 先看日志：守卫桥接会跳过导入失败/不支持的插件；
  若日志出现“包完全不存在”的 Loader 错误，那是 patch 行引用了缺失包，正常安装流程不会产生。
- **注册表 sqlite 损坏？** 0808/0809 没有自动重建，删除 `~/.dsh/storages/registry.sqlite` 后重启。

---

License: MIT
