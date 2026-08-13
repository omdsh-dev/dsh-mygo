/**
 * Build the dsh-mygo-panel halves with the dsh checkout's toolchain:
 * typescript (lib/types) + tsdown (lib/index.js and lib/client.js via the
 * shared clientBundle preset). The project's own node_modules is a real
 * directory of symlinks into the checkout and is removed after the build.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 安装形态下本包位于 checkout/vendor/dsh-mygo-panel，../../ 即 checkout 根；
// 不写死工作站绝对路径（verify:self-contained 约束）。
const checkout = process.env.DSH_CHECKOUT ?? fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
console.log(`build-mygo-panel: using dsh checkout ${checkout}`)

const link = join(HERE, 'node_modules')
rmSync(link, { recursive: true, force: true })
mkdirSync(link, { recursive: true })

const symlinkDir = (source, target) => {
  rmSync(target, { force: true, recursive: false })
  if (existsSync(source)) symlinkSync(source, target, 'dir')
}

const typesSource = join(checkout, 'node_modules', '@types')
if (existsSync(typesSource)) symlinkDir(typesSource, join(link, '@types'))
const reactTypes = join(checkout, 'node_modules', '.pnpm', 'node_modules', '@types', 'react')
if (existsSync(reactTypes) && !existsSync(join(link, '@types', 'react'))) {
  mkdirSync(join(link, '@types'), { recursive: true })
  symlinkDir(reactTypes, join(link, '@types', 'react'))
}
const cordisSource = join(checkout, 'node_modules', '.pnpm', 'node_modules', 'cordis')
if (existsSync(cordisSource)) symlinkDir(cordisSource, join(link, 'cordis'))
for (const name of ['react', 'react-dom']) {
  const root = join(checkout, 'node_modules', name)
  if (existsSync(root)) symlinkDir(root, join(link, name))
}

const scopeDir = join(link, '@deepseek-ai')
mkdirSync(scopeDir, { recursive: true })
const workspacePackages = [
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-mygo',
  '@deepseek-ai/dsh-mygo-api',
]
const packagesRoot = join(checkout, 'packages')
const findWorkspace = (name) => {
  for (const group of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = join(packagesRoot, group.name)
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = join(groupDir, entry.name, 'package.json')
      if (!existsSync(manifest)) continue
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
        if (pkg.name === name) return join(groupDir, entry.name)
      } catch {
        // not a package directory
      }
    }
  }
  return undefined
}
for (const name of workspacePackages) {
  const workspace = findWorkspace(name)
  if (workspace !== undefined) symlinkDir(workspace, join(scopeDir, name.slice(name.lastIndexOf('/') + 1)))
}
const cordisAlias = join(checkout, 'vendor', 'cordis-alias')
if (existsSync(join(cordisAlias, 'package.json'))) {
  symlinkDir(cordisAlias, join(scopeDir, 'cordis'))
} else {
  // 0811+：vendor/cordis 已直接以 @deepseek-ai/cordis 身份存在于 workspace。
  const cordisVendor = join(checkout, 'vendor', 'cordis')
  if (existsSync(join(cordisVendor, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cordisVendor, 'package.json'), 'utf8'))
      if (pkg.name === '@deepseek-ai/cordis') symlinkDir(cordisVendor, join(scopeDir, 'cordis'))
    } catch {
      // unreadable vendor manifest: skip
    }
  }
}

const run = (bin, args) => {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: HERE,
    stdio: 'inherit',
    env: { ...process.env, DSH_CHECKOUT: checkout },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(join(checkout, 'node_modules', 'typescript', 'bin', 'tsc'), ['-p', 'tsconfig.json'])
run(join(checkout, 'node_modules', 'tsdown', 'dist', 'run.mjs'), ['-c', 'tsdown.config.mjs'])

rmSync(link, { recursive: true, force: true })
console.log('build-mygo-panel: done — lib ready')
