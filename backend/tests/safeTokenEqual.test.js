import { describe, expect, it } from 'vitest'
import { safeTokenEqual } from '../utils/safeTokenEqual.js'

// Hardening regression (production-readiness review): admin / Anya / bulk / health
// service tokens must be compared in constant time so response timing can't leak
// the shared prefix length and enable byte-by-byte token recovery.
describe('safeTokenEqual', () => {
  it('returns true for identical non-empty strings', () => {
    expect(safeTokenEqual('s3cr3t-token-abc', 's3cr3t-token-abc')).toBe(true)
  })

  it('returns false for differing same-length strings', () => {
    expect(safeTokenEqual('s3cr3t-token-abc', 's3cr3t-token-xyz')).toBe(false)
  })

  it('returns false for length-mismatched strings (no timingSafeEqual throw)', () => {
    expect(safeTokenEqual('short', 'a-much-longer-token-value')).toBe(false)
  })

  it('returns false when either side is empty', () => {
    expect(safeTokenEqual('', '')).toBe(false)
    expect(safeTokenEqual('abc', '')).toBe(false)
    expect(safeTokenEqual('', 'abc')).toBe(false)
  })

  it('returns false for null/undefined/non-string input (unset env tokens)', () => {
    expect(safeTokenEqual(null, 'abc')).toBe(false)
    expect(safeTokenEqual('abc', null)).toBe(false)
    expect(safeTokenEqual(undefined, undefined)).toBe(false)
    expect(safeTokenEqual(123, 123)).toBe(false)
    expect(safeTokenEqual('abc', { toString: () => 'abc' })).toBe(false)
  })

  it('does not throw on any input type', () => {
    expect(() => safeTokenEqual(Symbol('x'), [])).not.toThrow()
    expect(safeTokenEqual(Symbol('x'), [])).toBe(false)
  })
})
