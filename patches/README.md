# Patches

`patches/` 是本仓库根级的补丁契约目录（对齐官方 plugin-template @87acac8；
2026-08-12 用户裁决采纳官方 DSH host 补丁语义）。

## 依赖补丁（dependency patches）

当某个精确版本的 registry 依赖需要修正时，将 pnpm 补丁放在本目录并在
`pnpm-workspace.yaml` 的 `patchedDependencies` 中声明，注明原因与移除条件。
当前无补丁，不添加空的 `patchedDependencies` 块。

## DSH host 补丁（提案工件，不 apply）

官方语义：当行为需要 host 侧能力（launcher/bootstrap 接线、构建缝，或
`cordis.patch.yml` 无法表达的变更）时，把 host 侧 diff 作为仓库级提案
工件携带，供 host 维护者合入，而不是分发被改过的 host。

dsh-dev 执行约束（AGENTS.md，2026-08-12 裁决）：

- 只存提案，不在工作区 apply；对已安装 checkout 保持零写入；
- 每个补丁 = 自包含 diff + 固定 host 快照 + apply/regenerate 命令 + 说明
  （触及哪些 host 文件、为什么、对应快照）；
- 不进发布包 `files`、不写 `pnpm-workspace.yaml`；host 合入后删除；
- 当前无 host 补丁，目录仅本 README。

对 vendored 内容的**已落地**本地修改仍先登记 vendor/PATCHES.md（当前
vendor 零补丁）再动工；两轨分开：patches/ = 提案，vendor/PATCHES.md = 落地。
