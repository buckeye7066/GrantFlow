import { describe, it, expect } from 'vitest'
import {
  validateResultPayload,
  computeFingerprint,
  normalizeErrorSignature,
  normalizeFailureClass,
  redactText,
  redactDeep,
  EVA_SCHEMA_VERSION,
} from '../services/eva/evaTypes.js'

function validPayload(overrides = {}) {
  return {
    schema_version: EVA_SCHEMA_VERSION,
    run_id: 'run-abc-1',
    runner_id: 'runner-1',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    environment: 'fixture',
    apps: [
      {
        app_id: 'grantflow',
        display_name: 'GrantFlow',
        app_status: 'tested',
        duration_ms: 1000,
        journeys: [{ journey_id: 'login', name: 'Login', status: 'passed' }],
      },
    ],
    ...overrides,
  }
}

describe('validateResultPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(validateResultPayload(validPayload()).ok).toBe(true)
  })

  it('rejects a wrong schema_version', () => {
    const r = validateResultPayload(validPayload({ schema_version: 999 }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/schema_version/)
  })

  it('requires the full diagnostic bundle on a FAILED journey', () => {
    const p = validPayload({
      apps: [
        {
          app_id: 'grantflow',
          display_name: 'GrantFlow',
          app_status: 'tested',
          duration_ms: 1,
          journeys: [{ journey_id: 'x', name: 'X', status: 'failed' }],
        },
      ],
    })
    const r = validateResultPayload(p)
    expect(r.ok).toBe(false)
    // severity, retry_classification, failure_class, expected/observed, impact, repro, confidence all required
    expect(r.errors.join(' ')).toMatch(/severity/)
    expect(r.errors.join(' ')).toMatch(/repro_steps/)
    expect(r.errors.join(' ')).toMatch(/diagnostic_confidence/)
  })

  it('requires missing_evidence when confidence < 0.70', () => {
    const p = validPayload({
      apps: [
        {
          app_id: 'grantflow',
          display_name: 'GrantFlow',
          app_status: 'tested',
          duration_ms: 1,
          journeys: [
            {
              journey_id: 'x',
              name: 'X',
              status: 'failed',
              severity: 'high',
              retry_classification: 'reproducible',
              failure_class: 'assertion',
              expected_behavior: 'a',
              observed_behavior: 'b',
              user_impact: 'c',
              repro_steps: ['s1'],
              diagnostic_confidence: 0.4,
            },
          ],
        },
      ],
    })
    const r = validateResultPayload(p)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/missing_evidence required/)
  })

  it('rejects candidate_files asserted at implausibly low confidence', () => {
    const p = validPayload({
      apps: [
        {
          app_id: 'grantflow',
          display_name: 'GrantFlow',
          app_status: 'tested',
          duration_ms: 1,
          journeys: [
            {
              journey_id: 'x',
              name: 'X',
              status: 'failed',
              severity: 'high',
              retry_classification: 'reproducible',
              failure_class: 'assertion',
              expected_behavior: 'a',
              observed_behavior: 'b',
              user_impact: 'c',
              repro_steps: ['s1'],
              diagnostic_confidence: 0.3,
              missing_evidence: 'need logs',
              candidate_files: ['a.js'],
            },
          ],
        },
      ],
    })
    const r = validateResultPayload(p)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/candidate_files asserted/)
  })
})

describe('computeFingerprint', () => {
  it('is stable across ids in the route and paraphrased error numbers', () => {
    const a = computeFingerprint({ app_id: 'grantflow', journey_id: 'create', failure_class: 'network-5xx', route_or_control: '/api/profiles/123', error_signature: 'POST failed 500 after 3 tries' })
    const b = computeFingerprint({ app_id: 'grantflow', journey_id: 'create', failure_class: 'network-5xx', route_or_control: '/api/profiles/456', error_signature: 'POST failed 500 after 9 tries' })
    expect(a).toBe(b)
  })

  it('differs when the app or failure class differs', () => {
    const a = computeFingerprint({ app_id: 'grantflow', journey_id: 'create', failure_class: 'network-5xx', route_or_control: '/x', error_signature: 'e' })
    const b = computeFingerprint({ app_id: 'sermonsmith', journey_id: 'create', failure_class: 'network-5xx', route_or_control: '/x', error_signature: 'e' })
    const c = computeFingerprint({ app_id: 'grantflow', journey_id: 'create', failure_class: 'timeout', route_or_control: '/x', error_signature: 'e' })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('normalizeFailureClass', () => {
  it('buckets unknown classes to other', () => {
    expect(normalizeFailureClass('kaboom')).toBe('other')
    expect(normalizeFailureClass('network-5xx')).toBe('network-5xx')
  })
})

describe('normalizeErrorSignature', () => {
  it('collapses volatile tokens and redacts secrets', () => {
    const s = normalizeErrorSignature('Error 0xFF at 3f2504e0-4f89-41d3-9a0c-0305e82c3301 with key sk-abcdef0123456789ABCDEF')
    expect(s).toMatch(/<hex>/)
    expect(s).toMatch(/<uuid>/)
    expect(s).not.toMatch(/sk-abcdef/)
  })
})

describe('redaction', () => {
  it('redacts keys, emails, SSNs, cards, and private windows paths', () => {
    const dirty = 'key sk-ABCDEF0123456789 zzz email a@b.com ssn 123-45-6789 card 4111 1111 1111 1111 path C:\\Users\\example_user\\secret.txt'
    const clean = redactText(dirty)
    expect(clean).not.toMatch(/sk-ABCDEF/)
    expect(clean).toMatch(/REDACTED_EMAIL/)
    expect(clean).toMatch(/REDACTED_SSN/)
    expect(clean).toMatch(/REDACTED_CARD/)
    expect(clean).toMatch(/USER_HOME/)
    expect(clean).not.toMatch(/example_user/)
  })

  it('deep-redacts nested structures', () => {
    const out = redactDeep({ a: 'token TOKEN=abcdef[secret]', b: ['C:\\Users\\example_user\\x'], c: 3 })
    expect(JSON.stringify(out)).not.toMatch(/example_user/)
    expect(out.c).toBe(3)
  })
})
