import type { HubInstallIntent } from './registry.ts'

/** 翻译产物：pnpm（交 profile 执行面）或 display（只展示/拒绝）。 */
export type HubTranslatedInstall =
  | {
    readonly kind: 'pnpm'
    readonly spec: string
    readonly packageName: string
  }
  | { readonly kind: 'display'; readonly reason: string }

const EXACT_SEMVER_RE = /^(?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const PINNED_GIT_RE = /^(?:git\+https:\/\/|https:\/\/|github:)[^#\s]+#[0-9a-f]{40}$/
export interface TranslateHubInstallOptions {
  /**
   * 本地快照来源（离线验证/内网镜像）允许 file: spec；远程 registry 的
   * profile-bundle spec 必须是精确 semver 或钉 commit git（registry-core
   * isExactPackageSpec 同口径）。
   */
  readonly allowFileSpec?: boolean
}

export async function translateHubInstall(
  intent: HubInstallIntent,
  options: TranslateHubInstallOptions = {},
): Promise<HubTranslatedInstall> {
  if (intent.mode !== 'profile-bundle'
    || typeof intent.packageName !== 'string'
    || typeof intent.spec !== 'string') {
    return {
      kind: 'display',
      reason: 'hub 条目没有可执行安装意图',
    }
  }
  const { packageName, spec } = intent
  if (EXACT_SEMVER_RE.test(spec)) {
    return { kind: 'pnpm', spec: `${packageName}@${spec}`, packageName }
  }
  if (PINNED_GIT_RE.test(spec)) {
    return { kind: 'pnpm', spec, packageName }
  }
  if (options.allowFileSpec === true && /^(?:file:\S+|\/\S+|\S+\.(?:tgz|tar\.gz))$/.test(spec)) {
    return { kind: 'pnpm', spec, packageName }
  }
  return {
    kind: 'display',
    reason: `profile-bundle spec 不是精确 semver / 钉 commit git（${spec}），拒绝安装`,
  }
}
