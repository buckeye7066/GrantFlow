import fs from 'node:fs'

const staged = new Map()
const originals = new Map()
const newFiles = new Set()

function currentContent(path) {
  if (staged.has(path)) return staged.get(path)
  const source = fs.readFileSync(path, 'utf8')
  originals.set(path, source)
  return source
}

function stageReplaceOnce(path, before, after) {
  const source = currentContent(path)
  const first = source.indexOf(before)
  if (first === -1) throw new Error(`${path}: expected source block not found`)
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`${path}: expected source block is not unique`)
  }
  staged.set(path, source.replace(before, after))
}

function stageNew(path, content) {
  if (fs.existsSync(path) || staged.has(path)) {
    throw new Error(`${path}: destination already exists`)
  }
  newFiles.add(path)
  staged.set(path, content)
}

function commitStaged() {
  const written = []
  try {
    for (const [path, content] of staged) {
      fs.writeFileSync(path, content)
      written.push(path)
    }
  } catch (error) {
    for (const path of written.reverse()) {
      if (newFiles.has(path)) {
        try { fs.rmSync(path, { force: true }) } catch { /* best effort */ }
      } else if (originals.has(path)) {
        try { fs.writeFileSync(path, originals.get(path)) } catch { /* best effort */ }
      }
    }
    throw error
  }
}

stageReplaceOnce(
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

stageReplaceOnce(
  'backend/services/matching/profileSpecificGate.js',
  `  let skipRuleIds = null
  if (storedAuthoritative) {
    skipRuleIds = new Set(SUPPRESSIBLE_NO_FIT_RULE_IDS)
    if (TRUST_ENGINE_OVER_CATEGORY_HEURISTICS) {
      for (const id of SUPPRESSIBLE_GEO_MISMATCH_RULE_IDS) skipRuleIds.add(id)
    }
  }`,
  `  // The canonical engine score-penalizes non-exclusive women-prioritized
  // language. The display enrichment gate must not turn that one soft rule into
  // a second hard eligibility trial. Other legacy soft rules retain their
  // existing strict behavior here unless an authoritative stored decision earns
  // the documented no-fit/geography suppression below.
  const skipRuleIds = new Set(['demographic_women_prioritized'])
  if (storedAuthoritative) {
    for (const id of SUPPRESSIBLE_NO_FIT_RULE_IDS) skipRuleIds.add(id)
    if (TRUST_ENGINE_OVER_CATEGORY_HEURISTICS) {
      for (const id of SUPPRESSIBLE_GEO_MISMATCH_RULE_IDS) skipRuleIds.add(id)
    }
  }`,
)

stageNew('backend/tests/profileSpecificGateStructuredEligibility.test.js', `import { describe, expect, it } from 'vitest'
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
  it('score-penalizes JSON-only women-prioritized language without display rejection', () => {
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

commitStaged()
console.log('Applied staged PR #1179 structured eligibility repair')
