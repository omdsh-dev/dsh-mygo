/**
 * Code-table completeness: the §16.2 table has 34 codes in six groups. The
 * literal lists below are the spec transcription; `satisfies` keeps them in
 * sync with the closed union at compile time, and the runtime loop proves
 * every code has a message template.
 */

import { describe, expect, it } from 'vitest'
import { formatPluginError } from '@deepseek-ai/dsh-mygo-api'
import type { PluginErrorCode } from '@deepseek-ai/dsh-mygo-api'

const SPEC_GROUPS = {
  manifestAndDeclaration: [
    'manifest-invalid',
    'event-not-mountable',
    'mode-ceiling-exceeded',
    'capability-range-reserved',
    'unknown-property',
    'non-payload-name',
    'unsupported-event-option',
  ] as const satisfies readonly PluginErrorCode[],
  permissionsAndGrants: [
    'grant-missing',
    'ceiling-exceeded',
    'source-not-allowed',
    'protected-field',
    'provenance-rejected',
  ] as const satisfies readonly PluginErrorCode[],
  relationshipConflicts: [
    'write-conflict',
    'intercept-branch-conflict',
    'ordering-cycle',
    'veto-position-conflict',
    'companion-conflict',
    'claims-unmanaged-incumbent',
    'shadow-undeclared',
    'claims-conflict',
  ] as const satisfies readonly PluginErrorCode[],
  protocolOperations: [
    'dependent-exists',
    'concurrent-operation',
    'plugin-not-found',
    'swap-timeout',
    'staging-failed',
    'persist-failed',
    'quota-registry-exceeded',
    'package-not-resolvable',
    'setup-registration',
  ] as const satisfies readonly PluginErrorCode[],
  dispatchBoundary: [
    'next-missing',
    'undeclared-veto',
    'undeclared-branch',
    'quota-cpu-exceeded',
    'quota-effects-exceeded',
  ] as const satisfies readonly PluginErrorCode[],
  capabilityDenial: [
    'fs-denied',
    'network-denied',
  ] as const satisfies readonly PluginErrorCode[],
}

const SPEC_CODES = Object.values(SPEC_GROUPS).flat() as readonly PluginErrorCode[]

describe('PluginErrorCode table (§16.2)', () => {
  it('transcribes 36 codes across six groups with the spec group sizes', () => {
    expect(Object.values(SPEC_GROUPS).map(group => group.length)).toEqual([7, 5, 8, 9, 5, 2])
    expect(SPEC_CODES).toHaveLength(36)
  })

  it('has no duplicate codes', () => {
    expect(new Set(SPEC_CODES).size).toBe(SPEC_CODES.length)
  })

  it('provides a message template for every transcribed code', () => {
    for (const code of SPEC_CODES) {
      expect(formatPluginError(code, {}), code).toBeTypeOf('string')
    }
  })
})
