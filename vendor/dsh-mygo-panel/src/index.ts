/**
 * dsh-mygo-panel node half: a small JSON API over the mygo PluginManager
 * surface plus a local plugin installer. Sources: GitHub clone, local
 * folder, and zip/tar.gz archives. Installed plugins are copied into
 * `$DSH_HOME/mygo-plugins/<id>`, wrapped in a projected bridge package
 * (`@dsh-external/<id>-mygo`) so both halves reach the web app: the node
 * half re-adopts through mygo, and the browser half (dshClient) is served
 * from the bridge and enters the client roster via a profile patch row.
 * @module @dsh-external/dsh-mygo-panel
 */
import { execFile, spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from 'cordis'
import type { PluginManager } from '@deepseek-ai/dsh-mygo'
import type { PluginHandleInfo, RawCordisFunctionPlugin } from '@deepseek-ai/dsh-mygo-api'

const execFileAsync = promisify(execFile)

/** The dsh checkout root (the panel runs from vendor/dsh-mygo-panel/src or lib). */
const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Managed install root: every installed plugin lives in its own subdirectory. */
const HOME_ROOT = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')
const INSTALL_DIR = join(HOME_ROOT, 'mygo-plugins')

/** Managed external-app root: standalone processes, not Cordis plugins. */
const APPS_DIR = join(HOME_ROOT, 'mygo-apps')

/** mygo 自身安装状态（install.sh 写入，供检查/热更新自身）。 */
const SELF_STATE = join(HOME_ROOT, 'mygo-self.json')

/** User skill root scanned by dsh-skill-local (flat `name.md` skills). */
const SKILLS_ROOT = join(HOME_ROOT, 'skills')

/** Web profile patch row file (loader rows the web boot composes). */
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const PROFILE_PATCH = join(HOME_ROOT, 'profiles', PROFILE, 'cordis.patch.yml')

/** Per-plugin manifest file inside each installed directory. */
const MANIFEST = '.mygo-install.json'

/** Per-app manifest file inside each installed external-app directory. */
const APP_MANIFEST = '.mygo-app.json'

/** Append-only operation log for external apps (best-effort records). */
const APP_AUDIT = join(APPS_DIR, 'audit.jsonl')

/** Marker comments around the generated bridge rows in the profile patch. */
const ROW_MARKER_START = '# --- dsh-mygo-panel managed installs (generated; do not edit) ---'
const ROW_MARKER_END = '# --- end dsh-mygo-panel managed installs ---'

export const name = 'dsh-mygo-panel'
export const inject = ['pluginManager', 'httpServer']

interface HttpServerLike {
  register(route: {
    kind?: 'exact' | 'prefix'
    path: string
    handler(req: unknown, res: unknown): void | Promise<void>
  }): () => void
}

type PanelContext = Context & {
  readonly pluginManager: PluginManager
  readonly httpServer: HttpServerLike
  readonly sandbox?: {
    confine(
      argv: readonly string[],
      policy: { readonly mode: 'workspace-write'; readonly workspaceRoot: string },
    ): { readonly argv: string[] }
  }
}

interface RawRequest {
  readonly method?: string
  readonly url?: string
  on?(event: 'data' | 'end', listener: (chunk?: Buffer) => void): void
}

interface RawResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body: string): void
}

interface InstallManifest {
  readonly id: string
  readonly method: 'github' | 'folder' | 'archive'
  readonly source: string
  readonly entry: string
  /** Remote repository provenance when installed from GitHub. */
  readonly remote?: RemoteRef
  skillFile?: string
  readonly config?: unknown
  readonly installDeps?: boolean
  readonly installedAt: number
}

interface InstallRequest {
  readonly method?: 'github' | 'folder' | 'archive'
  readonly url?: string
  readonly ref?: string
  readonly path?: string
  readonly config?: unknown
  /** Install the plugin's runtime `dependencies` with npm (opt-in). */
  readonly installDeps?: boolean
}

/** Remote repository provenance recorded for GitHub-installed plugins/apps. */
interface RemoteRef {
  readonly url: string
  /** Git ref checked at install (`HEAD` when no branch was given). */
  readonly ref: string
  /** Installed commit SHA. */
  readonly commit: string
}

/** mygo 自身安装状态。 */
interface MygoSelfState {
  readonly url: string
  readonly ref: string
  readonly commit: string
  readonly installedAt: number
}

/** One installed external app (standalone process, not a Cordis plugin). */
interface AppManifest {
  readonly id: string
  readonly kind: 'external-app'
  readonly method: InstallManifest['method']
  readonly source: string
  /** npm script used to launch the app (`start` / `dev`). */
  readonly startCommand: string
  /** Runtime confinement tier: `none` or `workspace` (landlock/bwrap). */
  readonly sandbox: 'none' | 'workspace'
  /** Remote repository provenance when installed from GitHub. */
  readonly remote?: RemoteRef
  /** Shell commands run before `npm run build` at install/update time. */
  readonly setup?: readonly string[]
  /** Whether the repo build script was skipped at install/update time. */
  readonly skipBuild?: boolean
  /** External apps are never synchronously uninstallable by the manager. */
  readonly syncUninstall: false
  readonly installedAt: number
  pid?: number
  startedAt?: number
}

interface AppInstallRequest {
  readonly method?: 'github' | 'folder' | 'archive'
  readonly url?: string
  readonly ref?: string
  readonly path?: string
  readonly sandbox?: 'none' | 'workspace'
  /** Override the launch command: an npm script name or a raw shell command. */
  readonly startCommand?: string
  /** Skip the repo's build script entirely (e.g. dev-mode apps). */
  readonly skipBuild?: boolean
  /** Optional shell commands run inside the app dir before `npm run build`. */
  readonly setup?: readonly string[]
}

/** Bridge package directory for one installed plugin id. */
function bridgeDirOf(id: string): string {
  return join(INSTALL_DIR, `${id}-mygo`)
}

/** Bridge package name for one installed plugin id. */
function bridgeNameOf(id: string): string {
  return `@dsh-external/${id}-mygo`
}

/** Derive a manifest-safe plugin id from a package name. */
function pluginIdOf(packageName: string): string {
  const base = packageName.includes('/') ? packageName.slice(packageName.lastIndexOf('/') + 1) : packageName
  const cleaned = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'plugin'
}

/** Candidate entry files, in priority order. */
function entryCandidates(root: string): string[] {
  return [
    join(root, 'lib', 'index.js'),
    join(root, 'src', 'index.ts'),
    join(root, 'index.ts'),
    join(root, 'index.js'),
  ]
}

/** Resolve a plugin's runnable entry, honoring package.json.main when present. */
async function resolveEntry(root: string): Promise<string> {
  let main: string | undefined
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { readonly main?: unknown }
    if (typeof pkg.main === 'string' && pkg.main.length > 0) main = pkg.main
  } catch {
    // no package.json: fall through to candidate entries
  }
  const candidates = main === undefined ? entryCandidates(root) : [resolve(root, main), ...entryCandidates(root)]
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // keep looking
    }
  }
  throw new Error('未找到插件入口（package.json main / lib/index.js / src/index.ts）')
}

/** Import one plugin entry and unwrap CJS default exports. */
async function importEntry(entry: string): Promise<RawCordisFunctionPlugin> {
  const mod = await import(pathToFileURL(entry).href) as {
    readonly default?: RawCordisFunctionPlugin
    readonly apply?: unknown
    readonly name?: string
  }
  const raw = mod.default ?? (mod as unknown as RawCordisFunctionPlugin)
  if (typeof raw.apply !== 'function') {
    throw new Error(`插件入口 ${entry} 没有 apply 函数`)
  }
  return raw
}

/** Copy a plugin directory, excluding node_modules/.git so deps resolve from the harness. */
async function copyPluginTree(source: string, target: string): Promise<void> {
  await cp(source, target, {
    recursive: true,
    filter: (candidate: string) => {
      const tail = candidate.slice(source.length)
      const parts = tail.split(sep).filter(part => part.length > 0)
      return !parts.includes('node_modules') && !parts.includes('.git')
    },
  })
}

