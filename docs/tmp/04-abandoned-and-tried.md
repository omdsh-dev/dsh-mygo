# 已遗弃、已撤销与已试错

本文记录已经发生的历史动作。它不提出未来遗弃方案，也不把当前仍存在的代码写成已遗弃。

## 1. 状态词

| 状态 | 本文含义 |
| --- | --- |
| 已退役 | 当前仓库规则或提交明确宣布删除/退役，对应主实现已从当前树移除 |
| 做过后撤销 | 历史提交加入过，后续提交明确回滚或替换 |
| 实验/Spike | 文件或提交自身使用 spike、实验性、启发式等标记 |
| 提案未应用 | 当前仓库保留设计或 patch，文件明确写不在本工作区 apply |
| 迁移残留 | 主路径已经迁移，当前源码或文档仍保留旧名称、状态文件或兼容引用 |

历史文档中的测试结果只作为“该文档当时声称做过什么”的记录，不作为本次当前正确性证明。

## 2. 已明确退役：跨插件求解和 `dsh.lock`

### 历史动作

- `43bb296`，2026-08-13，`chore(archive): 求解体系退役存档`：
  - 删除 `packages/cordis/mygo/src/package/resolver.ts`；
  - 新增 `version-select.ts`；
  - 创建 [`docs/mygo-manager-paper.md`](../mygo-manager-paper.md)；
  - 修改当时的 lockfile、manifest 和 package manager。
- `7fad915`，2026-08-13，`refactor(mygo): 求解/lockfile 体系退役`：
  - 删除 `src/activation.ts`；
  - 删除 `src/package/lockfile.ts`；
  - 删除 resolver、activation、lockfile evolution 对应测试文件；
  - 把 `package-store.ts` 改名为 `package-restore.ts`；
  - 修改 pack、package manager、plan、service 和 CLI。

### 当前状态

- 根 [`AGENTS.md`](../../AGENTS.md) 明确写 resolver、`dsh.lock`、冲突求解和激活求解器已退役。
- [`DEV-GUIDE.md`](../../DEV-GUIDE.md) 写 resolver、`dsh.lock/v1`、不可变 package-store 和 `solveActivation` 已删除。
- 当前 `src/package/` 没有 `resolver.ts` 和 `lockfile.ts`，当前 `src/` 没有 `activation.ts`。
- 当前仍有 `conflicts.ts`、`compatibility.ts`、`order.ts`、`plan.ts`、`requires-gate.ts` 和单插件 `version-select.ts`。这些文件属于当前生产树，不在本节“已删除文件”之列。
- `docs/mygo-manager-paper.md` 是退役提交创建的存档材料，内容包含旧 resolver/lockfile 体系。

## 3. 已明确退役：`install.sh`、vendor patch 登记和 Cordis alias

### 历史动作

- `59f336c`，2026-08-13，`chore(install): install.sh 与 vendor 登记制度退役`：
  - 删除根 `install.sh`；
  - 删除 `vendor/PATCHES.md`；
  - 删除 `vendor/cordis-alias/index.d.ts`、`index.js` 和 `package.json`；
  - 修改根 README、DEV-GUIDE、CHANGELOG 和仓库规则。

### 当前状态

- 当前树没有 `install.sh` 和 `vendor/` 目录。
- 根 `AGENTS.md` 写 `install.sh` 已退役、vendor 零补丁、仓库不再向 DSH checkout 同步文件。
- 当前 Panel 仍定义 `SELF_STATE = $DSH_HOME/mygo-self.json`，注释写该状态由 `install.sh` 写入。
- 当前 Panel 的 `updateMygoFromRemote` 仍读取 `mygo-self.json`，错误文案中仍有“请用 install.sh 安装”。
- 当前 core 的 `self.ts` 和 `service.ts` 已包含在 bundle 安装形态下写 `mygo-self.json` 的路径。

## 4. 做过后撤销：vendor Fiber epoch getter

### 历史动作

