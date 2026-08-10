# Changelog

## 0.2.0 · 2026-08-10 — 重构：HMR 语义、依赖体系、持久化、BOM

> 0.2.0 在 0.1.1 的基础上几乎重构了一切：HMR 从自建七步的 stage-first
> 改为对齐宿主 `fiber.update` 的 dispose-first（unload → load），取消了两轮
> 逐面特判补丁；把"权限核心删除后"的兼容性检查与插件间依赖从设计落成实现
> （Fabric 五级词汇、激活求解器、bundle 轨）；持久化后端无关化
> （mygo-rdb / store-provider / session 读取器）；安装器/面板大幅补全；
> 并新增 P4 BOM 依赖参考物。

### 核心：HMR 重写

- replace / adoptStatic 改为 **dispose-first**（先完整释放旧代，再应用新代），
  对齐 Cordis `fiber.update` 语义；settings namespace、webserver
  upgrade/fallback 这类全局 seat 注册不再需要 deferred 特判；
- 删除整套 deferred host-registration 机制（`StagedHostRegistration` /
  `registerHostRegistration` / `commitHostRegistrations` /
  `DEFERRED_HOST_REGISTRATION_METHODS`）；
- 失败回滚 `restoreIncumbent`（重新挂载旧代），配置预检前移，release 等待
  in-flight 事件结束后才放行；
- `adoptStatic` config-diff：同版本配置变化走热替换；面板配置保存写回桥接行，
  重启后配置不再回退；
- **行为变化**：replace 变成 unload → load；`immediate` 策略在存在 in-flight
  事件时会阻塞配置保存（无超时），`drain` 保持 30s 超时（超时在 unload 前，
  旧代安全）。

### 兼容性 / 插件依赖（0.2.0 方向 P1–P3）

- Fabric 五级依赖词汇 `depends / recommends / suggests / conflicts / breaks`
  + 传递闭包 + 约束链报告（P1 v2）；
- 激活求解器 `solveActivation`：required-by 连带启用、capability provider
  确定性选择、breaks 最小变更消解、plan 确认 UI（P2）；
- bundle 轨 `BundleRail`：profile manifest 原子读写、`dsh plugin` CLI 转发、
  companion 块、跨轨统一依赖图（P3）；
- 声明式 manifest v1：package.json `dsh.mygo` 段（entrypoints +
  compatibility）、`ctx.entrypoints` 聚合服务（按代撤回）、零依赖 semver
  匹配器（支持 `1.x` / `1.2.x` 通配）。

### 持久化

- **mygo-rdb** extension（基于 mygo 本体）：rdb（sqlite/postgres）注册表
  store + store-provider 组合行接管 + sqlite→rdb 自动迁移 + audit 迁入；
- session 读取器三层格式：jsonl（zstd 多帧）/ sqlite / rdb-postgres，
  字段投影 `extractFields`；
- 卸载自动接管（tombstone 落 rdb）、卸载 extension 自动回退内置 sqlite。

### 安装器 / 面板

- 官方 `.dsh-plugin` 仓库格式支持（入口定位 + 依赖安装 + 构建）；
- 配置模板与可读化校验（schemastery schema 描述 + 自动模板，解决
  "缺 config 死循环"）；
- 安装链路修复：`link:`/`workspace:` 剥离、pnpm 兜底、ESM 缓存绕过
  （`?mygo=<ts>`）、per-id 串行化；
- 卸载 tombstone 持久化、停用/卸载二次确认（卡片内展开）、host 副作用
  热撤销（WebUI 实时更新）；
- 配置助手：正经临时对话（continuable child session）、helper-only skill /
  工具面、排队 + 5min 超时自愈；
- 外部应用模式：独立 `mygo-apps` 根、进程组启停、`syncUninstall:false`、
  操作审计。

### facade 兼容面（生态实测驱动）

- 宿主事件桥：词汇外事件挂宿主 `on`/`once`、`prepend` 生效，随代撤销；
- HTTP 桥重写：`res.pipe`、`flushHeaders`、SSE 流式转发、req 异步迭代；
- 工具字段透传（`timeoutMs` / `isConcurrencySafe` / `finalizeContent`）、
  skills/commands 发布视图保留插件声明。

### P4 BOM（依赖参考物）

- `dsh.bom/v1` 导出：intent（版本区间）+ lock（精确版本/commit）双段，
  self/bridge/bundle/app 全轨，mygo 自身作为一等成员；
- 只读 `bom check`：missing / extra / drift / 约束违例链，零修改；
  `--target` 校验新插件声明是否落在生态带内；
- 极薄壳脚手架 `scripts/bom-scaffold.mjs`：离线生成新插件三文件骨架，
  `depends service:mygo-core` 自动取 BOM self 带；
- 版本事实动态化：`VERSION` 单源 + `mygo-self.json#version`，
  `MYGO_MANAGER_VERSION` 不再硬编码。

### 其他

- 远程更新/自更新（插件走 `updateRaw` HMR；mygo 自身 clone → 替换 → Loader
  热重载 → recover）；
- 显式不支持清单：旧工作区插件、依赖渲染器能力补丁的插件、apply 内
  `ctx.plugin` 组合子插件（dsh-rewind 等），给出明确错误而非拖崩后端；
- 开发备忘录与文档重写（旧受管权限 API 文档删除，README/memo/handoff 重写）。

### 升级注意（破坏性 / 行为变化）

- **HMR 语义**：replace 改为 unload → load；`immediate` 策略在 in-flight
  事件存在时会阻塞配置保存（无超时，建议升级前确认插件无长驻事件监听）；
- 每次重启后**第一次**配置保存会有一轮 Loader 重放收敛（旧版本遗留的
  `source:{type:'static'}` 注册表行被 quarantine，无害自愈）；
- mygo 版本事实来自 `mygo-self.json#version`：升级后需重跑 `install.sh`
  （或手动补 version 字段），否则依赖图/BOM 的 self 版本停留在回退值；
- 运行实例的 rdb 注册表依赖 PostgreSQL（mygo-pg / Docker Desktop），
  PG 不可用会 fail-loud（`registry backend self-check failed`）；
- 面板安装的静态插件配置现在写回桥接行；旧版本遗留的 static-source gens
  行会在恢复时 quarantine。

## 0.1.1 · 2026-08-09

- install.sh 修复：空 profile 占位覆盖、`set -e` 兜底、模块回退链接。

## 0.1.0 · 2026-08-09

- HMR 插件管理器：generation / swap / staging / dispatch，安装 / 启停 /
  卸载 / 替换 / 恢复；
- 外部应用模式、远程更新、首次安装脚本 install.sh。