/** Link the harness node_modules into an installed plugin dir so bare imports resolve. */
async function ensureNodeModulesLink(target: string): Promise<void> {
  const link = join(target, 'node_modules')
  try {
    await symlink(join(CHECKOUT, 'node_modules'), link, 'dir')
  } catch (error) {
    if (!(error instanceof Error) || (error as { code?: string }).code !== 'EEXIST') {
      throw error
    }
  }
}

/** Find one workspace package directory under the dsh checkout by name. */
async function findWorkspacePackage(name: string): Promise<string | undefined> {
  const packagesRoot = join(CHECKOUT, 'packages')
  let groups: string[]
  try {
    groups = (await readdir(packagesRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return undefined
  }
  for (const group of groups) {
    const groupDir = join(packagesRoot, group)
    let entries: string[]
    try {
      entries = (await readdir(groupDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      continue
    }
    for (const entry of entries) {
      try {
        const pkg = JSON.parse(await readFile(join(groupDir, entry, 'package.json'), 'utf8')) as {
          readonly name?: unknown
        }
        if (pkg.name === name) return join(groupDir, entry)
      } catch {
        // not a package directory
      }
    }
  }
  return undefined
}

/**
 * Link `@deepseek-ai/*` runtime dependencies into a real node_modules so they
 * resolve to the dsh checkout instead of npm (these packages are not
 * published). Idempotent: npm may prune or replace the links during install,
 * so callers re-run this after `npm install`.
 */
async function linkWorkspaceDependencies(target: string, dependencies: Record<string, string>): Promise<void> {
  const scopeDir = join(target, 'node_modules', '@deepseek-ai')
  for (const name of Object.keys(dependencies)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    const workspace = await findWorkspacePackage(name)
    if (workspace === undefined) continue
    await mkdir(scopeDir, { recursive: true })
    const link = join(scopeDir, name.slice(name.lastIndexOf('/') + 1))
    try {
      await symlink(workspace, link, 'dir')
    } catch (error) {
      if (!(error instanceof Error) || (error as { code?: string }).code !== 'EEXIST') {
        throw error
      }
    }
  }
}

/** Runtime `dependencies` declared by one plugin root (not devDependencies). */
async function runtimeDependenciesOf(root: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      readonly dependencies?: Record<string, string>
    }
    return pkg.dependencies ?? {}
  } catch {
    return {}
  }
}

/** Every declared dependency surface (deps + peers + devDeps) of one plugin root. */
async function allDependenciesOf(root: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      readonly dependencies?: Record<string, string>
      readonly peerDependencies?: Record<string, string>
      readonly devDependencies?: Record<string, string>
    }
    return { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies }
  } catch {
    return {}
  }
}

/**
 * The declared browser client half of one plugin root: the `exports['./client']`
 * target when the package also declares `dshClient.platform === 'web'`.
 */
async function clientTargetOf(root: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      readonly dshClient?: { readonly platform?: string }
      readonly exports?: Record<string, { readonly default?: string } | string>
    }
    const clientExport = pkg.exports?.['./client']
    const target = typeof clientExport === 'string' ? clientExport : clientExport?.default
    if (typeof target !== 'string' || target.length === 0) return undefined
    if (pkg.dshClient?.platform !== 'web') return undefined
    return target
  } catch {
    return undefined
  }
}

/** Whether `path` exists and is a regular file. */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Build-time env: expose the dsh checkout and its toolchain on PATH. */
function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DSH_CHECKOUT: CHECKOUT,
    PATH: `${join(CHECKOUT, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`,
  }
}

/** Link one package found under the pnpm store into the target node_modules. */
async function linkStorePackage(
  target: string,
  storePrefix: string,
  storeSubPath: string,
  linkPath: string,
): Promise<void> {
  const store = join(CHECKOUT, 'node_modules', '.pnpm')
  let entries: string[]
  try {
    entries = await readdir(store)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(storePrefix)) continue
    const source = join(store, entry, 'node_modules', storeSubPath)
    try {
      if (!(await stat(source)).isDirectory()) continue
    } catch {
      continue
    }
    await mkdir(dirname(join(target, linkPath)), { recursive: true })
    try {
      await symlink(source, join(target, linkPath), 'dir')
    } catch (error) {
      if (!(error instanceof Error) || (error as { code?: string }).code !== 'EEXIST') {
        throw error
      }
    }
    return
  }
}

/**
 * Link build-time framework packages from the checkout into a real
 * node_modules: vendored cordis/schemastery, react/react-dom, and the
 * type packages tsc needs. Runtime singleton identity is unaffected — the
 * host owns those instances; these links only let the plugin's build run.
 */
async function linkFrameworkDependencies(target: string): Promise<void> {
  const flat = join(CHECKOUT, 'node_modules', '.pnpm', 'node_modules')
  for (const name of ['cordis', 'schemastery']) {
    const source = join(flat, name)
    try {
      if (!(await stat(source)).isDirectory()) continue
      await symlink(source, join(target, 'node_modules', name), 'dir')
    } catch (error) {
      if (!(error instanceof Error) || (error as { code?: string }).code !== 'EEXIST') {
        throw error
      }
    }
  }
  await linkStorePackage(target, 'react@', 'react', 'node_modules/react')
  await linkStorePackage(target, 'react-dom@', 'react-dom', 'node_modules/react-dom')
  await linkStorePackage(target, '@types+react@', '@types/react', 'node_modules/@types/react')
  const typesFlat = join(flat, '@types')
  try {
    if ((await stat(typesFlat)).isDirectory()) {
      await symlink(typesFlat, join(target, 'node_modules', '@types'), 'dir')
    }
  } catch (error) {
    if (!(error instanceof Error) || (error as { code?: string }).code !== 'EEXIST') {
      throw error
    }
  }
}

/** Bounded scan for nested package.json manifests (old monorepo-style repos). */
async function findNestedPackageManifests(
  tree: string,
  maxDepth = 4,
): Promise<Array<{
  readonly dir: string
  readonly pkg: {
    readonly name?: unknown
    readonly private?: unknown
    readonly devDependencies?: Record<string, unknown>
  }
}>> {
  const found: Array<{
    readonly dir: string
    readonly pkg: {
      readonly name?: unknown
      readonly private?: unknown
      readonly devDependencies?: Record<string, unknown>
    }
  }> = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        await walk(join(dir, entry.name), depth + 1)
      } else if (entry.isFile() && entry.name === 'package.json') {
        try {
          const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
            readonly name?: unknown
            readonly private?: unknown
            readonly devDependencies?: Record<string, unknown>
          }
          found.push({ dir, pkg })
        } catch {
          // unreadable manifest: skip
        }
      }
    }
  }
  await walk(tree, 1)
  return found
}

/**
 * Detect an old (0804/0805-era) dsh workspace plugin: a nested private
 * `@deepseek-ai/dsh-*` package whose devDependencies use the pnpm
 * `workspace:` protocol. Such plugins must live inside the dsh monorepo and
 * often ship a core UI patch; the panel deliberately does not support them.
 */
async function detectOldWorkspacePlugin(tree: string): Promise<string | undefined> {
  const manifests = await findNestedPackageManifests(tree)
  for (const { dir, pkg } of manifests) {
    if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@deepseek-ai/dsh-')) continue
    const devDependencies = pkg.devDependencies ?? {}
    const hasWorkspaceProtocol = Object.values(devDependencies)
      .some(spec => typeof spec === 'string' && spec.startsWith('workspace:'))
    if (pkg.private === true && hasWorkspaceProtocol) {
      return `仓库包含旧版 dsh 工作区插件 ${pkg.name}（${dir}）：`
        + '这是 0804/0805 时代需要放进 dsh 源码仓库并打补丁的 monorepo 插件，版本过老，'
        + '面板不支持直接安装。请改用作者提供的新版独立包，或按仓库 README 的官方方式安装。'
    }
  }
  return undefined
}

/**
 * Run one install command against a manifest stripped of pnpm `link:` specs
 * (npm rejects those protocols outright), restoring the original manifest
 * afterwards. The linked workspace packages are provided by the panel's own
 * symlinks, so the entries are only a build-time convenience for pnpm.
 */