- [`docs/round-closeout.md`](../round-closeout.md) 记录在 vendor Cordis `Fiber` 增加公开 `epoch` getter，并在 `vendor/PATCHES.md` 登记为 patch #1。
- `9573718`，2026-08-12，`refactor(compliance): PATCHES #1 零侵入侵撤离`：
  - 回滚 vendor epoch getter；
  - 修改 EB-A9 断言；
  - 把细 epoch 改为 `FineEpochRegistry` 自有记账。
- [`docs/next/2026-08-12-compliance-closeout.md`](../next/2026-08-12-compliance-closeout.md) 记录了该回滚的消费点清单和上游 API 请求草稿。

### 当前状态

- 当前没有 vendor 目录。
- 当前 [`package/fine-epoch.ts`](../../packages/cordis/mygo/src/package/fine-epoch.ts) 包含 `FineEpochRegistry`。
- DEV-GUIDE 记录独立 `fineEpoch` 指纹函数后来也因无生产消费者而删除；registry 本身仍在当前生产代码中。

## 5. 已明确退役：Panel 外部应用管理

### 历史动作

- `41ef6fe`，2026-08-09，标题包含 `external apps`，同时加入早期 Panel、remote update 和 install.sh。
- `843b5be`，2026-08-14，`feat(panel): 配置注入 webui 插件页 + 配置导入导出 + 外部应用面退役`。
- 该提交的 CHANGELOG 记录删除 `/api/mygo/apps*`、App 类型、外部应用安装/启动/停止/卸载函数、`updateAppFromRemote` 和对应 Panel UI。

### 当前状态

- 当前 Panel HTTP pattern 中没有 `/api/mygo/apps*`。
- 当前 Panel 仍有插件 project 安装、插件 update 和 Mygo self-update；它们不以 external app 命名。
- DEV-GUIDE §17.3 仍明确写“已退役：外部应用管理全部面”。

## 6. 做过后替换：聚合配置卡片

### 历史动作

- `843b5be` 创建 `client/ConfigCards.tsx` 和 `config-cards.ts`，把配置注入 webui 插件页。
- `edfb3d8`，2026-08-14，`feat(panel): r7.1 插件配置合并`：
  - 删除 `client/ConfigCards.tsx`；
  - 新建 `client/PluginConfigCard.tsx` 和 `client/ConfigTransfer.tsx`；
  - 改为每个受管插件一张配置卡片。
- `b235295` 随后把 `PluginConfigCard` 改为官方折叠卡片形态。

### 当前状态

- 当前生产树有 `PluginConfigCard.tsx`、`ConfigTransfer.tsx`、`ConfigFields.tsx`。
- 当前没有 `client/ConfigCards.tsx`。
- 当前仍有 server-side `config-cards.ts` 和 `/api/mygo/config-cards` route。

## 7. 做过后移除：运行时 permission gate

### 历史动作

- 初始提交 `60e57eb` 的 `capabilities.ts` 实现 file path grant、network allowlist 和 denial path。
- `41ef6fe`，2026-08-09，删除这些 runtime gate 实现，并把文件头改为 permission-gate layer removed、direct host passthrough。
- [`docs/next/2026-08-13-review-closure-matrix.md`](../next/2026-08-13-review-closure-matrix.md) 的 DG-3 记录 “grants 永久移除”的裁决。

### 当前状态

- 当前 `capabilities.ts` 保持 direct passthrough 实现。
- 当前 `manifest-v2.ts` 仍解析 `grants`。
- 当前 API 类型仍包含 permissions/access 字段。
- 当前 API 错误注释仍有 “outside grants” 的文字。

该状态属于“运行时 gate 已移除，合同字段仍有残留”。

## 8. 已明确退役并保留实验探针：repository-plugin 安装轨

### 历史记录

- 当前 [`mygo-loader-hub/src/intent.ts`](../../packages/loaders/mygo-loader-hub/src/intent.ts) 常量 `REPOSITORY_TRACK_REMOVED` 写 “repository-plugin 安装轨在 0812 已删除，待官方态度”。
- 同一文件写目标 `.dsh-plugin` 目录含 `dsh.bundle` 时可经启发式探针实验性放行。
- [`adapter.ts`](../../packages/loaders/mygo-loader-hub/src/adapter.ts) 对普通 `repository-plugin` 返回 display-only reason。

