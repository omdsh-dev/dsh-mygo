#!/usr/bin/env node
/**
 * mygo 发布流水线骨架：在 dsh checkout 内构建全部产物、做发布前自检，
 * 然后逐个 `pnpm publish`（不自动执行发布，避免无授权发布）。
 *
 * 用法：
 *   DSH_CHECKOUT=/path/to/checkout node scripts/publish-mygo.mjs --dry-run
 *   DSH_CHECKOUT=/path/to/checkout node scripts/publish-mygo.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const checkout = resolve(process.env.DSH_CHECKOUT ?? process.cwd())
const dryRun = process.argv.includes('--dry-run')
const node = process.execPath

function run(bin, args, cwd = checkout) {
  const result = spawnSync(bin, args, { cwd, stdio: 'inherit', env: process.env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const required = [
  'packages/core/mygo-api/package.json',
  'packages/cordis/mygo/package.json',
  'vendor/dsh-mygo-panel/package.json',
  'vendor/cordis-alias/package.json',
  'node_modules/typescript/bin/tsc',
]
for (const file of required) {
  if (!existsSync(join(checkout, file))) {
    console.error(`缺少 ${file}（请先 install.sh 或确认 checkout）`)
    process.exit(1)
  }
}

console.log(`==> 构建 mygo / mygo-api（checkout: ${checkout}）`)
run(node, [join(checkout, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', 'packages/core/mygo-api', 'packages/cordis/mygo'])
for (const config of ['packages/core/mygo-api/tsdown.config.ts', 'packages/cordis/mygo/tsdown.config.ts']) {
  run(node, [join(checkout, 'node_modules', 'tsdown', 'dist', 'run.mjs'), '--config', config])
}

console.log('==> 构建 mygo-panel')
run(node, ['build.mjs'], join(checkout, 'vendor', 'dsh-mygo-panel'))

console.log('==> prepack 自检（lib + .d.ts 门禁）')
for (const pkg of ['packages/core/mygo-api', 'packages/cordis/mygo', 'vendor/dsh-mygo-panel']) {
  // npm pack --dry-run 会执行该包的 prepack（lib/.d.ts 存在性门禁）并列出发布内容。
  run('npm', ['pack', '--dry-run'], join(checkout, pkg))
}

if (dryRun) {
  console.log('dry-run：构建与自检通过，未执行发布。')
  console.log('发布命令（确认 npm 私仓 token 与 scope 权限后执行）：')
  console.log('  pnpm --filter @deepseek-ai/dsh-mygo-api publish --no-git-checks')
  console.log('  pnpm --filter @deepseek-ai/dsh-mygo publish --no-git-checks')
  console.log('  pnpm --filter @dsh-external/dsh-mygo-panel publish --no-git-checks')
} else {
  console.log('==> 发布（请确认 token 权限；本脚本执行 pnpm publish）')
  run('pnpm', ['--filter', '@deepseek-ai/dsh-mygo-api', 'publish', '--no-git-checks'])
  run('pnpm', ['--filter', '@deepseek-ai/dsh-mygo', 'publish', '--no-git-checks'])
  run('pnpm', ['--filter', '@dsh-external/dsh-mygo-panel', 'publish', '--no-git-checks'])
}
