/**
 * 受管插件配置卡片（r7.1 合并）：settings.plugin.item 槽里每个受管插件
 * 一张卡片，标题旁带 "mygo" 小标；schema 与当前配置读 /api/mygo/config-cards，
 * 保存经 PUT /api/mygo/config —— 统一走 mygo 核心方法（bridge 轨 HMR、
 * bundle 轨 profile patch 层），与默认插件配置层不再重复定义。
 * @module @r05en1cu/dsh-mygo-ext-panel/client/PluginConfigCard
 */
import { useCallback, useEffect, useState } from 'react'
import css from './Panel.module.css'
import { ConfigFieldEditor, editableOf, type ConfigFieldShape } from './ConfigFields'

/** config-cards API 返回的一张卡片（注册时捕获的种子信息）。 */
export interface MygoPluginCardSeed {
  readonly id: string
  readonly kind: 'bridge' | 'bundle'
  readonly rowId: string
  readonly packageName: string
  readonly enabled: boolean
}

interface ConfigCardRow extends MygoPluginCardSeed {
  readonly schema: {
    readonly description: string
    readonly fields: readonly ConfigFieldShape[]
    readonly template: unknown
  }
  readonly config: unknown
}

interface CardsResult {
  readonly ok: boolean
  readonly error?: string
  readonly cards?: readonly ConfigCardRow[]
}

interface ActionResult {
  readonly ok: boolean
  readonly error?: string
  readonly message?: string
}

async function fetchJson<T>(path: string, init?: { readonly method?: string; readonly body?: unknown }): Promise<T> {
  const res = await fetch('/api/mygo' + path, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
  })
  return (await res.json()) as T
}

/** 一张受管插件的配置卡片（表单编辑，保存走 mygo 核心 API）。 */
export function MygoPluginConfigCard(props: { readonly seed: MygoPluginCardSeed }): JSX.Element {
  const { seed } = props
  const [row, setRow] = useState<ConfigCardRow | undefined>()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await fetchJson<CardsResult>('/config-cards')
      const mine = (result.cards ?? []).find(card => card.id === seed.id && card.kind === seed.kind)
      if (mine === undefined) {
        setError('卡片数据暂不可用（插件可能刚被卸载）')
        return
      }
      setRow(mine)
      const out: Record<string, unknown> = {}
      for (const field of mine.schema.fields) {
        out[field.name] = editableOf(field, (mine.config as Record<string, unknown> | undefined)?.[field.name])
      }
      setDraft(out)
      setError(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [seed.id, seed.kind])

  useEffect(() => { void load() }, [load])

  const save = useCallback(async (): Promise<void> => {
    setSaving(true)
    setMessage(undefined)
    setError(undefined)
    try {
      const result = await fetchJson<ActionResult>('/config', {
        method: 'PUT',
        body: {
          id: seed.id,
          kind: seed.kind,
          ...(seed.kind === 'bundle' ? { rowId: seed.rowId } : {}),
          config: draft,
        },
      })
      if (!result.ok) throw new Error(result.error ?? '保存失败')
      setMessage(result.message ?? '已保存')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }, [seed.id, seed.kind, seed.rowId, draft, load])

  if (row === undefined && error === undefined) {
    return (
      <div className={css.card}>
        <div className={css.skeletonRow} style={{ height: '120px', border: '0', borderRadius: '12px' }} />
      </div>
    )
  }

  return (
    <div className={css.card}>
      <div className={css.cardBody}>
        <div className={css.cardMain}>
          <div className={css.cardTitleRow}>
            <div className={css.cardTitle}>{seed.id}</div>
            <div className={css.cardBadges}>
              <span className={css.badge + ' ' + css.badgeMygo}>mygo</span>
              <span className={css.railChip}>{seed.kind}</span>
              {!seed.enabled && (
                <span className={css.badge + ' ' + css.badgeOff}>
                  <span className={css.badgeDot} />
                  已停用
                </span>
              )}
            </div>
          </div>
          <div className={css.cardMeta}>
            <span className={css.metaChip}>{seed.packageName}</span>
            <span className={css.metaChip}>·</span>
            <span className={css.metaChip}>由 mygo 核心管理</span>
          </div>
          {row?.schema.description !== undefined && row.schema.description !== '' && (
            <div className={css.fieldHint}>{row.schema.description}</div>
          )}
          {row !== undefined && (
            <div className={css.configFields}>
              {row.schema.fields.map(field => (
                <ConfigFieldEditor
                  key={field.name}
                  field={field}
                  value={draft[field.name]}
                  onChange={(next) => setDraft(current => ({ ...current, [field.name]: next }))}
                />
              ))}
              {row.schema.fields.length === 0 && (
                <div className={css.fieldHint}>插件未暴露可表单化的字段。</div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className={css.details}>
        <div className={css.rowInline}>
          <button className={css.btn + ' ' + css.btnSm} disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存配置'}
          </button>
          {message !== undefined && <span className={css.fieldHint}>{message}</span>}
          {error !== undefined && <span className={css.fieldError}>{error}</span>}
        </div>
      </div>
    </div>
  )
}
