# mygo CLI 用户面真实验证轮（design-r5，T44-T49）

> 生成时间：2026-08-12 · 输入：design-r5-cli.md（Phase A 设计，含 Rev-A1/A2）。
> 性质：Phase B 实现 + 验证；冻结文档（expected-behavior / design-r3 /
> two-tier-contract）正文零改动；design-r5 仅以修订记录追加。
> Phase C（webui spike）未获放行，本节不包含；放行后单独追加 §webui-spike。

## 1. 场景矩阵（T44-T49，全部自动化断言）

| # | 场景 | 结果 | 断言要点 |
|---|---|---|---|
| T44 | CLI E2E 往返（RT1 经 CLI 复验） | ✅ | 真实语料（dsh-tool-time + zotero-wave-rag）→ `mygo pack --json` → 空 profile `mygo restore --profile cli-r --json` → lockfile **plugins 语义载荷逐字节一致**（generated 为安装侧事实，D-A5）；restore 告警可见 |
| T45 | 篡改 pack 经 CLI restore | ✅ | 字节翻转 `files/0.tgz` → 退出码 1；`--json` 直通 `pack-hash-mismatch`；human 输出含 `✗ pack-hash-mismatch` + `  文件 files/0.tgz` |
| T46 | init 产物 | ✅ | B1 零 problems/零 warnings + `checkTemplateAlignment aligned` + 身份替换（id/row/name）+ 7 skills + lockfile + 可被 pack/restore（还原后 R lockfile 含 `my-plugin`）；非法包名 → 2；非空目录 → 1 且零落盘 |
| T47 | 自举（吃自己的狗粮） | ✅ | pack 含 `dsh-mygo-cli` 自身 → restore 后 R store 入口与仓库源码 sha256 逐字节一致 → R 中 CLI 再次 `pack` 成功；R 无 `mygo` 参数启动不阻塞 |
| T48 | 报告渲染快照 | ✅ | resolve-failed / pack-invalid / pack-hash-mismatch / manifest-invalid / service 报告 / `--json` 信封 / 用法文本：字节级断言 |
| T49 | 被动语义 | ✅ | 非 `mygo` 首 token（`--port 8080`）→ 无输出、无退出、不阻塞 profile |

## 2. 实测数据（本次验证轮实测）

| 项 | 实测 | 环境 |
|---|---:|---|
| 全量回归（mygo + mygo-api + CLI，无网 fetch 拦截） | 63 文件 / 621 用例全绿，11.08 s | `NODE_OPTIONS="--require /tmp/block-net.cjs" vitest run packages/core/mygo-api packages/cordis/mygo --maxWorkers=2`（含 CLI 15 项；既有基线 60 文件 / 606 用例 = mygo 54/567 + mygo-api 6/39） |
| EB 假设套件 | 11 文件 / 13 用例全绿，1.34 s | `NODE_OPTIONS=… vitest run --config packages/cordis/mygo/test/eb/vitest.config.ts --maxWorkers=2` |
| typecheck | `tsc -b packages/core/mygo-api packages/cordis/mygo packages/cordis/mygo-cli` 通过 | rc 0 |
| buildPack 第一次 / 确定性复跑 | 25.50 / 25.52 ms | pack-verification beforeAll（5 插件真实语料） |
| pack 产物 | 62,069 B；sha256 `ac41bae1f14920a6657ed0cc4c7ceca278d410a97fc7de956f51b014ae780866` | 同一运行 |
| CLI 往返插件集 | 2 插件（T44）/ 1 插件（T47 自举） | 真实语料 + CLI 自身 |

> 注：pack 产物与旧基线（107,403 B / `349e6476…`）不同，因语料 F1（fabric）当日被
> 上游拆包为三包形态，语料归一后产物自然变化（§3 fixture-issue #1）；同一输入两次
> 构建仍逐字节一致（T32 全绿）。

## 3. 故障统计（三分类）

### impl-bug：1（已修复并回归）

1. **mygo 公共类型面缺服务报告类型导出**：CLI 报告渲染器（render.ts）首次消费
   `ServiceConflictEntry` / `ServiceResolutionReport`（B7 早已定义，report.ts）时发现
   `package/index.ts` 未导出。修复：补类型导出（一行），mygo 主套件 582 全绿。

