/**
 * 安装标签页（r7）：GitHub / 文件夹 / 压缩包 / Bundle 四种来源，字段校验、
 * plan 预览、warnings 确认、配置模板自动生成与安装进度。
 * @module @r05en1cu/dsh-mygo-ext-panel/client/InstallPanel
 */
import { useCallback, useState } from 'react'
import css from './Panel.module.css'
import { api, ApiError, type PlanShape } from './api'
import { ConfirmDialog } from './ConfirmDialog'

export interface InstallPanelProps {
  readonly onRefresh: () => void
  readonly onError: (message: string, details?: Readonly<Record<string, unknown>>) => void
  readonly onNotice: (message: string) => void
}

type InstallMethod = 'github' | 'folder' | 'archive' | 'bundle'

interface PendingInstall {
  readonly id: string
  readonly plan: PlanShape
  readonly payload: Record<string, unknown>
  readonly hostConflicts?: readonly string[]
}

const METHOD_LABEL: Record<InstallMethod, string> = {
  github: 'GitHub',
  folder: '文件夹',
  archive: '压缩包',
  bundle: 'Bundle',
}

export function InstallPanel(props: InstallPanelProps): JSX.Element {
  const { onRefresh, onError, onNotice } = props
  const [method, setMethod] = useState<InstallMethod>('github')
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [path, setPath] = useState('')
  const [spec, setSpec] = useState('')
  const [configText, setConfigText] = useState('')
  const [configError, setConfigError] = useState<string | undefined>()
  const [installDeps, setInstallDeps] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [fieldError, setFieldError] = useState<string | undefined>()
  const [pending, setPending] = useState<PendingInstall | undefined>()
  const [templateNotice, setTemplateNotice] = useState<string | undefined>()

  const validate = (): Record<string, unknown> | undefined => {
    setFieldError(undefined)
    setConfigError(undefined)
    let payload: Record<string, unknown>
    if (method === 'bundle') {
      if (spec.trim() === '') {
        setFieldError('请填写 bundle spec，如 @pkg/name@^1.0.0 或 github:owner/repo#ref')
        return undefined
      }
      payload = { method, spec: spec.trim() }
    } else if (method === 'github') {
      if (!/^https?:\/\/.+/.test(url.trim())) {
        setFieldError('请填写完整的 https://github.com/xxx/yyy 地址')
        return undefined
      }
      payload = { method, url: url.trim(), ...(ref.trim() === '' ? {} : { ref: ref.trim() }) }
    } else {
      if (path.trim() === '') {
        setFieldError(`请填写插件${method === 'folder' ? '目录' : '压缩包'}的绝对路径`)
        return undefined
      }
      payload = { method, path: path.trim() }
    }
    if (configText.trim() !== '') {
      try {
        payload.config = JSON.parse(configText)
      } catch (caught) {
        setConfigError(caught instanceof Error ? caught.message : String(caught))
        return undefined
      }
    }
    payload.installDeps = installDeps
    return payload
  }

  const install = useCallback(async (): Promise<void> => {
    const payload = validate()
    if (payload === undefined) return
    setInstalling(true)
    setTemplateNotice(undefined)
    try {
      if (method === 'bundle') {
        const result = await api.bundlesInstall(payload.spec as string)
        const plan = result.plan
        if (plan !== undefined
          && !plan.accepted
          || ((plan.warnings ?? []).length > 0 || (result.hostConflicts ?? []).length > 0)) {
          setPending({
            id: result.id,
            plan,
            payload,
            ...(result.hostConflicts === undefined ? {} : { hostConflicts: result.hostConflicts }),
          })
          return
        }
        onNotice(result.message)
        setSpec('')
        onRefresh()
        return
      }
      const preview = await api.installPlan(payload)
      const plan = preview.plan
      if (!plan.accepted) {
        onError(`安装被拒：${plan.error?.message ?? '未知原因'}`)
        return
      }
      if (preview.configTemplate !== undefined && configText.trim() === '') {
        const template = JSON.stringify(preview.configTemplate, null, 2)
        setConfigText(template)
        setTemplateNotice('已按插件 schema 自动生成配置模板，可编辑后直接安装')
      }
      if ((plan.warnings ?? []).length === 0) {
        const result = await api.install(payload)
        onNotice(result.message)
        setUrl('')
        setRef('')
        setPath('')
        setConfigText('')
        setInstallDeps(false)
        onRefresh()
        return
      }
      setPending({ id: preview.id, plan, payload })
    } catch (caught) {
      if (caught instanceof ApiError) onError(caught.message, caught.details)
      else onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setInstalling(false)
    }
  }, [method, url, ref, path, spec, configText, installDeps, onRefresh, onError, onNotice])

  const confirmInstall = useCallback(async (): Promise<void> => {
    if (pending === undefined) return
    const current = pending
    setPending(undefined)
    setInstalling(true)
    try {
      const result = current.payload.method === 'bundle'
        ? { message: `bundle ${current.id} 已安装` }
        : await api.install(current.payload)
      onNotice(result.message)
      setUrl('')
      setRef('')
      setSpec('')
      setPath('')
      setConfigText('')
      setInstallDeps(false)
      onRefresh()
    } catch (caught) {
      if (caught instanceof ApiError) onError(caught.message, caught.details)
      else onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setInstalling(false)
    }
  }, [pending, onRefresh, onError, onNotice])

  const switchMethod = (next: InstallMethod): void => {
    setMethod(next)
    setFieldError(undefined)
    setPending(undefined)
    setTemplateNotice(undefined)
  }

  return (
    <div className={css.installCard}>
      <div className={css.segmented}>
        {(Object.keys(METHOD_LABEL) as InstallMethod[]).map(entry => (
          <button
            key={entry}
            className={method === entry ? css.segBtn + ' ' + css.segActive : css.segBtn}
            disabled={installing}
            onClick={() => switchMethod(entry)}
          >
            {METHOD_LABEL[entry]}
          </button>
        ))}
      </div>
      {method === 'bundle' && (
        <div className={css.fieldGroup}>
          <div className={css.fieldLabel}>Bundle spec</div>
          <input
            className={css.input}
            placeholder="@pkg/name@^1.0.0 或 github:owner/repo#ref"
            value={spec}
            disabled={installing}
            onChange={(event) => setSpec(event.target.value)}
          />
          <div className={css.fieldHint}>引用式安装：npm 包 / GitHub 仓库引用，由 profile 执行面解析。</div>
        </div>
      )}
      {method === 'github' && (
        <div className={css.fieldGroup}>
          <div className={css.fieldLabel}>GitHub 仓库地址</div>
          <div className={css.row}>
            <input
              className={css.input}
              placeholder="https://github.com/xxx/yyy"
              value={url}
              disabled={installing}
              onChange={(event) => setUrl(event.target.value)}
            />
            <input
              className={css.input}
              placeholder="分支（可选）"
              value={ref}
              disabled={installing}
              onChange={(event) => setRef(event.target.value)}
            />
          </div>
        </div>
      )}
      {(method === 'folder' || method === 'archive') && (
        <div className={css.fieldGroup}>
          <div className={css.fieldLabel}>{method === 'folder' ? '插件目录' : '压缩包文件'}</div>
          <input
            className={css.input}
            placeholder={method === 'folder' ? '/绝对/路径/插件目录' : '/绝对/路径/插件.zip 或 .tar.gz'}
            value={path}
            disabled={installing}
            onChange={(event) => setPath(event.target.value)}
          />
        </div>
      )}
      <div className={css.fieldGroup}>
        <div className={css.fieldLabel}>插件配置（可选）</div>
        <textarea
          className={css.configTextarea}
          rows={4}
          spellCheck={false}
          placeholder='JSON 对象，如 {"baseURL":"http://127.0.0.1:11434/v1"}'
          value={configText}
          disabled={installing}
          onChange={(event) => { setConfigText(event.target.value); setConfigError(undefined) }}
        />
        {templateNotice !== undefined && <div className={css.fieldHint}>{templateNotice}</div>}
        {configError !== undefined && <div className={css.fieldError}>配置 JSON 无效：{configError}</div>}
      </div>
      <label className={css.depsRow}>
        <input
          type="checkbox"
          checked={installDeps}
          disabled={installing}
          onChange={(event) => setInstallDeps(event.target.checked)}
        />
        <span>自动安装依赖并构建（npm install + npm run build）</span>
      </label>
      {fieldError !== undefined && <div className={css.fieldError}>{fieldError}</div>}
      {installing && (
        <div className={css.progressRow}>
          <span className={css.spinner} />
          <span>{pending !== undefined ? '安装中…' : '准备中…（克隆/解压/构建可能需要一些时间）'}</span>
        </div>
      )}
      <div className={css.rowInline}>
        <button className={css.btn} disabled={installing} onClick={() => void install()}>
          {installing ? '处理中…' : '安装'}
        </button>
      </div>
      <ConfirmDialog
        open={pending !== undefined}
        title={'安装 ' + (pending?.id ?? '')}
        message={pending !== undefined
          && (pending.plan.warnings ?? []).length === 0
          && (pending.hostConflicts ?? []).length === 0
          && pending.plan.error === undefined
          ? '计划已通过，确认开始安装。'
          : undefined}
        plan={pending?.plan}
        hostConflicts={pending?.hostConflicts}
        busy={installing}
        confirmLabel="确认安装"
        onConfirm={() => void confirmInstall()}
        onCancel={() => { setPending(undefined); onRefresh() }}
      />
    </div>
  )
}
