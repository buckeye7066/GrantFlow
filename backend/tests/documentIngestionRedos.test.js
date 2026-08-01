/**
 * js/polynomial-redos in document ingestion — uploaded documents are the
 * clearest unbounded, untrusted input this codebase has.
 *
 * THE DEFECT. Anchored trailing-class trims (`/\s+$/`, `/[\s);,.]+$/`,
 * `/[\s.;]+$/`) and a redundant leading `\s*` (`/\s*[/|].*$/`) are quadratic on
 * a long non-matching run: the engine retries at every start position and each
 * attempt walks to the end. An OCR/PDF extract of a blank column is exactly
 * that — one line of thousands of spaces. Measured on the pre-fix
 * `extractBasicInformationHeuristics` with one long blank line:
 *
 *     4 000 chars ->  13.8 ms
 *     8 000 chars ->  51.7 ms
 *    16 000 chars -> 198.2 ms      (14.4x for 4x the input)
 *
 * After: 0.16 ms at 16 000 and 0.52 ms at 50 000.
 *
 * A CALL-SITE LESSON worth keeping: measuring regex LITERALS over-reports. The
 * `Plan type` / `Plan name` / `Insurance provider` patterns in this same file
 * carry the same `\s*[:#-]?\s*` overlap and were flagged by the literal-level
 * survey, but they are NOT exposed — their caller matches against `singleLine`,
 * which has already collapsed whitespace runs. Only the exported function tells
 * the truth, so the timing tests below drive the EXPORTED functions.
 */

import { describe, it, expect } from 'vitest'
import {
  stripTrailing,
  extractBasicInformationHeuristics,
  extractOrganizationDetailsHeuristics,
  extractMedicalInsuranceHeuristics,
} from '../services/documentIngestion/heuristics.js'

const timeMs = (fn) => {
  const t0 = process.hrtime.bigint()
  fn()
  return Number(process.hrtime.bigint() - t0) / 1e6
}
const blankLineDoc = (n) => `Name: Acme Foundation\n${' '.repeat(n)}x\nMission: We help families.`

describe('stripTrailing — the linear replacement for an anchored class trim', () => {
  it('is an A/B oracle match for the regexes it replaces', () => {
    // The EXACT pre-fix patterns, kept as the behavioural reference.
    const LEGACY_WEBSITE = /[\s);,.]+$/
    const LEGACY_MISSION = /[\s.;]+$/
    const corpus = [
      'https://acme.org', 'https://acme.org);,.', 'https://acme.org ; ', 'https://acme.org.',
      'We help families.', 'We help families;  ', 'We help families', '   ', '', 'a',
      'trailing tabs\t\t', 'mixed .;. ', 'no-trim-needed', '...', '; ; ;',
    ]
    for (const s of corpus) {
      expect(stripTrailing(s, ');,.'), `website:${JSON.stringify(s)}`).toBe(s.replace(LEGACY_WEBSITE, ''))
      expect(stripTrailing(s, '.;'), `mission:${JSON.stringify(s)}`).toBe(s.replace(LEGACY_MISSION, ''))
    }
  })

  it('the corpus exercises BOTH outcomes (the oracle cannot be vacuous)', () => {
    const corpus = ['https://acme.org', 'https://acme.org);,.', 'keep', 'trim.  ']
    const changed = corpus.filter((s) => stripTrailing(s, ');,.') !== s)
    const unchanged = corpus.filter((s) => stripTrailing(s, ');,.') === s)
    expect(changed.length).toBeGreaterThan(0)
    expect(unchanged.length).toBeGreaterThan(0)
  })

  it('tolerates junk input', () => {
    expect(stripTrailing(null)).toBe('')
    expect(stripTrailing(undefined)).toBe('')
    expect(stripTrailing(12)).toBe('12')
    expect(stripTrailing('abc')).toBe('abc')
  })

  it('is linear on a 200 000-char run (a regex trim here is quadratic)', () => {
    const hostile = `keep${' '.repeat(200000)}`
    const ms = timeMs(() => expect(stripTrailing(hostile, '.;')).toBe('keep'))
    expect(ms).toBeLessThan(100)
  })
})

describe('document heuristics — behaviour is unchanged', () => {
  const doc = [
    'Acme Community Foundation',
    '123 Main St',
    'Nashville, TN 37201',
    'https://acme.org ; https://other.org',
    'Mission: We help families in crisis.  ',
    'contact@acme.org',
  ].join('\n')

  it('still extracts the same basic-information fields', () => {
    const r = extractBasicInformationHeuristics(doc)
    expect(r.website).toBe('https://acme.org')
    expect(r.city).toBe('Nashville')
    expect(r.state).toBe('TN')
    expect(r.zip).toBe('37201')
    expect(r.email).toBe('contact@acme.org')
  })

  it('still strips a trailing slash-qualifier from an organization name', () => {
    const r = extractOrganizationDetailsHeuristics('Acme Community Foundation / Nashville Chapter\nMission: We help.')
    expect(String(r.organization_name || '')).not.toContain('/')
  })

  it('the insurance extractors (already protected by singleLine) still work', () => {
    const card = 'Insurance provider: Blue Cross Blue Shield\nPlan type: PPO\nPlan name: Gold Select\nMember ID: 123456789'
    const r = extractMedicalInsuranceHeuristics(card)
    expect(r.insurance_provider).toMatch(/Blue Cross/i)
    expect(r.plan_type).toMatch(/PPO/i)
  })
})

describe('document heuristics — pathological input stays linear', () => {
  const BUDGET_MS = 150

  it('a 16 000-char blank line completes well inside budget (was 198 ms)', () => {
    const ms = timeMs(() => extractBasicInformationHeuristics(blankLineDoc(16000)))
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it('is linear: 4x the input is nowhere near 16x the time', () => {
    for (let i = 0; i < 3; i += 1) extractBasicInformationHeuristics(blankLineDoc(12500))
    const small = Math.max(timeMs(() => extractBasicInformationHeuristics(blankLineDoc(12500))), 0.05)
    const large = timeMs(() => extractBasicInformationHeuristics(blankLineDoc(50000)))
    expect(large).toBeLessThan(BUDGET_MS)
    expect(large / small).toBeLessThan(10) // quadratic would be ~16x
  })

  it('a 50 000-char blank line does not stall the other exported extractors', () => {
    const doc = blankLineDoc(50000)
    expect(timeMs(() => extractOrganizationDetailsHeuristics(doc))).toBeLessThan(BUDGET_MS)
    expect(timeMs(() => extractMedicalInsuranceHeuristics(doc))).toBeLessThan(BUDGET_MS)
  })
})