async function withInstallableManifest(
  target: string,
  run: () => Promise<unknown>,
  injectFramework = false,
): Promise<void> {
  const manifestPath = join(target, 'package.json')
  let original: string
  try {
    original = await readFile(manifestPath, 'utf8')
  } catch {
    await run()
    return
  }
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(original) as Record<string, unknown>
  } catch {
    await run()
    return
  }
  let changed = false
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field]
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) continue
    const entries = Object.entries(deps as Record<string, unknown>)
    const kept = entries.filter(([, spec]) => !(
      typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('workspace:'))
    ))
    if (kept.length === entries.length) continue
    pkg[field] = Object.fromEntries(kept)
    changed = true
  }
  if (!changed && !injectFramework) {
    await run()
    return
  }
  if (injectFramework) {
    // Build-time tsc needs vendored framework types (cordis/schemastery) that
    // are usually peer-only and skipped by --legacy-peer-deps. Declaring them
    // as `file:` deps makes npm keep them for the duration of the install, so
    // a `prepare` script running mid-install can resolve the types.
    const dependencies = (pkg.dependencies ?? {}) as Record<string, string>
    for (const name of ['cordis', 'schemastery']) {
      if (dependencies[name] !== undefined) continue
      dependencies[name] = `file:${join(CHECKOUT, 'node_modules', '.pnpm', 'node_modules', name)}`
    }
    pkg.dependencies = dependencies
  }
  await writeFile(manifestPath, JSON.stringify(pkg, null, 2))
  try {
    await run()
  } finally {
    await writeFile(manifestPath, original)
  }
}

/**
 * Install the plugin's runtime dependencies into a REAL node_modules inside
 * the installed directory, and when the plugin declares a browser client
 * half whose artifact the repository does not ship, build it with the
 * repository's own `npm run build` (devDependencies installed, checkout
 * toolchain on PATH). The harness symlink is replaced because npm must be
 * able to write; `@deepseek-ai/*` workspace deps are linked from the checkout
 * before and after the install so private packages never hit npm.
 */
