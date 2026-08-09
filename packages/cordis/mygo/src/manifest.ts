/**
 * Mount-time manifest validation (§16.2 group 1): a strict zod schema over
 * the `PluginDefinition` shape. Violations throw `manifest-invalid` with the
 * failing field path and the expected contract as details.
 * @module @deepseek-ai/dsh-mygo/src/manifest
 */

import { PluginError, formatPluginError } from '@deepseek-ai/dsh-mygo-api'
import { z } from 'zod'

const pluginId = z.string().regex(/^[a-z][a-z0-9-]*$/)
const semverShape = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
const kindName = z.string().min(1).regex(/^[a-z][a-z0-9-]*$/)

const transformDeclaration = z.object({
  event: z.string(),
  reads: z.array(z.string()).optional(),
  writes: z.array(z.string()).optional(),
  appends: z.array(z.string()).optional(),
})

const interceptDeclaration = z.object({
  event: z.string(),
  returns: z.array(z.string()),
})

const permissionLevel = z.enum(['outermost', 'derived', 'innermost'])
const fileAccessMode = z.enum(['read', 'write'])

/**
 * Strict manifest schema (§2/§5). Functions (hooks, the schemastery config
 * schema) are accepted structurally through `z.custom`; their behavior is
 * exercised by the lifecycle stages, not this shape gate.
 */
export const MANIFEST_SCHEMA = z.object({
  id: pluginId,
  version: semverShape,
  kinds: z.array(kindName),
  requires: z.array(z.string()),
  provides: z.array(z.string()),
  permissions: z.object({
    observe: z.array(z.string()),
    transform: z.array(transformDeclaration),
    intercept: z.array(interceptDeclaration),
    position: permissionLevel,
    claims: z.array(z.string()),
  }),
  fileAccess: z.array(z.tuple([fileAccessMode, z.string()])).optional(),
  networkAccess: z.object({ allow: z.array(z.string()) }).optional(),
  stateful: z.boolean(),
  swapPolicy: z.enum(['immediate', 'drain', 'next-idle']),
  config: z.custom(value => typeof value === 'function', 'schemastery schema'),
  hooks: z.object({
    setup: z.custom(value => typeof value === 'function', 'function').optional(),
    activate: z.custom(value => typeof value === 'function', 'function'),
    deactivate: z.custom(value => typeof value === 'function', 'function').optional(),
    captureState: z.custom(value => typeof value === 'function', 'function').optional(),
    restoreState: z.custom(value => typeof value === 'function', 'function').optional(),
    dispose: z.custom(value => typeof value === 'function', 'function').optional(),
  }),
}).strict()

/**
 * Validate one manifest against {@link MANIFEST_SCHEMA}. Any violation throws
 * `manifest-invalid` naming the failing field and the expected contract.
 * @param manifest - the runtime manifest to validate.
 * @param pluginId - owning plugin id for error attribution (the declared id when known).
 */
export function validateManifest(manifest: unknown, pluginId?: string): void {
  const result = MANIFEST_SCHEMA.safeParse(manifest)
  if (result.success) return
  // A failed safeParse always carries at least one issue.
  // A failed safeParse always carries at least one issue; the cast keeps the
  // narrow access without a runtime branch.
  const issue = result.error.issues[0] as { readonly path: readonly (string | number)[]; readonly message: string }
  const field = issue.path.join('.') || 'manifest'
  const expected = issue.message
  throw new PluginError(
    'manifest-invalid',
    formatPluginError('manifest-invalid', { field, expected }),
    { field, expected },
    pluginId,
  )
}