### design-gap：0

- C5（requires.pluginManager 不可行）属设计修订而非未授权扩张：B6 政策闸无
  「要求管理器自身」表达（manager provides 仅 `service:mygo-core`，requires 键禁
  `service:` 前缀），修订为 requires 置空 + `ctx.get('pluginManager')` 惰性解析，
  已记入 design-r5 Rev-A2 / §9 C5。

### fixture-issue：2（已修复并回归）

1. **F1（fabric）语料漂移**：fabric 仓库 2026-08-12 12:52 +0800 被拆为三包形态，
   根载包 package.json 失去 `main`/`dsh.mygo`，且依赖为本地 `workspace:^` 区间
   （非发布形态）。T21/T22/T32-T43 因此变红。修复（不改仓库）：
   - corpus F1 注入 `manifestOverlay`（id 保持语料契约 `dsh-cordis-fabric`，
     entry `lib/index.js`）+ `packageJsonOverlay`（workspace:^ → `*` 占位）；
   - `packCorpus` 打包时以语料登记的 registry 身份为准（`real.name = plugin.name`），
     保证 lockfile.packageName 与内层 package.json 身份一致。
2. **packCorpus 并发写竞争**：多套件并行（--maxWorkers=2）时两个套件对同一
   `tmpdir/mygo-e2e-packs/<id>-<version>.tgz` 路径并发写读，偶发 tarball 损坏。
   修复：每次调用独立 `mkdtemp` 暂存目录。

### 环境注记

- 0811 checkout 的 mygo `lib/` 产物早于 B19-B29 导出（无 checkTemplateAlignment），
  导致符号校验对 CLI 的 `@deepseek-ai/dsh-mygo` 引用误判缺失；已重建
  （`tsc -b` + `tsdown`）。CLI 源码同时拆分 `import type`，避免类型符号进入
  运行时符号校验（B13 检查器的已知边界，非本轮引入）。

## 4. 冲突上报 / 裁决记录

| # | 内容 | 裁决 |
|---|---|---|
| C1 | 字面 `dsh mygo pack` 无 L0 入口 | 正式面 `dsh --profile <p> mygo …`（Phase A 定案；Phase B 未改） |
| C2 | `dsh.mygo.cli` 违反 B1 ID_RE | 用 `dsh-mygo-cli`（Phase A 定案；实现一致） |
| C3 | 入库不完整 | 本轮前置完成：B19+ 源码/tests/PATCHES.md/发布流水线全量入库（提交见 §6） |
| C4 | 官方插件配置窗口无安装/挂载 | Phase C 放行后实测（未放行，不预判） |
| C5 | requires.pluginManager 不可行（实现轮） | Rev-A2：requires 置空 + 惰性解析；零新增语义 |

## 5. 未核实项 / 候选功能

- 真实 `dsh` launcher 二进制启动路径（本轮回合验证为进程内真实 Cordis 组合 +
  cmdlineArgs 契约；launcher spawn 级 E2E 可作后续增强）。
- 生产部署的桥接/发布流水线（CLI 插件经 npm 发布后装入真实 profile）。
- Phase C webui spike（等待放行）。

## 6. 交付物与提交

- `packages/cordis/mygo-cli/`：插件包（src/args/render/init/index/invariant +
  vendored plugin-template@2da8230 资产 + tsconfig/tsdown/vitest + T44-T49 测试）。
- `packages/cordis/mygo/src/package/index.ts`：补服务报告类型导出。
- `packages/cordis/mygo/tests/e2e/{corpus,harness}.ts`：F1 语料归一 + 并发修复。
- `docs/design-r5-cli.md`：Rev-A2 修订记录。
- 本文件：验证报告。

全部代码与文档在 `dsh-mygo` 仓库本地提交；**未执行任何 push**（用户明确禁止）。

## 7. 收尾

Phase B 验收口径：全量 63/621（既有 606 + CLI 15）全绿（无网拦截）、EB 13/13、
typecheck 通过。
Phase C 未放行，未动工。
