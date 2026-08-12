# Patches

`patches/` 是本仓库根级的补丁契约目录（对齐官方 plugin-template）。

## 依赖补丁（dependency patches）

当某个精确版本的 registry 依赖需要修正时，将 pnpm 补丁放在本目录并在
`pnpm-workspace.yaml` 的 `patchedDependencies` 中声明，注明原因与移除条件。
当前无补丁，不添加空的 `patchedDependencies` 块。

## DSH host 补丁（本仓库不适用）

官方模板允许以自包含 diff 形式携带 DSH host 补丁；dsh-dev 工作区守则禁止
修改 DSH 源码（对官方源码 checkout 零写入），因此本仓库不接收 host 补丁。
对 vendored 内容的本地修改一律先登记 vendor/PATCHES.md（当前 vendor 零
补丁）再动工。
