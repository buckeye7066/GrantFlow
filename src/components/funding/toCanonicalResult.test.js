import { describe, expect, it } from 'vitest'
import { toCanonicalResult } from './toCanonicalResult.js'

// The backend verifier (linkVerificationService) stores ok|redirect|broken|
// skipped|unverified; the card renders verified|redirect|broken|unverified|
// unreachable. This adapter is the vocabulary boundary — a proven-live link
// must never surface as unverified, and vice versa (epic slice 2).
describe('toCanonicalResult link-status vocabulary', () => {
  const base = { id: 'o1', title: 'T', source: 's' }

  it('maps the verifier "ok" to canonical "verified"', () => {
    expect(toCanonicalResult({ ...base, link_status: 'ok' }).link_status).toBe('verified')
  })

  it('maps the verifier "skipped" to canonical "unverified"', () => {
    expect(toCanonicalResult({ ...base, link_status: 'skipped' }).link_status).toBe('unverified')
  })

  it('passes canonical statuses through unchanged', () => {
    for (const s of ['verified', 'redirect', 'broken', 'unreachable', 'unverified']) {
      expect(toCanonicalResult({ ...base, link_status: s }).link_status).toBe(s)
    }
  })

  it('never synthesizes "verified" for a row nothing has probed', () => {
    expect(toCanonicalResult(base).link_status).toBe('unverified')
  })

  it('carries last_verified_at so the card can say when the link was checked', () => {
    const r = toCanonicalResult({ ...base, link_status: 'ok', last_verified_at: '2026-08-15T00:00:00.000Z' })
    expect(r.last_verified_at).toBe('2026-08-15T00:00:00.000Z')
  })

  it('carries missing_eligibility_fields (the "unknown" leg of the explanation triad)', () => {
    const r = toCanonicalResult({ ...base, missing_eligibility_fields: ['profile.applicant_type'] })
    expect(r.missing_eligibility_fields).toEqual(['profile.applicant_type'])
  })

  it('defaults missing_eligibility_fields to an empty list, never undefined', () => {
    expect(toCanonicalResult(base).missing_eligibility_fields).toEqual([])
  })
})
