/**
 * js/polynomial-redos in the matching hot path (CodeQL, PR #1080).
 *
 * The residency-scope pattern is matched against `opp.title + opp.description` —
 * crawler-controlled text — and it interleaved OVERLAPPING whitespace
 * quantifiers: `must\s+be\s+a?\s*resident` is `\s+`, an optional `a`, then
 * `\s*`. For a run of n whitespace characters the engine can split it n ways at
 * each of n start positions, so matching is QUADRATIC in the run length.
 * Measured on the pre-fix pattern with `'must be' + '\t\t'.repeat(n)`:
 *
 *     2 008 chars →  11.9 ms
 *     4 008 chars →  36.6 ms
 *     8 008 chars → 147.6 ms
 *    16 008 chars → 567.8 ms      (~4× per doubling — clean O(n²))
 *
 * `makeDecision` runs per-profile × per-opportunity, so one pathological page
 * title is amplified across the whole fleet.
 *
 * THE FIX normalizes whitespace once (`normalizeMatchWhitespace`) and matches a
 * pattern whose separators are LITERAL single spaces — disjoint from the classes
 * around them, so the ambiguity cannot arise.
 *
 * TWO GUARDS, because either alone is insufficient:
 *   1. an A/B ORACLE against the ORIGINAL pattern over a real corpus, so the
 *      rewrite cannot silently change a verdict OR go inert;
 *   2. a PATHOLOGICAL-INPUT budget, so a future edit cannot reintroduce the
 *      overlap.
 */

import { describe, it, expect } from 'vitest'
import {
  normalizeMatchWhitespace,
  RESIDENCY_EXCLUSIVE_RX,
  makeDecision,
} from '../services/matchEngine.js'

/**
 * The EXACT pre-fix pattern, kept here as a behavioural oracle only. It is never
 * imported by product code — this is the reference the rewrite must agree with.
 */
const LEGACY_RESIDENCY_RX =
  /\b(residents?\s+only|must\s+be\s+a?\s*resident|must\s+reside\s+in|limited\s+to\s+residents|for\s+\w+(?:\s+\w+)?\s+residents?|\w+\s+residents?\s+(?:only|facing|who|experiencing|must)|exclusively\s+for\s+\w+(?:\s+\w+)?\s+residents?)\b/i

const ENGINEER_NON_RESIDENCY_PHRASE = [
  'the resident engineer',
  'signs',
  'off',
  'on the work',
].join(' ')

// Real phrasings from prod opportunity copy, plus the near-misses that must NOT
// be treated as a residency declaration.
const CORPUS = [
  // ── should MATCH ────────────────────────────────────────────────────────
  'open to tennessee residents only',
  'this program is for texas residents',
  'exclusively for new mexico residents',
  'applicants must be a resident of the county',
  'applicant must be resident at time of award',
  'you must reside in the service area',
  'eligibility is limited to residents of the parish',
  'indiana residents facing eviction may apply',
  'ohio residents who have lost income',
  'california residents experiencing homelessness',
  'georgia residents must submit proof of address',
  'grants for florida residents',
  'housing adaptation grant for people with a disability',
  // multi-line / tab-separated copy, the shape crawled HTML actually produces
  'open to\ttennessee\tresidents only',
  'applicants\n  must   be   a   resident\n  of the state',
  'for   texas   residents',
  // ── should NOT match ────────────────────────────────────────────────────
  'this program funds initiatives aimed at educating the public',
  'local assistance programs near you',
  'residents of any state may apply',
  'a resident advisor will contact you',
  ENGINEER_NON_RESIDENCY_PHRASE,
  'community residents benefit from the program',
  'fair housing initiative program education and outreach',
  'medicaid and chip',
  '211 - local help with rent, utilities, food & emergencies',
  'social security disability benefits (ssdi/ssi)',
  '',
  '   ',
  'residents',
  'resident',
]

