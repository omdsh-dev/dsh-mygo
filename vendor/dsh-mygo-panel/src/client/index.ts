/**
 * dsh-mygo-panel browser half — a dsh web Settings section that lists and
 * manages mygo-managed plugins. All data crosses the /api/mygo JSON API.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { Panel } from './Panel'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mygo-plugins',
    order: 70,
    label: () => 'My 插件',
    inject: () => ({}),
  }, Panel))
}