### 当前状态

- 被删除的是旧 `official-repository/v1` 安装轨。
- Hub loader 当前仍保留 repository entry 类型、拒绝文案和 bundle heuristic。
- `experimental` 字段仍在当前 install intent 和 Panel catalog target 中使用。

## 9. 实验/Spike：WebUI 三路线接入

### 历史动作

- `3cc7d90`，2026-08-12，`feat(spike): Phase C webui 接入 spike — 三路线实测`，新增 `packages/cordis/mygo-cli/tests/webui-spike.spec.ts`，并扩充 `docs/cli-verification.md`。
- `c289c7b` 随后记录 settings gateway 显式 allowlist 的复核。
- [`docs/cli-verification.md`](../cli-verification.md) §8 把三条路线写为：
  1. `settings.plugin.item` 卡片；
  2. npm profile 加 Mygo Panel；
  3. 官方插件配置窗口调用链。
- 同一文档把当时结论记录为“部分能跑”，并登记 EXT-3 宿主需求。

### 当前状态

- `tests/webui-spike.spec.ts` 仍在当前测试树。
- 当前 Panel 使用 `settings.section` 和每插件 `settings.plugin.item` 卡片形态。
- 当前 Panel 的实际配置写入仍使用 `/api/mygo/config*` 路径。
- 本次没有运行该 spike，也没有验证其历史环境。

## 10. 提案未应用：Fabric host seam

### 历史动作

- `e67e70f`，2026-08-14，加入 `mygo-ext-fabric` 治理壳。
- `e79400d`，2026-08-14，创建 `patches/fabric-host.patch` 并扩充 `patches/README.md`。

### 当前状态

- [`patches/README.md`](../../patches/README.md) 把它定义为 DSH host patch proposal，并写“只存提案，不在工作区 apply”。
- Patch 固定到 host 快照 `47f9438`。
- 当前 fabric 源码写 runtime activation 依赖 host 合入提案。
- Fabric 包仍是当前七个 workspace 包之一；它没有被当前规则宣布退役。

## 11. 提案未应用：Client HMR graph patch

### 历史动作

- `0e5906c`，2026-08-15，增加 client-hmr graph frame host 补丁提案相关文档。
- `patches/client-hmr-graph-host.patch` 修改目标是宿主 client HMR 的 node 和 browser 两半。

### 当前状态

- [`patches/README.md`](../../patches/README.md) 明确写该 patch 不 apply。
- Patch 固定到 host 快照 `47f9438`。
- 当前 Mygo Panel 自己另有 `/api/mygo/events` SSE 和 `client/live-rail.ts`。
- Client HMR host patch 仍位于当前仓库，不属于已合入事实。

## 12. 做过后改变：分发政策

### 历史动作

- `446e1ca`，2026-08-13，仓库规则登记“不发公开 registry，走 GitHub repo + pnpm git spec”。
- `128d22a`，2026-08-14，把七包 `publishConfig.access` 改为 `public`。
- `2ebfde3`，2026-08-14，仓库规则登记七包 `0.2.0-rc.0` 已发布到 `next` tag。

### 当前状态

- 七包当前清单的 `publishConfig.access` 为 `public`。
- 根 `AGENTS.md` 同时记录七包曾发布和当前内测期禁 push/禁 npm publish。
- 当前内部依赖仍使用 `workspace:^`。
- 本次没有查询 npm registry。

## 13. 迁移：包 scope 和 Panel 位置

### 历史动作

- 早期包和文档使用 `@deepseek-ai/dsh-mygo*` 与 `@dsh-external/*` 名称。
- `41fb64d`，2026-08-13，把主包迁移到 `@r05en1cu/dsh-*`，并把版本线设为 `0.2.0-rc.0`。
- `f56a607` 建立自包含 workspace，并把 Panel 从 vendor 路径移到 `packages/extensions/mygo-panel`。
- `7bf00e8` 继续修改 Panel 以适配新 API。

