/**
 * 通用配置表单组件（r6 提取共享）：schemastery-style 字段编辑器（标量
 * 控件 + 嵌套对象组），Panel 与 settings.plugin.item 配置卡片共用。
 * @module @r05en1cu/dsh-mygo-ext-panel/client/ConfigFields
 */
import css from './Panel.module.css'

/** One configurable field surfaced by the panel (mirrors the server shape). */
export interface ConfigFieldShape {
  readonly name: string
  readonly type: string
  readonly required: boolean
  readonly description?: string
  readonly role?: string
  readonly extra?: unknown
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly pattern?: string
  readonly default?: unknown
  readonly literal?: unknown
  readonly enumValues?: readonly unknown[]
  readonly children?: readonly ConfigFieldShape[]
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Starter value for one field (schema default first, then type placeholder). */
export function defaultValueOf(field: ConfigFieldShape): unknown {
  if (field.default !== undefined) return field.default
  switch (field.type) {
    case 'string':
      return ''
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return false
    case 'const':
      return field.literal
    case 'union':
      return field.enumValues?.[0]
    case 'array':
      return []
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const child of field.children ?? []) out[child.name] = defaultValueOf(child)
      return out
    }
    default:
      return undefined
  }
}

/** Current value merged with schema defaults, one level per field. */
export function editableOf(field: ConfigFieldShape, current: unknown): unknown {
  if (field.type === 'object') {
    const base = isPlainObject(current) ? current : {}
    const out: Record<string, unknown> = {}
    for (const child of field.children ?? []) out[child.name] = editableOf(child, base[child.name])
    return out
  }
  return current === undefined ? defaultValueOf(field) : current
}

/** Schemastery-style field editor: scalar controls + nested object groups. */
export function ConfigFieldEditor(props: {
  readonly field: ConfigFieldShape
  readonly value: unknown
  readonly onChange: (value: unknown) => void
}): JSX.Element {
  const { field, value, onChange } = props
  const setRaw = (raw: string): void => {
    if (field.type === 'number' || field.type === 'integer') {
      const parsed = raw === '' ? 0 : Number(raw)
      onChange(Number.isFinite(parsed) ? parsed : 0)
    } else if (field.type === 'boolean') {
      onChange(raw === 'true')
    } else {
      onChange(raw)
    }
  }
  let control: JSX.Element
  if (field.type === 'object') {
    control = (
      <div className={css.configFields}>
        {(field.children ?? []).map(child => (
          <ConfigFieldEditor
            key={child.name}
            field={child}
            value={isPlainObject(value) ? value[child.name] : defaultValueOf(child)}
            onChange={(next) => {
              const base = isPlainObject(value) ? { ...value } : {}
              onChange({ ...base, [child.name]: next })
            }}
          />
        ))}
      </div>
    )
  } else if (field.type === 'boolean') {
    control = (
      <input
        className={css.input}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    )
  } else if (field.type === 'number' || field.type === 'integer') {
    control = (
      <input
        className={css.input}
        type="number"
        value={typeof value === 'number' ? value : 0}
        min={field.min}
        max={field.max}
        step={field.step}
        onChange={(event) => setRaw(event.target.value)}
      />
    )
  } else if (field.type === 'const') {
    control = <span className={css.configFieldType}>{String(field.literal ?? '')}</span>
  } else if (field.role === 'select' || (field.type === 'union' && (field.enumValues ?? []).length > 0)) {
    const extraOptions = (field.extra as { readonly options?: readonly unknown[] } | undefined)?.options
    const options = extraOptions ?? field.enumValues ?? []
    control = (
      <select
        className={css.input}
        value={typeof value === 'string' ? value : String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option, index) => (
          <option key={index} value={String(option)}>{String(option)}</option>
        ))}
      </select>
    )
  } else if (field.role === 'textarea' || field.type === 'array' || field.type === 'dict') {
    control = (
      <textarea
        className={css.configTextarea}
        rows={3}
        spellCheck={false}
        defaultValue={typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)}
        onBlur={(event) => {
          const raw = event.target.value
          try {
            onChange(field.type === 'string' ? raw : JSON.parse(raw))
          } catch {
            onChange(field.type === 'string' ? raw : (value ?? ''))
          }
        }}
      />
    )
  } else {
    control = (
      <input
        className={css.input}
        type={field.role === 'color' ? 'color' : 'text'}
        value={typeof value === 'string' ? value : String(value ?? '')}
        pattern={field.pattern}
        onChange={(event) => setRaw(event.target.value)}
      />
    )
  }
  return (
    <div className={css.configField}>
      <div className={css.row}>
        <span className={css.configFieldName}>{field.name}</span>
        <span className={css.configFieldType}>
          {field.type}{field.required ? ' · 必填' : ' · 可选'}
          {field.literal !== undefined ? ` · ${String(field.literal)}` : ''}
        </span>
        {field.default !== undefined && (
          <span className={css.configFieldDefault}>默认 {JSON.stringify(field.default)}</span>
        )}
      </div>
      {field.description !== undefined && <div className={css.inlineText}>{field.description}</div>}
      {control}
    </div>
  )
}
