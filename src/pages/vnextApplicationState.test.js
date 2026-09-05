import { describe, expect, it } from 'vitest'
import { normalizeVNextApplicationState } from './vnextApplicationState.js'

describe('normalizeVNextApplicationState', () => {
  it('canonicalizes a legacy lowercase state so sequential advancement remains reachable', () => {
    expect(normalizeVNextApplicationState(' discovered ')).toBe('DISCOVERED')
    expect(normalizeVNextApplicationState('schema_ready')).toBe('SCHEMA_READY')
  })

  it('defaults an absent state without disguising an unknown stored value', () => {
    expect(normalizeVNextApplicationState(null)).toBe('DISCOVERED')
    expect(normalizeVNextApplicationState('legacy_custom')).toBe('LEGACY_CUSTOM')
  })
})