### 当前状态

- 七个 workspace 包均使用 `@r05en1cu` scope。
- 当前没有 vendor Panel。
- `extension/mygo-rdb/package.json` 仍使用 `@dsh-external/mygo-rdb`，并依赖旧名 `@deepseek-ai/dsh-mygo`。
- `extension/mygo-rdb` 不在当前 pnpm workspace glob 中。

## 14. 已删除但文档仍可见的路径

| 历史路径 | 当前生产树 | 仍可见的位置 |
| --- | --- | --- |
| resolver | 不存在 | `docs/mygo-manager-paper.md`、部分旧设计材料 |
| `dsh.lock/v1` | 实现文件不存在 | DEV-GUIDE 的退役说明、CHANGELOG 旧段落、历史文档 |
| activation solver | `activation.ts` 不存在 | DEV-GUIDE 的退役说明、旧提交 |
| immutable package-store | `package-store.ts` 不存在 | 旧设计；当前为 `package-restore.ts` |
| `install.sh` | 不存在 | Panel 注释和错误文案、self state 历史说明 |
| vendor Cordis alias | 不存在 | 旧 closeout 和提交历史 |
| vendor epoch getter | 不存在 | `round-closeout.md`、compliance closeout |
| external app routes/UI | 不存在 | CHANGELOG rc.6、DEV-GUIDE 退役说明 |
| aggregate `ConfigCards.tsx` | 不存在 | 创建和删除提交、DEV-GUIDE 修订历史 |
| permission gate implementation | 不存在 | manifest/API 字段、design-r3、review closure |

## 15. 当前存在、未被宣布遗弃的能力

以下能力仍有当前生产源码或当前清单入口，因此本文不把它们列为已遗弃：

- LifecycleEngine 和 generation HMR；
- bridge rail、live rail 和 boot bundle rail；
- private package restore、registry persistence、snapshot、BOM 和 mygo-pack/v1；
- Panel folder/GitHub/archive installer；
- Panel update 和 Mygo self-update；
- profile loader 的 pnpm policy auto-fix；
- hub loader 和四源 Panel catalog；
- fabric workspace 包；
- CLI pack/restore/instance/hub/config/registry/auth 命令；
- raw Cordis adoption、inline definition 和 capability passthrough。

它们是否应在未来保留属于架构判断，不属于“已经遗弃”的历史事实。

## 16. 时间线摘要

| 日期 | 提交 | 已发生事项 |
| --- | --- | --- |
| 2026-08-09 | `41ef6fe` | permission gate 删除；早期 HMR、external apps、remote update、install.sh 和 vendor Panel 进入 |
| 2026-08-12 | `3cc7d90` | WebUI 三路线 spike |
| 2026-08-12 | `9573718` | vendor epoch getter 回滚 |
| 2026-08-13 | `43bb296` | resolver 退役存档 |
| 2026-08-13 | `7fad915` | `dsh.lock` 和 activation solver 删除 |
| 2026-08-13 | `59f336c` | install.sh、vendor patch 登记和 Cordis alias 删除 |
| 2026-08-13 | `41fb64d` | `@r05en1cu` scope 和 v0.2 RC 线 |
| 2026-08-13 | `f56a607` / `7bf00e8` | 自包含 workspace；Panel 移出 vendor 并适配新 API |
| 2026-08-14 | `843b5be` | external apps 退役；聚合配置卡片加入 |
| 2026-08-14 | `edfb3d8` | 聚合配置卡片替换为逐插件卡片 |
| 2026-08-14 | `e79400d` | Fabric host patch proposal |
| 2026-08-14 | `128d22a` / `2ebfde3` | 分发政策转为 public，rc.0 发布被规则记录 |
| 2026-08-15 | `0e5906c` | Client HMR graph host patch proposal |

本表中的“发生”指 Git 对象和当前文档可定位到这些动作，不表示本次重新验证了当时的运行结果。
