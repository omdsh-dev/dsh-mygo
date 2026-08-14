/**
 * dsh-mygo-panel browser half — a dsh web Settings section that lists and
 * manages mygo-managed plugins. All data crosses the /api/mygo JSON API.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { Panel } from './Panel'
import { MygoConfigCards } from './ConfigCards'

/**
 * settings.plugin.item 槽契约镜像（与官方 dsh-client-ui-settings-plugins
 * slot-contract 同形状：kind list / scope root / owner 空）。面板暂不引入
 * 该包为 devDep（其 peer 闭包含未公开发布的内部包，pnpm 解析会撞 404）；
 * 解析墙解除后改回官方类型导入。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.plugin.item': {
      readonly kind: 'list'
      readonly scope: 'root'
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type
      readonly owner: Record<string, never>
    }
  }
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mygo-plugins',
    order: 70,
    label: () => 'My 插件',
    inject: () => ({}),
  }, Panel))
  // r6 配置注入：有 Config schema 的受管插件经聚合卡片进 webui 插件设置页。
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'mygo-configs',
    order: 70,
    label: () => 'mygo 插件配置',
    inject: () => ({}),
  }, MygoConfigCards))
}
