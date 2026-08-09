/**
 * Type-carrying entry point for plugin authors.
 * @module @deepseek-ai/dsh-mygo-api/src/define
 */

import type { PluginDefinition } from './types.ts'

/**
 * Type carrier for a plugin manifest. The identity function gives the author
 * full typing of the declaration and returns it unchanged; mount-time
 * validation belongs to the plugin manager, not this package.
 * @param definition - plugin manifest to carry.
 * @returns the same definition, unchanged.
 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition
}
