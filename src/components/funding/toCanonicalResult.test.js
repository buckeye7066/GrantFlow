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

describe('toCanonicalResult evidence levels (result-quality PR3)', () => {
  const base = { id: 'o1', title: 'T', source: 's' }

  it('reads the engine-recorded level from match_explain_json (string or object)', () => {
    expect(toCanonicalResult({ ...base, match_explain_json: JSON.stringify({ eligibility_evidence: 'structured_flags' }) }).eligibility_evidence)
      .toBe('structured_flags')
    expect(toCanonicalResult({ ...base, match_explain: { eligibility_evidence: 'none' } }).eligibility_evidence).toBe('none')
  })

  it('falls back to the proof evidence_basis, then the proof arrays, then the row text', () => {
    expect(toCanonicalResult({ ...base, match_explain_json: { four_truth_proof: { evidence_basis: { eligibility: 'applicant_types_only' } } } }).eligibility_evidence)
      .toBe('applicant_types_only')
    expect(toCanonicalResult({ ...base, match_explain_json: { four_truth_proof: { profile_qualifies: { eligibility_prose_evidence: ['Must be 18+'] } } } }).eligibility_evidence)
      .toBe('prose')
    expect(toCanonicalResult({ ...base, match_explain_json: { four_truth_proof: { profile_qualifies: { applicant_type_evidence: ['individual'], eligibility_prose_evidence: [] } } } }).eligibility_evidence)
      .toBe('applicant_types_only')
    expect(toCanonicalResult({ ...base, eligibility_text: 'TN residents only' }).eligibility_evidence).toBe('prose')
  })

  it('is "unknown" — never "prose" — when nothing recorded any evidence', () => {
    expect(toCanonicalResult(base).eligibility_evidence).toBe('unknown')
    expect(toCanonicalResult({ ...base, match_explain_json: 'not json' }).eligibility_evidence).toBe('unknown')
  })

  it('derives geo evidence from the proof, else the row; NULL state and not national is unknown', () => {
    expect(toCanonicalResult({ ...base, is_national: 1 }).geo_evidence).toBe('national')
    expect(toCanonicalResult({ ...base, state: 'TN' }).geo_evidence).toBe('stated')
    expect(toCanonicalResult({ ...base, state: 'nationwide' }).geo_evidence).toBe('national')
    expect(toCanonicalResult({ ...base, state: null, is_national: false }).geo_evidence).toBe('unknown')
    expect(toCanonicalResult({ ...base, state: 'TN', match_explain_json: { four_truth_proof: { evidence_basis: { geography: 'unknown' } } } }).geo_evidence).toBe('unknown')
  })

  it('honors explicit evidence fields already on the row', () => {
    const r = toCanonicalResult({ ...base, eligibility_evidence: 'none', geo_evidence: 'national' })
    expect(r.eligibility_evidence).toBe('none')
    expect(r.geo_evidence).toBe('national')
  })
})
