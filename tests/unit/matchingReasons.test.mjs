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