async function installRuntimeDependencies(
  target: string,
  dependencies: Record<string, string>,
  allDependencies: Record<string, string>,
  buildClientTarget?: string,
): Promise<void> {
  const commandErrorText = (error: unknown): string => {
    if (error instanceof Error) {
      const detail = (error as { stderr?: unknown }).stderr
      return typeof detail === 'string' && detail !== '' ? `${error.message}\n${detail}` : error.message
    }
    return String(error)
  }
  const link = join(target, 'node_modules')
  await rm(link, { force: true, recursive: true })
  await mkdir(link, { recursive: true })
  await linkWorkspaceDependencies(target, allDependencies)
  if (buildClientTarget === undefined) {
    await withInstallableManifest(
      target,
      () => execFileAsync(
        'npm',
        ['install', '--omit=dev', '--no-audit', '--no-fund', '--legacy-peer-deps'],
        { cwd: target, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
      ),
    )
    await linkWorkspaceDependencies(target, allDependencies)
    return
  }
  // Full install (devDependencies included) so the repo's own build can run;
  // legacy-peer-deps keeps npm from fetching the unpublished dsh packages.
    await withInstallableManifest(
      target,
      () => execFileAsync(
        'npm',
        ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'],
        { cwd: target, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
      ),
      true,
    )
  await linkWorkspaceDependencies(target, allDependencies)
  await linkFrameworkDependencies(target)
  // Some repositories build during `npm install` via their `prepare` script
  // (the git-install path), so the artifact may already exist. Only run the
  // declared build when it does not, falling back to `prepare` for repos
  // whose `build` assumes a sibling harness checkout.
  if (!(await fileExists(join(target, buildClientTarget)))) {
    try {
      await execFileAsync(
        'npm',
        ['run', 'build'],
        { cwd: target, timeout: 600_000, maxBuffer: 64 * 1024 * 1024, env: buildEnv() },
      )
    } catch (buildError) {
      await execFileAsync(
        'npm',
        ['run', 'prepare'],
        { cwd: target, timeout: 600_000, maxBuffer: 64 * 1024 * 1024, env: buildEnv() },
      ).catch((prepareError: unknown) => {
        throw new Error(
          `构建失败（npm run build: ${commandErrorText(buildError)}；npm run prepare: ${commandErrorText(prepareError)}）`,
        )
      })
    }
  }
  await linkWorkspaceDependencies(target, allDependencies)
  if (!(await fileExists(join(target, buildClientTarget)))) {
    throw new Error(`构建完成但 client half 产物缺失: ${buildClientTarget}`)
  }
}

/** Locate the plugin root after clone/extract: the tree itself, or its single inner directory. */
async function locatePluginRoot(tree: string): Promise<string> {
  try {
    await resolveEntry(tree)
    return tree
  } catch {
    const entries = (await readdir(tree, { withFileTypes: true })).filter(entry => entry.isDirectory())
    if (entries.length === 1) {
      const inner = join(tree, entries[0]!.name)
      try {
        await resolveEntry(inner)
        return inner
      } catch {
        // not the plugin root
      }
    }
    const unsupported = await detectOldWorkspacePlugin(tree)
    if (unsupported !== undefined) throw new Error(unsupported)
    throw new Error('未找到插件入口（package.json main / lib/index.js / src/index.ts）')
  }
}

/**
 * Generate the projected bridge package for one installed plugin and link it
 * into the checkout's node_modules scope so the web loader can resolve it.
 * The bridge node half re-adopts through mygo; the bridge client half serves
 * the plugin's browser bundle with the embedded module id rewritten.
 */
async function ensureProjectedBridge(manifest: InstallManifest): Promise<void> {
  const pluginDir = join(INSTALL_DIR, manifest.id)
  const bridgeDir = bridgeDirOf(manifest.id)
  const bridgeName = bridgeNameOf(manifest.id)
  await mkdir(bridgeDir, { recursive: true })
  await mkdir(join(bridgeDir, 'src'), { recursive: true })

  const pluginPkg = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8')) as {
    readonly name?: unknown
    readonly dshClient?: { readonly inject?: readonly string[]; readonly platform?: string }
    readonly exports?: Record<string, { readonly default?: string } | string>
  }
  const originalName = typeof pluginPkg.name === 'string' ? pluginPkg.name : bridgeName
  const clientTarget = await clientTargetOf(pluginDir)

  const bridgePackage = {
    name: bridgeName,
    version: '0.1.0',
    private: true,
    type: 'module',
    main: 'src/index.ts',
    exports: {
      '.': './src/index.ts',
      ...(clientTarget !== undefined ? { './client': './lib/client.js' } : {}),
      './package.json': './package.json',
    },
    ...(clientTarget !== undefined
      ? { dshClient: { platform: 'web' as const, inject: pluginPkg.dshClient?.inject ?? [] } }
      : {}),
  }
  await writeFile(join(bridgeDir, 'package.json'), JSON.stringify(bridgePackage, null, 2))

  const bridgeSource = `/**
 * Generated dsh-mygo bridge for installed plugin ${manifest.id} (do not edit).
 */
import type { PluginManager } from '@deepseek-ai/dsh-mygo'

export const name = ${JSON.stringify(`${manifest.id}-mygo`)}
export const inject = ['pluginManager']

export function apply(ctx: { readonly pluginManager: PluginManager }, config: unknown): void {
  void (async () => {
    let rawModule: unknown
    try {
      rawModule = await import('../../${manifest.id}/${manifest.entry}')
    } catch (error: unknown) {
      console.error('[dsh-mygo-panel] 插件 ${manifest.id} 导入失败，跳过挂载:', error instanceof Error ? error.message : String(error))
      return
    }
    const raw = (rawModule as { default?: unknown }).default ?? rawModule
    const support = await ctx.pluginManager.checkSupport(raw, ${JSON.stringify(manifest.id)})
    if (!support.ok) {
      console.warn('[dsh-mygo-panel] 插件 ${manifest.id} 不受支持，跳过挂载:', support.reason)
      return
    }
    await ctx.pluginManager.adoptRaw(raw, config ?? {}, ${JSON.stringify(manifest.id)})
  })().catch((error: unknown) => {
    console.error('[dsh-mygo-panel] bridge adopt failed:', error)
  })
}
`
  await writeFile(join(bridgeDir, 'src', 'index.ts'), bridgeSource)

  if (clientTarget !== undefined) {
    const sourceClient = join(pluginDir, clientTarget)
    const sourceMap = `${sourceClient}.map`
    await mkdir(join(bridgeDir, 'lib'), { recursive: true })
    let clientText = await readFile(sourceClient, 'utf8')
    const marker = `id: ${JSON.stringify(originalName)}`
    if (clientText.includes(marker)) {
      clientText = clientText.replace(marker, `id: ${JSON.stringify(bridgeName)}`)
    }
    await writeFile(join(bridgeDir, 'lib', 'client.js'), clientText)
    try {
      await copyFile(sourceMap, join(bridgeDir, 'lib', 'client.js.map'))
    } catch {
      // source map is optional
    }
  }

  // Project into the checkout AND the active profile's node_modules: the web
  // loader resolves row names from the profile patch directory, so the link
  // must live where Node walks up from `~/.dsh/profiles/<profile>/`.
  const scopeDir = join(CHECKOUT, 'node_modules', '@dsh-external')
  await mkdir(scopeDir, { recursive: true })
  const link = join(scopeDir, `${manifest.id}-mygo`)
  await rm(link, { force: true, recursive: false })
  await symlink(bridgeDir, link, 'dir')
  const profileScope = join(HOME_ROOT, 'profiles', PROFILE, 'node_modules', '@dsh-external')
  await mkdir(profileScope, { recursive: true })
  const profileLink = join(profileScope, `${manifest.id}-mygo`)
  await rm(profileLink, { force: true, recursive: false })
  await symlink(bridgeDir, profileLink, 'dir')
}

/** Remove a projected bridge: package dir, checkout link, and generated files. */
async function removeProjectedBridge(id: string): Promise<void> {
  await rm(bridgeDirOf(id), { recursive: true, force: true })
  await rm(join(CHECKOUT, 'node_modules', '@dsh-external', `${id}-mygo`), { force: true, recursive: false })
  await rm(join(HOME_ROOT, 'profiles', PROFILE, 'node_modules', '@dsh-external', `${id}-mygo`), {
    force: true,
    recursive: false,
  })
}

/** Collect bridge rows from every installed plugin with a generated bridge. */
async function collectBridgeRows(): Promise<Array<{ readonly id: string; readonly name: string; readonly config: unknown }>> {
  let ids: string[]
  try {
    ids = (await readdir(INSTALL_DIR, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
  const rows: Array<{ readonly id: string; readonly name: string; readonly config: unknown }> = []
  for (const dirName of ids) {
    if (dirName.endsWith('-mygo')) continue
    try {
      const manifest = JSON.parse(await readFile(join(INSTALL_DIR, dirName, MANIFEST), 'utf8')) as InstallManifest
      const bridgePkg = join(bridgeDirOf(manifest.id), 'package.json')
      await stat(bridgePkg)
      rows.push({
        id: `${manifest.id}-mygo`,
        name: bridgeNameOf(manifest.id),
        config: manifest.config ?? {},
      })
    } catch {
      // no manifest or no bridge: skip
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id))
}

/** Rewrite the web profile patch, preserving any user content before the managed block. */
async function syncBridgeRows(): Promise<void> {
  const rows = await collectBridgeRows()
  let existing = ''
  try {
    existing = await readFile(PROFILE_PATCH, 'utf8')
  } catch {
    existing = ''
  }
  const start = existing.indexOf(ROW_MARKER_START)
  const endMarker = ROW_MARKER_END
  // Drop the standalone empty-array placeholder when we are adding real rows,
  // and cut any previous generated block out of the user-owned head/tail.
  const rawHead = start === -1 ? existing : existing.slice(0, start)
  const cleaned = rawHead.replace(/^\[\]\s*$/m, '')
  const head = cleaned.replace(/\s+$/, '')
  const hasHeadEntries = head.split('\n')
    .map(line => line.trim())
    .some(line => line !== '' && !line.startsWith('#'))
  const tailMarker = start === -1 ? '' : (() => {
    const end = existing.indexOf(endMarker, start)
    return end === -1 ? '' : existing.slice(end + endMarker.length)
  })()
  let block: string
  if (rows.length === 0) {
    // Empty managed set: keep a valid single-document YAML file. When the
    // user layer already carries entries, contribute comments only so the
    // document stays one list; when it is empty, emit the empty-array body.
    block = !hasHeadEntries
      ? `${ROW_MARKER_START}\n[]\n${ROW_MARKER_END}\n`
      : `${ROW_MARKER_START}\n${ROW_MARKER_END}\n`
  } else {
    block = `${ROW_MARKER_START}\n- insert:\n`
    for (const row of rows) {
      block += `    - id: ${row.id}\n      name: '${row.name}'\n      config: ${JSON.stringify(row.config)}\n`
    }
    block += `${ROW_MARKER_END}\n`
  }
  const next = `${head}\n${block}${tailMarker.replace(/^\s+/, '')}`
  await mkdir(dirname(PROFILE_PATCH), { recursive: true })
  await writeFile(PROFILE_PATCH, next)
}

/**
 * One-time bridge template upgrade: rewrite any installed bridge that still
 * uses the old static-import template with the guarded dynamic-import +
 * checkSupport version. A broken old bridge could abort the whole plugin
 * tree before the panel ever runs; this runs at panel mount so healthy
 * installs converge to the guarded template on the next boot.
 */
async function regenerateBridges(): Promise<void> {
  let ids: string[]
  try {
    ids = (await readdir(INSTALL_DIR, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return
  }
  for (const dirName of ids) {
    if (dirName.endsWith('-mygo')) continue
    try {
      const manifest = JSON.parse(await readFile(join(INSTALL_DIR, dirName, MANIFEST), 'utf8')) as InstallManifest
      const bridgeSrc = join(bridgeDirOf(manifest.id), 'src', 'index.ts')
      const text = await readFile(bridgeSrc, 'utf8')
      if (text.includes('checkSupport')) continue
      await ensureProjectedBridge(manifest)
    } catch {
      // unreadable or already upgraded; keep whatever bridge exists
    }
  }
}

/** Directory helpers for one external app. */
function appDirOf(id: string): string {
  return join(APPS_DIR, id)
}
function appCodeDirOf(id: string): string {
  return join(appDirOf(id), 'app')
}
function appStateDirOf(id: string): string {
  return join(appDirOf(id), 'state')
}
function appLogsDirOf(id: string): string {
  return join(appDirOf(id), 'logs')
}

/** Append one best-effort operation record to the external-app audit log. */
async function appAudit(class_: string, id: string, details: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(APPS_DIR, { recursive: true })
    await appendFile(APP_AUDIT, `${JSON.stringify({ v: 1, ts: Date.now(), class: class_, id, ...details })}\n`, 'utf8')
  } catch {
    // audit is best-effort; failures never block app operations
  }
}

async function readAppManifest(id: string): Promise<AppManifest> {
  return JSON.parse(await readFile(join(appDirOf(id), APP_MANIFEST), 'utf8')) as AppManifest
}

async function writeAppManifest(manifest: AppManifest): Promise<void> {
  await writeFile(join(appDirOf(manifest.id), APP_MANIFEST), JSON.stringify(manifest, null, 2))
}

/** Whether a recorded PID is still alive (best-effort liveness probe). */
function appIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Locate an app root: the tree itself, or its single inner directory with a package.json. */
async function locateAppRoot(tree: string): Promise<string> {
  const hasPackage = async (dir: string): Promise<boolean> => {
    try {
      await stat(join(dir, 'package.json'))
      return true
    } catch {
      return false
    }
  }
  if (await hasPackage(tree)) return tree
  const entries = (await readdir(tree, { withFileTypes: true })).filter(entry => entry.isDirectory())
  if (entries.length === 1 && await hasPackage(join(tree, entries[0]!.name))) {
    return join(tree, entries[0]!.name)
  }
  const unsupported = await detectOldWorkspacePlugin(tree)
  if (unsupported !== undefined) throw new Error(unsupported)
  throw new Error('未找到 package.json（外部应用安装根）')
}

/** The npm script used to launch an app: `start`, falling back to `dev`. */
async function appStartCommandOf(root: string): Promise<string> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    readonly scripts?: Record<string, string>
  }
  if (pkg.scripts?.start !== undefined) return 'start'
  if (pkg.scripts?.dev !== undefined) return 'dev'
  throw new Error('外部应用需要 package.json 的 start 或 dev 脚本')
}

/**
 * Whether an app's `build` script is a compile step worth running at install
 * (tsc/tsdown/vite/next build/...). Packaging-only scripts (electron-builder,
 * dmg, pack) are skipped — they target release artifacts, not a runnable tree.
 */
function appBuildNeeded(scripts: Record<string, string> | undefined): boolean {
  const build = scripts?.build
  if (build === undefined || build === '') return false
  if (/electron-builder|\bbuilder\b|\bdmg\b|\bpack\b|\bpkg\b/i.test(build)) return false
  return /tsc|tsdown|tsup|vite|next build|webpack|rollup|nest build/i.test(build)
}

/** Install one external app from a prepared root directory. */
async function prepareAppCode(
  codeDir: string,
  root: string,
  setup: readonly string[],
  skipBuild: boolean,
): Promise<void> {
  await mkdir(codeDir, { recursive: true })
  await copyPluginTree(root, codeDir)
  const allDependencies = await allDependenciesOf(root)
  const link = join(codeDir, 'node_modules')
  await rm(link, { force: true, recursive: true })
  await mkdir(link, { recursive: true })
  await linkWorkspaceDependencies(codeDir, allDependencies)
  await withInstallableManifest(
    codeDir,
    () => execFileAsync(
      'npm',
      ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'],
      { cwd: codeDir, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
    ),
  )
  await linkWorkspaceDependencies(codeDir, allDependencies)
  await linkFrameworkDependencies(codeDir)
  for (const command of setup) {
    await execFileAsync(command, [], {
      cwd: codeDir,
      shell: true,
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  }
  const pkg = JSON.parse(await readFile(join(codeDir, 'package.json'), 'utf8')) as {
    readonly scripts?: Record<string, string>
  }
  if (!skipBuild && appBuildNeeded(pkg.scripts)) {
    await execFileAsync(
      'npm',
      ['run', 'build'],
      { cwd: codeDir, timeout: 600_000, maxBuffer: 64 * 1024 * 1024, env: buildEnv() },
    )
    await linkWorkspaceDependencies(codeDir, allDependencies)
  }
}

async function installAppFromRoot(
  root: string,
  method: InstallManifest['method'],
  source: string,
  sandbox: 'none' | 'workspace',
  setup: readonly string[] = [],
  startCommandOverride?: string,
  skipBuild = false,
  remote?: RemoteRef,
): Promise<{ readonly ok: true; readonly id: string; readonly message: string; readonly syncUninstall: false }> {
  let id: string | undefined
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { readonly name?: unknown }
    id = typeof pkg.name === 'string' ? pluginIdOf(pkg.name) : undefined
  } catch {
    id = undefined
  }
  if (id === undefined) id = pluginIdOf(basename(root))
  const target = appDirOf(id)
  try {
    await stat(target)
    throw new Error(`外部应用 ${id} 已安装，请先卸载或清理安装目录`)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error as { code?: string }).code !== 'ENOENT') {
      throw error
    }
  }
  const startCommand = startCommandOverride ?? await appStartCommandOf(root)
  await mkdir(target, { recursive: true })
  try {
    const codeDir = appCodeDirOf(id)
    await mkdir(appStateDirOf(id), { recursive: true })
    await mkdir(appLogsDirOf(id), { recursive: true })
    await prepareAppCode(codeDir, root, setup, skipBuild)
    const manifest: AppManifest = {
      id,
      kind: 'external-app',
      method,
      source,
      startCommand,
      sandbox,
      ...(remote === undefined ? {} : { remote }),
      ...(setup.length > 0 ? { setup } : {}),
      ...(skipBuild ? { skipBuild: true } : {}),
      syncUninstall: false,
      installedAt: Date.now(),
    }
    await writeAppManifest(manifest)
    await appAudit('install', id, { ok: true, sandbox })
    return { ok: true, id, message: `外部应用 ${id} 已安装`, syncUninstall: false }
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    await appAudit('install-failed', id, { error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

/** Start one external app as a detached process group; the PID is recorded in its manifest. */
async function startExternalApp(
  ctx: PanelContext,
  id: string,
): Promise<{ readonly ok: true; readonly pid: number; readonly message: string }> {
  const manifest = await readAppManifest(id)
  if (manifest.pid !== undefined && appIsRunning(manifest.pid)) {
    return { ok: true, pid: manifest.pid, message: `外部应用 ${id} 已在运行` }
  }
  const pkg = JSON.parse(await readFile(join(appCodeDirOf(id), 'package.json'), 'utf8')) as {
    readonly scripts?: Record<string, string>
  }
  const isNpmScript = manifest.startCommand === 'start'
    || manifest.startCommand === 'dev'
    || pkg.scripts?.[manifest.startCommand] !== undefined
  let argv = isNpmScript
    ? ['npm', 'run', manifest.startCommand]
    : ['/bin/sh', '-c', manifest.startCommand]
  if (manifest.sandbox === 'workspace') {
    if (ctx.sandbox === undefined) {
      throw new Error('sandbox 服务不可用：workspace 档需要宿主 sandbox（landlock/bwrap）')
    }
    argv = ctx.sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: appDirOf(id) }).argv
  }
  const logPath = join(appLogsDirOf(id), `${Date.now()}.log`)
  const logFd = openSync(logPath, 'a')
  const child = spawn(argv[0], argv.slice(1), {
    cwd: appCodeDirOf(id),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, DSH_APP_ID: id, DSH_APP_STATE: appStateDirOf(id) },
  })
  manifest.pid = child.pid
  manifest.startedAt = Date.now()
  await writeAppManifest(manifest)
  await appAudit('start', id, { pid: child.pid, sandbox: manifest.sandbox })
  return { ok: true, pid: child.pid!, message: `外部应用 ${id} 已启动（日志 ${logPath}）` }
}

/** Stop one external app by killing its process group (best-effort). */
async function stopExternalApp(id: string): Promise<{ readonly ok: true; readonly stopped: boolean; readonly remaining: readonly string[] }> {
  const manifest = await readAppManifest(id)
  if (manifest.pid === undefined || !appIsRunning(manifest.pid)) {
    manifest.pid = undefined
    manifest.startedAt = undefined
    await writeAppManifest(manifest)
    return { ok: true, stopped: true, remaining: [] }
  }
  const pid = manifest.pid
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // group already gone
  }
  let stopped = false
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!appIsRunning(pid)) {
      stopped = true
      break
    }
  }
  if (!stopped) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // group already gone
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    stopped = !appIsRunning(pid)
  }
  manifest.pid = undefined
  manifest.startedAt = undefined
  await writeAppManifest(manifest)
  await appAudit('stop', id, { stopped })
  return { ok: true, stopped, remaining: stopped ? [] : ['process'] }
}

