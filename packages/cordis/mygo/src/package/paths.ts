/**
 * mygo 基础路径（《收敛任务》不变量 6/7）：一切相对 `$DSH_HOME/mygo` 分配，
 * 禁止依赖 process.cwd / __dirname / dsh 安装位置 / npx 缓存。
 * @module @deepseek-ai/dsh-mygo/src/package/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** All mygo-allocated paths for one profile. */
export interface MygoPaths {
  /** `$DSH_HOME/mygo` */
  readonly base: string
  /** Immutable plugin store: `<base>/packages/<id>/<version>/` */
  readonly packagesRoot: string
  /** Lockfiles: `<base>/lockfiles/` */
  readonly lockfileDir: string
  /** Plugin config: `<base>/config/` */
  readonly configDir: string
  /** Install staging: `<base>/tmp/` */
  readonly tmpDir: string
  /** Generated bridge packages: `<base>/bridges/` */
  readonly bridgesDir: string
}

/**
 * Resolve `$DSH_HOME` deterministically from the environment (or the user
 * home default). Never consults `process.cwd()`.
 */
export function resolveDshHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const explicit = env.DSH_HOME
  return typeof explicit === 'string' && explicit !== '' ? explicit : join(homedir(), '.dsh')
}

/** Resolve all mygo-allocated paths. */
export function resolveMygoPaths(
  _profile: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): MygoPaths {
  const base = join(resolveDshHome(env), 'mygo')
  return {
    base,
    packagesRoot: join(base, 'packages'),
    lockfileDir: join(base, 'lockfiles'),
    configDir: join(base, 'config'),
    tmpDir: join(base, 'tmp'),
    bridgesDir: join(base, 'bridges'),
  }
}

/** Lockfile path for one profile. */
export function lockfilePath(paths: MygoPaths, profile: string): string {
  return join(paths.lockfileDir, `${profile}.dsh.lock.json`)
}

/** Installed package dir for one plugin id+version. */
export function packageDir(paths: MygoPaths, id: string, version: string): string {
  return join(paths.packagesRoot, id, version)
}

/** Plugin config file path. */
export function pluginConfigPath(paths: MygoPaths, id: string): string {
  return join(paths.configDir, `${id}.json`)
}

/**
 * Resolve the dsh core version: `DSH_CORE_VERSION` env override, then a
 * caller-provided anchor (the npm-dsh package version), else `undefined`.
 * Tests inject `DSH_CORE_VERSION` for determinism.
 */
export function resolveCoreVersion(
  env: Readonly<Record<string, string | undefined>> = process.env,
  anchor?: { readonly version?: string },
): string | undefined {
  if (typeof env.DSH_CORE_VERSION === 'string' && env.DSH_CORE_VERSION !== '') {
    return env.DSH_CORE_VERSION
  }
  return anchor?.version
}