describe('residency-scope pattern — the rewrite is behaviourally identical', () => {
  it('agrees with the ORIGINAL pattern on every phrase in the corpus', () => {
    const disagreements = []
    for (const phrase of CORPUS) {
      const legacy = LEGACY_RESIDENCY_RX.test(phrase)
      const rewritten = RESIDENCY_EXCLUSIVE_RX.test(normalizeMatchWhitespace(phrase))
      if (legacy !== rewritten) disagreements.push({ phrase, legacy, rewritten })
    }
    expect(disagreements).toEqual([])
  })

  it('the corpus actually EXERCISES both verdicts (the oracle cannot be vacuous)', () => {
    const positives = CORPUS.filter((p) => RESIDENCY_EXCLUSIVE_RX.test(normalizeMatchWhitespace(p)))
    const negatives = CORPUS.filter((p) => !RESIDENCY_EXCLUSIVE_RX.test(normalizeMatchWhitespace(p)))
    expect(positives.length).toBeGreaterThanOrEqual(15)
    expect(negatives.length).toBeGreaterThanOrEqual(10)
  })

  it('still recognises every documented phrasing (an inert pattern fails here)', () => {
    for (const phrase of [
      'tennessee residents only',
      'must be a resident',
      'must reside in',
      'limited to residents',
      'for texas residents',
      'ohio residents facing eviction',
      'exclusively for new mexico residents',
    ]) {
      expect(RESIDENCY_EXCLUSIVE_RX.test(normalizeMatchWhitespace(phrase)), phrase).toBe(true)
    }
  })

  it('normalizeMatchWhitespace collapses runs and tolerates junk input', () => {
    expect(normalizeMatchWhitespace('a\t\t\n  b')).toBe('a b')
    expect(normalizeMatchWhitespace('   padded   ')).toBe('padded')
    expect(normalizeMatchWhitespace(null)).toBe('')
    expect(normalizeMatchWhitespace(undefined)).toBe('')
    expect(normalizeMatchWhitespace(12)).toBe('12')
  })
})

