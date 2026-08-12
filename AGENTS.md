# dsh-mygo — 仓库规则（仓库级补充）

> 本仓库是 dsh-dev 工作区内的插件治理框架仓库。工作区级守则见 dsh_dev/
> AGENTS.md（含「核心框架仓库例外条款」）；本文件登记仓库级约定与验证命令，
> 两者冲突时以工作区守则为准。

## npm SDK 与安装形态

- 依赖只来自官方 NPM SDK（@deepseek-ai/* 私有 scope 或公开 npm 包）；
  workspace:^ 为发布前过渡态（收口条件见 dsh_dev/AGENTS.md 例外 #2）。
- 禁止修改 DSH 源码：vendor 零补丁；安装形态写入只走 install.sh
  （dsh_dev/AGENTS.md 例外 #1），不直接改 checkout。

## 包级规范（对齐官方 plugin-template，npm SDK 形态）

- 每包 package.json 提供 build / typecheck / test / verify:self-contained /
  prepare 五个标准脚本；exports / files 白名单与 src 布局同步维护。
- 修改包后在 checkout 安装形态内执行：
  `pnpm run verify:self-contained && pnpm run typecheck && pnpm test &&
  pnpm run build`；提交前另跑全量回归（无网拦截）+ EB + typecheck。

## 提交纪律

- 内测期禁 push / 禁 npm publish（dsh_dev/AGENTS.md 守则）。
- 禁 emoji（含提交信息，扫描口径 Emoji_Presentation=Yes；tests/fixtures
  整体豁免）。
- extension/mygo-rdb 三件本地修正（package.json / bom.spec.ts /
  extension-mygo-rdb.spec.ts）永不提交，维持用户既有 ignore 裁决。
