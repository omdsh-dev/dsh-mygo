/**
 * Minimal semver-range matcher: the vocabulary the compatibility checker
 * accepts, with the exact partial/wildcard shorthand the Fabric `depends`
 * ranges rely on.
 */

import { describe, expect, it } from 'vitest'
import { isValidRange, matchesVersionRange } from '@deepseek-ai/dsh-mygo'

describe('semver range matcher', () => {
  it('matches any-range and exact pins', () => {
    expect(matchesVersionRange('1.2.3', '*')).toBe(true)
    expect(matchesVersionRange('1.2.3', '1.2.3')).toBe(true)
    expect(matchesVersionRange('1.2.4', '1.2.3')).toBe(false)
    expect(matchesVersionRange('1.2.3', '=1.2.3')).toBe(true)
    expect(matchesVersionRange('1.2.4', '=1.2.3')).toBe(false)
  })

  it('matches comparison operators', () => {
    expect(matchesVersionRange('1.2.3', '>=0.4.0')).toBe(true)
    expect(matchesVersionRange('0.3.1', '>=0.4.0')).toBe(false)
    expect(matchesVersionRange('1.2.3', '>1.2.2')).toBe(true)
    expect(matchesVersionRange('1.2.2', '>1.2.2')).toBe(false)
    expect(matchesVersionRange('1.2.2', '<=1.2.2')).toBe(true)
    expect(matchesVersionRange('1.2.3', '<2.0.0')).toBe(true)
    expect(matchesVersionRange('2.0.0', '<2.0.0')).toBe(false)
  })

  it('matches partial exact shorthand as ranges', () => {
    expect(matchesVersionRange('1.8.0', '1')).toBe(true)
    expect(matchesVersionRange('2.0.0', '1')).toBe(false)
    expect(matchesVersionRange('1.2.9', '1.2')).toBe(true)
    expect(matchesVersionRange('1.3.0', '1.2')).toBe(false)
    expect(matchesVersionRange('1.2.9', '1.2.x')).toBe(true)
    expect(matchesVersionRange('1.3.0', '1.2.x')).toBe(false)
    expect(matchesVersionRange('1.9.0', '1.x')).toBe(true)
    expect(matchesVersionRange('2.0.0', '1.x')).toBe(false)
  })

  it('normalizes partial comparison operators the semver way', () => {
    expect(matchesVersionRange('1.2.0', '>1.2')).toBe(false)
    expect(matchesVersionRange('1.3.0', '>1.2')).toBe(true)
    expect(matchesVersionRange('1.2.0', '>1.2.0')).toBe(false)
    expect(matchesVersionRange('1.2.5', '>=1.2')).toBe(true)
    expect(matchesVersionRange('1.2.5', '<1.3')).toBe(true)
    expect(matchesVersionRange('1.3.0', '<1.3')).toBe(false)
    expect(matchesVersionRange('1.2.9', '<=1.2')).toBe(true)
    expect(matchesVersionRange('1.3.0', '<=1.2')).toBe(false)
    expect(matchesVersionRange('1.0.0', '>=1')).toBe(true)
    expect(matchesVersionRange('1.9.0', '<2')).toBe(true)
    expect(matchesVersionRange('2.0.0', '<2')).toBe(false)
  })

  it('matches caret and tilde ranges', () => {
    expect(matchesVersionRange('1.9.0', '^1.2.3')).toBe(true)
    expect(matchesVersionRange('2.0.0', '^1.2.3')).toBe(false)
    expect(matchesVersionRange('0.2.9', '^0.2.3')).toBe(true)
    expect(matchesVersionRange('0.3.0', '^0.2.3')).toBe(false)
    expect(matchesVersionRange('0.0.3', '^0.0.3')).toBe(true)
    expect(matchesVersionRange('0.0.4', '^0.0.3')).toBe(false)
    expect(matchesVersionRange('1.2.9', '~1.2.3')).toBe(true)
    expect(matchesVersionRange('1.3.0', '~1.2.3')).toBe(false)
    expect(matchesVersionRange('1.9.0', '~1')).toBe(true)
    expect(matchesVersionRange('2.0.0', '~1')).toBe(false)
    expect(matchesVersionRange('1.2.9', '~1.2')).toBe(true)
    expect(matchesVersionRange('1.3.0', '~1.2')).toBe(false)
  })

  it('supports AND and OR unions', () => {
    expect(matchesVersionRange('1.4.0', '>=0.4.0 <1.5.0')).toBe(true)
    expect(matchesVersionRange('1.6.0', '>=0.4.0 <1.5.0')).toBe(false)
    expect(matchesVersionRange('2.0.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(matchesVersionRange('1.5.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(matchesVersionRange('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false)
  })

  it('compares prerelease identifiers', () => {
    expect(matchesVersionRange('1.2.3', '>=1.2.3-alpha')).toBe(true)
    expect(matchesVersionRange('1.2.3-alpha', '>=1.2.3-alpha')).toBe(true)
    expect(matchesVersionRange('1.2.3-alpha.1', '>=1.2.3-alpha')).toBe(true)
    expect(matchesVersionRange('1.2.3-beta', '>=1.2.3-alpha')).toBe(true)
    expect(matchesVersionRange('1.2.2', '>=1.2.3-alpha')).toBe(false)
  })

  it('rejects unparsable versions and ranges', () => {
    expect(matchesVersionRange('abc', '>=1.0.0')).toBe(false)
    expect(matchesVersionRange('1.2.3', 'not-a-range')).toBe(false)
    expect(isValidRange('>=1.0.0')).toBe(true)
    expect(isValidRange('>=1.0.0 <2.0.0')).toBe(true)
    expect(isValidRange('not-a-range')).toBe(false)
    expect(isValidRange('')).toBe(false)
  })
})