describe('residency-scope pattern — pathological input stays linear', () => {
  // The pre-fix pattern needed ~568 ms at 16k chars and would need ~5 s at 50k.
  // A generous budget still fails hard on any reintroduced quadratic blowup.
  const BUDGET_MS = 250

  function timeMs(fn) {
    const t0 = process.hrtime.bigint()
    fn()
    return Number(process.hrtime.bigint() - t0) / 1e6
  }

  it('matches a 50 000-char run of tabs/spaces well inside budget', () => {
    const hostile = `must be${'\t\t'.repeat(25000)}x`
    expect(hostile.length).toBeGreaterThan(50000)
    const ms = timeMs(() => RESIDENCY_EXCLUSIVE_RX.test(normalizeMatchWhitespace(hostile)))
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it('is linear, not quadratic: 4× the input is nowhere near 16× the time', () => {
    const build = (n) => `for${' '.repeat(n)}residents`
    const small = build(12500)
    const large = build(50000)
    // Warm up so JIT noise does not dominate the ratio.
    for (let i = 0; i < 3; i += 1) RESIDENCY_EXCLUSIVE_RX.test(normalizeMatchWhitespace(small))
    const tSmall = Math.max(timeMs(() => RESIDENCY_EXCLUSIVE_RX.test(normalizeMatchWhitespace(small))), 0.05)
    const tLarge = timeMs(() => RESIDENCY_EXCLUSIVE_RX.test(normalizeMatchWhitespace(large)))
    expect(tLarge).toBeLessThan(BUDGET_MS)
    // Quadratic would be ~16×; linear is ~4×. 10× is a wide, stable margin.
    expect(tLarge / tSmall).toBeLessThan(10)
  })

  it('makeDecision drives the residency branch on a hostile title within budget', () => {
    // `oppNorm` is supplied so this measures makeDecision's OWN work — the branch
    // this PR fixed — and not normalizeOpportunity().
    //
    // SCOPE NOTE, deliberately not hidden by this test: normalizeOpportunity()
    // carries a SECOND, pre-existing quadratic of the identical shape —
    // `DV_SURVIVOR_RESTRICTION_PATTERNS[0]` in
    // backend/services/opportunityNormalizer.js:535 is
    // `\bmust\s+be\s+a?\s*(?:survivor|victim)\s+of\s+…`, the same `\s+…a?\s*`
    // overlap. A CPU profile of `normalizeOpportunity` on this exact input
    // attributes 92.0% of self time to that one regex (~3.5 s at 50k chars,
    // 4× per doubling). CodeQL did not flag it and it is outside this PR's
    // diff, so it is reported rather than fixed here — asserting an end-to-end
    // budget would make this test hostage to a defect it does not control.
    const hostile = `Grant must be${'\t\t'.repeat(25000)}x`
    const opp = {
      title: hostile,
      description: hostile,
      source_url: 'https://example.org/grant',
      state: 'TX', // forces the residency branch: opp state not in profile states
      is_national: false,
    }
    const oppNorm = {
      entityTypesAllowed: [],
      needTypesSupported: [],
      applicabilityUnknown: true,
    }
    const ms = timeMs(() => {
      const res = makeDecision(
        40,
        { id: 'p1', primary_type: 'individual', state: 'IN', needs: ['housing'] },
        opp,
        null,
        null,
        oppNorm,
      )
      expect(['REJECT', 'REVIEW', 'ACCEPT']).toContain(res.decision)
    })
    expect(ms).toBeLessThan(BUDGET_MS)
  })
})

describe('residency-scope pattern — the geographic verdicts are unchanged', () => {
  const profileIN = { id: 'p1', primary_type: 'individual', state: 'IN', needs: ['housing'] }

  it('an explicitly residents-only out-of-state program still REJECTs', () => {
    const res = makeDecision(40, profileIN, {
      title: 'Texas Rent Relief',
      description: 'Open to Texas residents only.',
      source_url: 'https://example.org/tx',
      state: 'TX',
      is_national: false,
    })
    expect(res.decision).toBe('REJECT')
    expect(res.explanation).toMatch(/Geographic mismatch/i)
  })

  it('an out-of-state program with NO residency language still REVIEWs', () => {
    const res = makeDecision(40, profileIN, {
      title: 'Regional Housing Repair Fund',
      description: 'Assistance with home repairs.',
      source_url: 'https://example.org/tx2',
      state: 'TX',
      is_national: false,
    })
    expect(res.decision).toBe('REVIEW')
    expect(res.explanation).toMatch(/may be accessible/i)
  })

  // GUARDS THE WIRING, not just the pattern. The rewritten pattern uses LITERAL
  // single spaces, so it only sees real-world copy if makeDecision actually
  // normalizes first. Crawled HTML routinely carries tab/newline runs between
  // words — drop the `normalizeMatchWhitespace()` call and this verdict silently
  // flips from REJECT to REVIEW while every pattern-level test stays green.
  it('still REJECTs when the residency phrase is broken up by tab/newline runs', () => {
    const res = makeDecision(40, profileIN, {
      title: 'Texas Rent Relief',
      description: 'Applicants\n\t\tmust   be   a   resident\n\t\tof Texas.',
      source_url: 'https://example.org/tx3',
      state: 'TX',
      is_national: false,
    })
    expect(res.decision).toBe('REJECT')
    expect(res.explanation).toMatch(/Geographic mismatch/i)
  })

  it('with an UNKNOWN profile state, residency language REVIEWs and never REJECTs', () => {
    const res = makeDecision(40, { id: 'p2', primary_type: 'individual', needs: ['housing'] }, {
      title: 'Texas Rent Relief',
      description: 'Open to Texas residents only.',
      source_url: 'https://example.org/tx',
      state: 'TX',
      is_national: false,
    })
    expect(res.decision).toBe('REVIEW')
    expect(res.explanation).toMatch(/state is unknown/i)
  })
})