/**
 * Uninstall one external app: best-effort process stop, then remove the
 * installed tree. External apps are never synchronously uninstallable — the
 * response carries what may remain (processes the manager could not stop).
 */
async function uninstallExternalApp(
  id: string,
): Promise<{ readonly ok: true; readonly id: string; readonly message: string; readonly syncUninstall: false; readonly remaining: readonly string[] }> {
  let remaining: readonly string[] = []
  try {
    const stopped = await stopExternalApp(id)
    remaining = stopped.remaining
  } catch {
    // unknown or already removed: nothing to stop
  }
  await rm(appDirOf(id), { recursive: true, force: true })
  await appAudit('uninstall', id, { remaining })
  return {
    ok: true,
    id,
    message: '外部应用已卸载（文件已删除）',
    syncUninstall: false,
    remaining,
  }
}

/** List every installed external app with liveness derived from its recorded PID. */
async function listExternalApps(): Promise<AppManifest[]> {
  let entries: string[]
  try {
    entries = (await readdir(APPS_DIR, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
  const apps: AppManifest[] = []
  for (const name of entries) {
    try {
      apps.push(await readAppManifest(name))
    } catch {
      // no manifest or unreadable: skip
    }
  }
  return apps.sort((left, right) => left.id.localeCompare(right.id))
}

/** One update-check result for a remote-installed plugin or external app. */
interface RemoteUpdateStatus {
  readonly id: string
  readonly kind: 'plugin' | 'app' | 'mygo'
  readonly url: string
  readonly ref: string
  readonly currentCommit: string
  readonly latestCommit?: string
  readonly upToDate?: boolean
  readonly error?: string
}

async function readMygoSelfState(): Promise<MygoSelfState | undefined> {
  try {
    return JSON.parse(await readFile(SELF_STATE, 'utf8')) as MygoSelfState
  } catch {
    return undefined
  }
}

async function writeMygoSelfState(state: MygoSelfState): Promise<void> {
  await writeFile(SELF_STATE, JSON.stringify(state, null, 2))
}

/**
 * Scan every installed plugin/app whose manifest carries remote provenance
 * and compare the installed commit against the remote ref. Folder/archive
 * installs have no remote and are skipped by design.
 */
async function listUpdates(): Promise<readonly RemoteUpdateStatus[]> {
  const results: RemoteUpdateStatus[] = []
  const self = await readMygoSelfState()
  if (self !== undefined) {
    try {
      const latestCommit = await remoteLatest(self.url, self.ref)
      results.push({
        id: 'dsh-mygo',
        kind: 'mygo',
        url: self.url,
        ref: self.ref,
        currentCommit: self.commit,
        latestCommit,
        upToDate: self.commit === latestCommit,
      })
    } catch (error) {
      results.push({
        id: 'dsh-mygo',
        kind: 'mygo',
        url: self.url,
        ref: self.ref,
        currentCommit: self.commit,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const entries: Array<{ readonly id: string; readonly kind: 'plugin' | 'app'; readonly remote: RemoteRef }> = []
  try {
    for (const dirName of (await readdir(INSTALL_DIR, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)) {
      if (dirName.endsWith('-mygo')) continue
      try {
        const manifest = JSON.parse(await readFile(join(INSTALL_DIR, dirName, MANIFEST), 'utf8')) as InstallManifest
        if (manifest.remote !== undefined) entries.push({ id: manifest.id, kind: 'plugin', remote: manifest.remote })
      } catch {
        // unreadable manifest: skip
      }
    }
  } catch {
    // no plugin installs yet
  }
  try {
    for (const dirName of (await readdir(APPS_DIR, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)) {
      try {
        const manifest = JSON.parse(await readFile(join(appDirOf(dirName), APP_MANIFEST), 'utf8')) as AppManifest
        if (manifest.remote !== undefined) entries.push({ id: manifest.id, kind: 'app', remote: manifest.remote })
      } catch {
        // unreadable manifest: skip
      }
    }
  } catch {
    // no app installs yet
  }
  for (const { id, kind, remote } of entries.sort((a, b) => a.id.localeCompare(b.id))) {
    try {
      const latestCommit = await remoteLatest(remote.url, remote.ref)
      results.push({
        id,
        kind,
        url: remote.url,
        ref: remote.ref,
        currentCommit: remote.commit,
        latestCommit,
        upToDate: remote.commit === latestCommit,
      })
    } catch (error) {
      results.push({
        id,
        kind,
        url: remote.url,
        ref: remote.ref,
        currentCommit: remote.commit,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

/**
 * mygo 自身热更新：clone 远端仓库 → 替换 checkout 里的 mygo/mygo-api/panel
 * 源码 → 重建 → 记录新 commit。Loader 会在响应后由 profile patch 变更触发
 * 热重载，受管插件在重载后通过 recover() 自动恢复。
 */
async function updateMygoFromRemote(
  _ctx: PanelContext,
): Promise<{ readonly ok: true; readonly id: string; readonly updated: boolean; readonly message: string; readonly commit?: string }> {
  const self = await readMygoSelfState()
  if (self === undefined) throw new Error('未记录 mygo 自身安装信息（请用 install.sh 安装）')
  const latestCommit = await remoteLatest(self.url, self.ref)
  if (latestCommit === self.commit) {
    return { ok: true, id: 'dsh-mygo', updated: false, message: 'mygo 已是最新' }
  }
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-mygo-update-'))
  try {
    await cloneFromGitHub(self.url, self.ref === 'HEAD' ? undefined : self.ref, tmp)
    const pairs: Array<[string, string]> = [
      [join(tmp, 'packages', 'core', 'mygo-api'), join(CHECKOUT, 'packages', 'core', 'mygo-api')],
      [join(tmp, 'packages', 'cordis', 'mygo'), join(CHECKOUT, 'packages', 'cordis', 'mygo')],
      [join(tmp, 'vendor', 'dsh-mygo-panel'), join(CHECKOUT, 'vendor', 'dsh-mygo-panel')],
    ]
    for (const [src, dst] of pairs) {
      await rm(dst, { recursive: true, force: true })
      await mkdir(dst, { recursive: true })
      await copyPluginTree(src, dst)
    }
    await execFileAsync('pnpm', ['install'], { cwd: CHECKOUT, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })
      .catch((error: unknown) => {
        console.error('[dsh-mygo-panel] pnpm install during self-update failed:', error)
      })
    const nodeBin = process.execPath
    await execFileAsync(
      nodeBin,
      [join(CHECKOUT, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', 'packages/core/mygo-api', 'packages/cordis/mygo'],
      { cwd: CHECKOUT, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
    )
    for (const config of ['packages/core/mygo-api/tsdown.config.ts', 'packages/cordis/mygo/tsdown.config.ts']) {
      await execFileAsync(
        nodeBin,
        [join(CHECKOUT, 'node_modules', 'tsdown', 'dist', 'run.mjs'), '--config', config],
        { cwd: CHECKOUT, env: buildEnv(), timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
      )
    }
    if (await fileExists(join(CHECKOUT, 'vendor', 'dsh-mygo-panel', 'build.mjs'))) {
      await execFileAsync(
        nodeBin,
        ['build.mjs'],
        { cwd: join(CHECKOUT, 'vendor', 'dsh-mygo-panel'), env: buildEnv(), timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
      )
    }
    await writeMygoSelfState({ ...self, commit: latestCommit, installedAt: Date.now() })
    return {
      ok: true,
      id: 'dsh-mygo',
      updated: true,
      message: 'mygo 已更新（代码已替换并重建；Loader 热重载后生效）',
      commit: latestCommit,
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * Live-update one remote-installed plugin: clone the new version, swap the
 * running generation through mygo's HMR replace protocol (sessions and the
 * host process stay up), then refresh the installed tree and bridge.
 */
async function updatePluginFromRemote(
  ctx: PanelContext,
  id: string,
): Promise<{ readonly ok: true; readonly id: string; readonly updated: boolean; readonly message: string; readonly commit?: string }> {
  const manifest = JSON.parse(await readFile(join(INSTALL_DIR, id, MANIFEST), 'utf8')) as InstallManifest
  const remote = manifest.remote
  if (remote === undefined) throw new Error(`插件 ${id} 没有远程仓库，无法更新`)
  const latestCommit = await remoteLatest(remote.url, remote.ref)
  if (latestCommit === remote.commit) {
    return { ok: true, id, updated: false, message: `插件 ${id} 已是最新` }
  }
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-update-'))
  try {
    await cloneFromGitHub(remote.url, remote.ref === 'HEAD' ? undefined : remote.ref, tmp)
    const root = await locatePluginRoot(tmp)
    const entry = await resolveEntry(root)
    const raw = await importEntry(entry)
    // HMR live swap first: the old generation stays live on any failure.
    await ctx.pluginManager.updateRaw(raw, manifest.config ?? {}, id)
    // Refresh the installed tree to match the new generation.
    await rm(join(INSTALL_DIR, id), { recursive: true, force: true })
    await preparePluginFiles(root, join(INSTALL_DIR, id), manifest.installDeps === true)
    const entryRelative = relative(root, entry)
    const next: InstallManifest = {
      ...manifest,
      entry: entryRelative,
      remote: { ...remote, commit: latestCommit },
      installedAt: Date.now(),
    }
    if (manifest.skillFile !== undefined) {
      try {
        await copyFile(join(root, 'SKILL.md'), manifest.skillFile)
      } catch {
        // the new version dropped the skill; keep the previous file
      }
    }
    await writeFile(join(INSTALL_DIR, id, MANIFEST), JSON.stringify(next, null, 2))
    await ensureProjectedBridge(next)
    await syncBridgeRows()
    return { ok: true, id, updated: true, message: `插件 ${id} 已更新（HMR 生效）`, commit: latestCommit }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * Update one remote-installed external app: stop it (if running), replace the
 * app tree keeping `state/` and `logs/`, re-run setup/build, restart if it
 * was running before.
 */
async function updateAppFromRemote(
  ctx: PanelContext,
  id: string,
): Promise<{ readonly ok: true; readonly id: string; readonly updated: boolean; readonly message: string; readonly commit?: string }> {
  const manifest = await readAppManifest(id)
  const remote = manifest.remote
  if (remote === undefined) throw new Error(`外部应用 ${id} 没有远程仓库，无法更新`)
  const latestCommit = await remoteLatest(remote.url, remote.ref)
  if (latestCommit === remote.commit) {
    return { ok: true, id, updated: false, message: `外部应用 ${id} 已是最新` }
  }
  const wasRunning = manifest.pid !== undefined && appIsRunning(manifest.pid)
  if (wasRunning) await stopExternalApp(id)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-app-update-'))
  try {
    await cloneFromGitHub(remote.url, remote.ref === 'HEAD' ? undefined : remote.ref, tmp)
    const root = await locateAppRoot(tmp)
    await rm(appCodeDirOf(id), { recursive: true, force: true })
    await prepareAppCode(appCodeDirOf(id), root, manifest.setup ?? [], manifest.skipBuild === true)
    const next: AppManifest = {
      ...manifest,
      pid: undefined,
      startedAt: undefined,
      remote: { ...remote, commit: latestCommit },
      installedAt: Date.now(),
    }
    await writeAppManifest(next)
    await appAudit('update', id, { commit: latestCommit })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
  if (wasRunning) await startExternalApp(ctx, id)
  return { ok: true, id, updated: true, message: `外部应用 ${id} 已更新`, commit: latestCommit }
}

/** Install one plugin from a prepared root directory. */
async function preparePluginFiles(root: string, target: string, installDeps: boolean): Promise<void> {
  await mkdir(target, { recursive: true })
  await copyPluginTree(root, target)
  const dependencies = await runtimeDependenciesOf(root)
  const allDependencies = await allDependenciesOf(root)
  const clientTarget = await clientTargetOf(root)
  if (installDeps && (Object.keys(dependencies).length > 0 || clientTarget !== undefined)) {
    await installRuntimeDependencies(target, dependencies, allDependencies, clientTarget)
  } else {
    await ensureNodeModulesLink(target)
    if (clientTarget !== undefined && !(await fileExists(join(target, clientTarget)))) {
      throw new Error(
        `插件声明了 web client half（${clientTarget}）但仓库没有构建产物；`
        + '请勾选“自动安装依赖（npm install + 构建）”重新安装',
      )
    }
  }
}

async function installFromRoot(
  pluginManager: PluginManager,
  pluginRoot: string,
  method: InstallManifest['method'],
  source: string,
  config: unknown,
  installDeps = false,
  idOverride?: string,
  remote?: RemoteRef,
): Promise<{ readonly ok: true; readonly id: string; readonly message: string }> {
  const entry = await resolveEntry(pluginRoot)
  let id = idOverride
  if (id === undefined || id.length === 0) {
    try {
      const pkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8')) as { readonly name?: unknown }
      id = typeof pkg.name === 'string' ? pluginIdOf(pkg.name) : undefined
    } catch {
      id = undefined
    }
    if (id === undefined) id = pluginIdOf(basename(pluginRoot))
  }
  const target = join(INSTALL_DIR, id)
  try {
    await stat(target)
    throw new Error(`插件 ${id} 已安装，请先卸载或清理安装目录`)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error as { code?: string }).code !== 'ENOENT') {
      throw error
    }
  }
  await mkdir(target, { recursive: true })
  try {
    await preparePluginFiles(pluginRoot, target, installDeps)
    const entryRelative = relative(pluginRoot, entry)
    const manifest: InstallManifest = {
      id,
      method,
      source,
      entry: entryRelative,
      ...(remote === undefined ? {} : { remote }),
      installedAt: Date.now(),
      ...(config === undefined ? {} : { config }),
      ...(installDeps ? { installDeps: true } : {}),
    }
    // A flat SKILL.md at the plugin root is synced into the user skill root so
    // the harness `skill` tool can load it (dsh-skill-local scans that root).
    const skillSource = join(pluginRoot, 'SKILL.md')
    try {
      const skillText = await readFile(skillSource, 'utf8')
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skillText)
      let skillName = id
      if (frontmatter !== null) {
        const nameLine = /^name:\s*(.+)$/m.exec(frontmatter[1])
        if (nameLine !== null && nameLine[1] !== undefined && nameLine[1].trim() !== '') {
          skillName = nameLine[1].trim()
        }
      }
      const skillTarget = join(SKILLS_ROOT, `${skillName}.md`)
      await mkdir(SKILLS_ROOT, { recursive: true })
      await copyFile(skillSource, skillTarget)
      manifest.skillFile = skillTarget
    } catch {
      // no SKILL.md: nothing to sync
    }
    await writeFile(join(target, MANIFEST), JSON.stringify(manifest, null, 2))
    // Generate the projected bridge and register the loader row, then adopt
    // the node half live (the bridge row re-adopts on the next boot).
    await ensureProjectedBridge(manifest)
    await syncBridgeRows()
    await pluginManager.clearUninstallTombstone(id)
    const raw = await importEntry(join(target, manifest.entry))
    await pluginManager.adoptRaw(raw, config ?? {}, id)
    return { ok: true, id, message: `插件 ${id} 已安装` }
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    await removeProjectedBridge(id)
    await syncBridgeRows()
    throw error
  }
}

/** Clone a GitHub repository into a temp directory. */
async function cloneFromGitHub(url: string, ref: string | undefined, into: string): Promise<void> {
  const args = ['clone', '--depth', '1']
  if (ref !== undefined && ref.trim() !== '') args.push('--branch', ref.trim())
  args.push(url, into)
  await execFileAsync('git', args, { timeout: 120_000 })
}

/** The commit SHA of one cloned repository. */
async function gitHeadOf(repoDir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { timeout: 30_000 })
  return stdout.trim()
}

/**
 * The remote commit SHA for one ref. Network call; private repositories
 * resolve through the user's git credentials. Fails loud on timeout/auth.
 */
async function remoteLatest(url: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['ls-remote', url, ref], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })
  const line = stdout.split('\n').find(entry => entry.trim() !== '')
  const sha = line?.trim().split(/\s+/)[0]
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`无法解析远端引用 ${ref}`)
  }
  return sha
}

/** Extract a zip or tar.gz archive into a temp directory. */
async function extractArchive(file: string, into: string): Promise<void> {
  const lower = file.toLowerCase()
  if (lower.endsWith('.zip')) {
    await execFileAsync('unzip', ['-q', file, '-d', into], { timeout: 120_000 })
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await execFileAsync('tar', ['-xzf', file, '-C', into], { timeout: 120_000 })
  } else {
    throw new Error('暂仅支持 zip / tar.gz 压缩包')
  }
}

/** Read a node:http request body as text (bounded). */
function readBody(req: RawRequest, limit = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    if (req.on === undefined) {
      resolveBody('')
      return
    }
    let raw = ''
    req.on('data', (chunk?: Buffer) => {
      raw += (chunk ?? '').toString('utf8')
      if (raw.length > limit) {
        rejectBody(new Error('request body too large'))
        return
      }
    })
    req.on('end', () => resolveBody(raw))
  })
}

export function apply(ctx: PanelContext): void {
  void (async () => {
    await syncBridgeRows()
    await regenerateBridges()
  })().catch((error: unknown) => {
    console.error('[dsh-mygo-panel] startup sync failed:', error)
  })
  ctx.httpServer.register({
    kind: 'prefix',
    path: '/api/mygo',
    handler: async (reqRaw: unknown, resRaw: unknown): Promise<void> => {
      const req = reqRaw as RawRequest
      const res = resRaw as RawResponse
      const method = req.method ?? 'GET'
      const path = (req.url ?? '/').split('?')[0] ?? '/'
      const json = (status: number, body: unknown): void => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      }
      try {
        if (method === 'GET' && (path === '/api/mygo/plugins' || path === '/api/mygo/plugins/')) {
          const plugins = ctx.pluginManager.plugins().map((plugin: PluginHandleInfo) => ({
            id: plugin.id,
            version: plugin.version,
            status: plugin.status,
            origin: plugin.origin,
            generation: plugin.generation,
          }))
          json(200, { ok: true, plugins })
          return
        }
        if (method === 'POST' && path === '/api/mygo/install') {
          const body = JSON.parse(await readBody(req)) as InstallRequest
          if (body.method === 'github') {
            const url = body.url?.trim()
            if (url === undefined || url.length === 0) throw new Error('缺少 GitHub 仓库地址')
            const tmp = await mkdtemp(join(tmpdir(), 'dsh-install-'))
            try {
              await cloneFromGitHub(url, body.ref, tmp)
              const root = await locatePluginRoot(tmp)
              const commit = await gitHeadOf(tmp)
              const remote: RemoteRef = { url, ref: body.ref?.trim() || 'HEAD', commit }
              json(200, await installFromRoot(
                ctx.pluginManager, root, 'github', url, body.config, body.installDeps === true, undefined, remote,
              ))
            } finally {
              await rm(tmp, { recursive: true, force: true })
            }
            return
          }
          if (body.method === 'folder') {
            const folder = body.path?.trim()
            if (folder === undefined || folder.length === 0) throw new Error('缺少文件夹路径')
            const root = resolve(folder)
            if ((await stat(root)).isDirectory() !== true) throw new Error(`不是文件夹: ${root}`)
            const pluginRoot = await locatePluginRoot(root)
            json(200, await installFromRoot(ctx.pluginManager, pluginRoot, 'folder', root, body.config, body.installDeps === true))
            return
          }
          if (body.method === 'archive') {
            const file = body.path?.trim()
            if (file === undefined || file.length === 0) throw new Error('缺少压缩包路径')
            const archive = resolve(file)
            if ((await stat(archive)).isFile() !== true) throw new Error(`不是文件: ${archive}`)
            const tmp = await mkdtemp(join(tmpdir(), 'dsh-install-'))
            try {
              await extractArchive(archive, tmp)
              const root = await locatePluginRoot(tmp)
              json(200, await installFromRoot(ctx.pluginManager, root, 'archive', archive, body.config, body.installDeps === true))
            } finally {
              await rm(tmp, { recursive: true, force: true })
            }
            return
          }
          throw new Error('method 必须是 github / folder / archive')
        }
        if (method === 'GET' && (path === '/api/mygo/apps' || path === '/api/mygo/apps/')) {
          const apps = (await listExternalApps()).map(app => ({
            id: app.id,
            kind: app.kind,
            startCommand: app.startCommand,
            sandbox: app.sandbox,
            syncUninstall: app.syncUninstall,
            running: app.pid !== undefined && appIsRunning(app.pid),
            processOwned: app.pid !== undefined,
          }))
          json(200, { ok: true, apps })
          return
        }
        if (method === 'POST' && path === '/api/mygo/apps/install') {
          const body = JSON.parse(await readBody(req)) as AppInstallRequest
          const sandbox = body.sandbox === 'workspace' ? 'workspace' : 'none'
          const setup = Array.isArray(body.setup)
            ? body.setup.filter((item): item is string => typeof item === 'string')
            : []
          const startCommandOverride = typeof body.startCommand === 'string' && body.startCommand.trim() !== ''
            ? body.startCommand.trim()
            : undefined
          const skipBuild = body.skipBuild === true
          if (body.method === 'github') {
            const url = body.url?.trim()
            if (url === undefined || url.length === 0) throw new Error('缺少 GitHub 仓库地址')
            const tmp = await mkdtemp(join(tmpdir(), 'dsh-app-install-'))
            try {
              await cloneFromGitHub(url, body.ref, tmp)
              const root = await locateAppRoot(tmp)
              const commit = await gitHeadOf(tmp)
              const remote: RemoteRef = { url, ref: body.ref?.trim() || 'HEAD', commit }
              json(200, await installAppFromRoot(root, 'github', url, sandbox, setup, startCommandOverride, skipBuild, remote))
            } finally {
              await rm(tmp, { recursive: true, force: true })
            }
            return
          }
          if (body.method === 'folder') {
            const folder = body.path?.trim()
            if (folder === undefined || folder.length === 0) throw new Error('缺少文件夹路径')
            const root = resolve(folder)
            if ((await stat(root)).isDirectory() !== true) throw new Error(`不是文件夹: ${root}`)
            const appRoot = await locateAppRoot(root)
            json(200, await installAppFromRoot(appRoot, 'folder', root, sandbox, setup, startCommandOverride, skipBuild))
            return
          }
          if (body.method === 'archive') {
            const file = body.path?.trim()
            if (file === undefined || file.length === 0) throw new Error('缺少压缩包路径')
            const archive = resolve(file)
            if ((await stat(archive)).isFile() !== true) throw new Error(`不是文件: ${archive}`)
            const tmp = await mkdtemp(join(tmpdir(), 'dsh-app-install-'))
            try {
              await extractArchive(archive, tmp)
              const root = await locateAppRoot(tmp)
              json(200, await installAppFromRoot(root, 'archive', archive, sandbox, setup, startCommandOverride, skipBuild))
            } finally {
              await rm(tmp, { recursive: true, force: true })
            }
            return
          }
          throw new Error('method 必须是 github / folder / archive')
        }
        const appMatch = /^\/api\/mygo\/apps\/([^/]+)\/(start|stop|uninstall)$/.exec(path)
        if (method === 'POST' && appMatch !== null) {
          const id = appMatch[1]
          const action = appMatch[2]
          if (action === 'start') {
            json(200, await startExternalApp(ctx, id))
          } else if (action === 'stop') {
            json(200, await stopExternalApp(id))
          } else {
            json(200, await uninstallExternalApp(id))
          }
          return
        }
        if (method === 'GET' && (path === '/api/mygo/updates' || path === '/api/mygo/updates/')) {
          json(200, { ok: true, updates: await listUpdates() })
          return
        }
        const updateMatch = /^\/api\/mygo\/updates\/(plugins|apps|mygo)(?:\/([^/]+))?$/.exec(path)
        if (method === 'POST' && updateMatch !== null) {
          const kind = updateMatch[1]
          if (kind === 'mygo') {
            const result = await updateMygoFromRemote(ctx)
            json(200, result)
            if (result.updated) {
              // Touch the profile patch after the response is sent: the web
              // boot watches it and hot-reloads the tree, re-initializing
              // mygo from the freshly rebuilt code (recover() re-adopts).
              setTimeout(() => {
                void syncBridgeRows().catch((error: unknown) => {
                  console.error('[dsh-mygo-panel] self-update reload trigger failed:', error)
                })
              }, 200)
            }
            return
          }
          const id = updateMatch[2]
          if (id === undefined) throw new Error('缺少更新目标 id')
          json(200, kind === 'plugins'
            ? await updatePluginFromRemote(ctx, id)
            : await updateAppFromRemote(ctx, id))
          return
        }
        const match = /^\/api\/mygo\/plugins\/([^/]+)\/(enable|disable|uninstall)$/.exec(path)
        if (method === 'POST' && match !== null) {
          const id = match[1]
          const action = match[2]
          if (action === 'enable') await ctx.pluginManager.enable(id)
          else if (action === 'disable') await ctx.pluginManager.disable(id)
          else {
            let skillFile: string | undefined
            try {
              const installed = JSON.parse(await readFile(join(INSTALL_DIR, id, MANIFEST), 'utf8')) as InstallManifest
              skillFile = installed.skillFile
            } catch {
              // no manifest: nothing to clean
            }
            await ctx.pluginManager.uninstall(id)
            // Installed plugins: drop the managed directory, bridge, and rows.
            await rm(join(INSTALL_DIR, id), { recursive: true, force: true })
            await removeProjectedBridge(id)
            if (skillFile !== undefined) {
              await rm(skillFile, { force: true })
            }
            await syncBridgeRows()
          }
          json(200, {
            ok: true,
            id,
            message: action === 'enable' ? '插件已启用' : action === 'disable' ? '插件已停用' : '插件已卸载',
          })
          return
        }
        json(404, { ok: false, error: 'not found' })
      } catch (error) {
        json(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
