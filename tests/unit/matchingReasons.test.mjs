import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const modulePath = path.resolve(__dirname, '..', '..', 'backend', 'services', 'matching', 'reasons.js')
const moduleUrl = pathToFileURL(modulePath).href

const {
  MATCH_REASON_CODE_SET,
  MATCH_REASON_CODES,
  deriveMatchReasonCodes,
} = await import(moduleUrl)

test('matching reasons: derives finite enum codes from decision explanation', () => {
  const codes = deriveMatchReasonCodes(
    {
      decision: 'ACCEPT',
      eligible: true,
      matchedNeeds: ['housing'],
      reasons: ['Score 86 ≥ 70 — strong match'],
      match_explain: {
        matchedSignals: ['geo:national', 'keywords', 'category', 'applicant_type'],
        usableForHousing: true,
        scoreBreakdown: {
          keyword: 22,
          category: 18,
          geo: 80,
          applicant_type: 25,
          amount: 10,
          deadline: 3,
        },
      },
    },
    { source: 'verified_real' },
    { trustTier: 'high', sourceTrust: 95 },
  )

  assert.ok(codes.length > 0)
  assert.ok(codes.every((code) => MATCH_REASON_CODE_SET.has(code)))
  assert.ok(codes.includes(MATCH_REASON_CODES.NEED_ALIGNMENT))
  assert.ok(codes.includes(MATCH_REASON_CODES.GEOGRAPHIC_MATCH))
  assert.ok(codes.includes(MATCH_REASON_CODES.STRONG_SCORE))
})

test('matching reasons: returns no code when the matcher has no explainable signal', () => {
  const codes = deriveMatchReasonCodes({
    decision: null,
    matchedNeeds: [],
    reasons: [],
    match_explain: { matchedSignals: [], scoreBreakdown: {} },
  })

  assert.deepEqual(codes, [])
})

// ─────────────────────────────────────────────────────────────────────────────
// The PERSISTED explain shape.
//
// crawler-os/storage.js is the only writer of
// `profile_opportunity_matches.match_explain_json`, and it stringifies the
// crawler-os wrapper shape: snake_case `score_breakdown` plus the pre-reduced
// `matched_profile_type` / `matched_location` / `matched_needs` /
// `eligibility_fit` facts. On the dominant read path resultEnricher rebuilds
// `decision` from DB COLUMNS (no `match_explain` at all) and hands the row —
// which carries `match_explain_json` — through as the `opportunity` argument.
// Reading only `decision.match_explain` collapsed six provable codes to two.
// ─────────────────────────────────────────────────────────────────────────────

const PERSISTED_ACCEPT_EXPLAIN = {
  matched_profile_type: true,
  matched_location: 'state',
  eligibility_fit: true,
  matched_needs: ['housing'],
  score_breakdown: { need_coverage: 70, applicant_type: 25, geo: 80, keyword: 22, category: 18 },
  canonical_decision: 'ACCEPT',
}

test('matching reasons: reads the PERSISTED explain off the opportunity row', () => {
  // Verbatim shape of resultEnricher's stored-decision branch: no match_explain.
  const decision = { decision: 'ACCEPT', score: 86, matchedNeeds: [], matcherVersion: 'crawler-os' }
  const codes = deriveMatchReasonCodes(decision, {
    id: 'opp-1',
    source: 'grants_gov',
    match_explain_json: JSON.stringify(PERSISTED_ACCEPT_EXPLAIN),
  })

  assert.ok(codes.every((code) => MATCH_REASON_CODE_SET.has(code)))
  for (const expected of [
    MATCH_REASON_CODES.NEED_ALIGNMENT,
    MATCH_REASON_CODES.GEOGRAPHIC_MATCH,
    MATCH_REASON_CODES.APPLICANT_TYPE_MATCH,
    MATCH_REASON_CODES.KEYWORD_MATCH,
    MATCH_REASON_CODES.CATEGORY_MATCH,
  ]) {
    assert.ok(codes.includes(expected), `persisted evidence should yield ${expected}`)
  }
})

test('matching reasons: a persisted explain that proves NOTHING adds nothing', () => {
  // 'unknown' is crawler-os's honest "no geography verdict"; 'maybe' is the
  // canonical eligible verdict for "this gate had nothing to say". Neither is
  // evidence, and neither may manufacture a reason chip.
  const codes = deriveMatchReasonCodes({ decision: 'REVIEW' }, {
    match_explain_json: JSON.stringify({
      matched_profile_type: false,
      matched_location: 'unknown',
      eligibility_fit: 'maybe',
      matched_needs: [],
      score_breakdown: {},
    }),
  })

  assert.deepEqual(codes, [MATCH_REASON_CODES.REVIEW_SCORE])
})

test('matching reasons: unparseable persisted explain never fabricates a code', () => {
  const codes = deriveMatchReasonCodes({ decision: 'REVIEW' }, { match_explain_json: '{not json' })
  assert.deepEqual(codes, [MATCH_REASON_CODES.REVIEW_SCORE])
})

test('matching reasons: a live decision explain still wins over the row', () => {
  // The live-recompute path must be unchanged: its camelCase explain is
  // authoritative even when a stale persisted explain sits on the row.
  const codes = deriveMatchReasonCodes(
    {
      decision: 'REVIEW',
      match_explain: { matchedSignals: [], scoreBreakdown: {} },
    },
    { match_explain_json: JSON.stringify(PERSISTED_ACCEPT_EXPLAIN) },
  )

  assert.ok(!codes.includes(MATCH_REASON_CODES.APPLICANT_TYPE_MATCH))
  assert.deepEqual(codes, [MATCH_REASON_CODES.REVIEW_SCORE])
})
