import fs from 'node:fs'

function replaceOnce(path, before, after) {
  const source = fs.readFileSync(path, 'utf8')
  const first = source.indexOf(before)
  if (first === -1) throw new Error(`${path}: expected source block not found`)
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`${path}: expected source block is not unique`)
  }
  fs.writeFileSync(path, source.replace(before, after))
}

replaceOnce(
  'backend/services/relevanceFilter.js',
  `    ...asTextList(opportunity.eligibility_bullets),
    ...asTextList(opportunity.tags),`,
  `    ...asTextList(opportunity.eligibility_bullets),
    // Structured eligibility is part of the same source-of-truth evidence as
    // eligibility prose. Without it, JSON-only demographic restrictions can
    // bypass both the canonical soft penalty and explicit hard exclusivity.
    ...asTextList(opportunity.eligibility_json),
    ...asTextList(opportunity.tags),`,
)

replaceOnce(
  'backend/services/matching/profileSpecificGate.js',
  `  const relevance = applyRelevanceFilter(opportunity, profileData, {
    mode: 'strict',`,
  `  const relevance = applyRelevanceFilter(opportunity, profileData, {
    // Display enrichment is not a second eligibility authority. Soft relevance
    // signals were already designed to reduce the canonical score, so this gate
    // may reject only hard:true exclusivity and safety rules.
    mode: 'soft',`,
)

const testPath = 'backend/tests/profileSpecificGateStructuredEligibility.test.js'
if (fs.existsSync(testPath)) throw new Error(`${testPath}: destination already exists`)
fs.writeFileSync(testPath, `import { describe, expect, it } from 'vitest'
import { applyRelevanceFilter } from '../services/relevanceFilter.js'
import { evaluateProfileSpecificGate } from '../services/matching/profileSpecificGate.js'

const MALE_PROFILE = {
  primary_type: 'individual',
  state: 'TN',
  city: 'Nashville',
  gender: 'male',
  needs: ['business', 'working capital'],
}

function opportunity(overrides = {}) {
  return {
    id: 'structured-eligibility-opportunity',
    title: 'Tennessee Small Business Growth Award',
    description: 'Working-capital support for small businesses planning sustainable growth.',
    application_url: 'https://example.org/apply',
    source_url: 'https://example.org/program',
    state: 'TN',
    ...overrides,
  }
}

describe('structured eligibility relevance contract', () => {
  it('treats JSON-only women-prioritized language as a soft signal, not a display rejection', () => {
    const row = opportunity({
      eligibility_json: {
        review_priority: 'Preference for women entrepreneurs and women-owned businesses.',
      },
    })

    const relevance = applyRelevanceFilter(row, MALE_PROFILE, { mode: 'soft' })
    expect(relevance.pass).toBe(true)
    expect(relevance.softFail).toBe(true)
    expect(relevance.ruleId).toBe('demographic_women_prioritized')

    const display = evaluateProfileSpecificGate(MALE_PROFILE, row, {
      mode: 'display',
      useStoredDecision: false,
    })
    expect(display.pass).toBe(true)
  })

  it('still hard-rejects explicit JSON-only women exclusivity', () => {
    const row = opportunity({
      eligibility_json: JSON.stringify({
        eligible_applicants: 'Women only. Applicant must be female.',
      }),
    })

    const relevance = applyRelevanceFilter(row, MALE_PROFILE, { mode: 'soft' })
    expect(relevance.pass).toBe(false)
    expect(relevance.ruleId).toBe('demographic_women_only')

    const display = evaluateProfileSpecificGate(MALE_PROFILE, row, {
      mode: 'display',
      useStoredDecision: false,
    })
    expect(display.pass).toBe(false)
    expect(display.ruleId).toBe('demographic_women_only')
  })
})
`)

console.log('Applied PR #1179 structured eligibility and soft display fixes')
