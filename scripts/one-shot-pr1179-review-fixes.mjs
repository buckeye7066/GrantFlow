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

function writeNew(path, content) {
  if (fs.existsSync(path)) throw new Error(`${path}: file already exists`)
  fs.writeFileSync(path, content)
}

writeNew(
  'backend/config/demographicRestrictionPatterns.js',
  `/**
 * Shared demographic restriction classifiers.
 *
 * These predicates are consumed by both normalization and strict relevance
 * gates so the canonical match decision cannot disagree with a pre-filter over
 * the same opportunity text.
 */

export const WOMEN_EXCLUSIVE_OPPORTUNITY_PATTERN =
  /\\b(?:women[\\s-]?only|female[\\s-]?only|for\\s+women\\s+only|female\\s+(?:students?|applicants?|entrepreneurs?)\\s+only|must be (?:a )?(?:woman|female)|exclusively for (?:women|females?)|restricted to (?:women|females?)|amber grant for women|society of women engineers|women(?:'s)?\\s+engineers?|(?:scholarships?|grants?|awards?)\\s+for\\s+female\\s+(?:students?|applicants?))\\b/i

export function isWomenExclusiveOpportunityText(value) {
  return WOMEN_EXCLUSIVE_OPPORTUNITY_PATTERN.test(String(value ?? ''))
}
`,
)

replaceOnce(
  'backend/config/matchThresholds.js',
  `export const SOFT_RELEVANCE_PENALTY = (() => {
  const raw = Number(process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY)
  if (Number.isFinite(raw) && raw >= 0) return raw
  return SCORING_MODEL === 'data_point' ? 4 : 25
})()`,
  `export const SOFT_RELEVANCE_PENALTY = (() => {
  const rawValue = process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY?.trim()
  const raw = rawValue ? Number(rawValue) : Number.NaN
  if (Number.isFinite(raw) && raw >= 0) return raw
  return SCORING_MODEL === 'data_point' ? 4 : 25
})()`,
)

replaceOnce(
  'backend/services/relevanceFilterRules.js',
  `import { PROCUREMENT_CONTRACT_PATTERN } from './matching/contentEligibilityPolicy.js'`,
  `import { PROCUREMENT_CONTRACT_PATTERN } from './matching/contentEligibilityPolicy.js'
import { WOMEN_EXCLUSIVE_OPPORTUNITY_PATTERN } from '../config/demographicRestrictionPatterns.js'`,
)
replaceOnce(
  'backend/services/relevanceFilterRules.js',
  `    oppPattern: /\\b(women[\\s-]?only|female[\\s-]?only|for women only|amber grant for women|female entrepreneurs only|women.{0,10}only|exclusively for (women|females?)|restricted to (women|females?))\\b/i,`,
  `    oppPattern: WOMEN_EXCLUSIVE_OPPORTUNITY_PATTERN,`,
)

replaceOnce(
  'backend/services/opportunityNormalizer.js',
  `import { normalizeNeedCategory, NEED_ALIAS_MAP } from './profileNormalizer.js'`,
  `import { normalizeNeedCategory, NEED_ALIAS_MAP } from './profileNormalizer.js'
import { isWomenExclusiveOpportunityText } from '../config/demographicRestrictionPatterns.js'`,
)
replaceOnce(
  'backend/services/opportunityNormalizer.js',
  `  const requiresWomen =
    Boolean(rawOpp.requires_women) ||
    // Exclusive / named women-restricted programs. Bare "for women" stays soft
    // (demographic_women_prioritized) so non-exclusive prioritization does not
    // hard-REJECT. Named societies and "* only" language remain hard.
    matchesAnyRegex(text, [
      /\\bwomen[\\s-]?only\\b/i,
      /\\bfor\\s+women\\s+only\\b/i,
      /\\bfemale\\s+(?:students?|applicants?)\\s+only\\b/i,
      /\\bmust be (?:a )?(?:woman|female)\\b/i,
      /\\bexclusively for (?:women|females?)\\b/i,
      /\\brestricted to (?:women|females?)\\b/i,
      /\\bamber grant for women\\b/i,
      /\\bsociety of women engineers\\b/i,
      /\\bwomen(?:'s)?\\s+engineers?\\b/i,
    ])`,
  `  const requiresWomen =
    Boolean(rawOpp.requires_women) ||
    // One shared classifier is used here and by relevanceFilterRules. Bare
    // "for women" remains soft, while explicit/named restrictions remain hard.
    isWomenExclusiveOpportunityText(text)`,
)

replaceOnce(
  'backend/services/matchEngine.js',
  `import { isPlaceholderPlaceLabel, placePrefixOfTitle } from '../config/placeholderProfileSignals.js'`,
  `import { isPlaceholderPlaceLabel, placePrefixOfTitle } from '../config/placeholderProfileSignals.js'
import { isPointerOpportunityRow } from '../config/linkLifecycleKinds.js'`,
)
replaceOnce(
  'backend/services/matchEngine.js',
  `  // Matching funds are a cost/feasibility signal, not an absolute exclusivity
  // lock. scoreEligibilityComponent already subtracts for requires_match —
  // hard-REJECT here discarded otherwise-fit awards without checking whether
  // the profile can provide a match (and claimed "cannot provide" falsely).
  // Reduce-not-discard: surface as REVIEW so the owner can decide.
  if (opp.requires_match) {
    reasons.push('Requires matching funds — review whether the applicant can meet cost-share')
    return {
      decision: 'REVIEW',
      explanation: 'Opportunity requires matching funds; confirm cost-share capacity before applying.',
      reasons,
    }
  }

`,
  '',
)
replaceOnce(
  'backend/services/matchEngine.js',
  `  }

  // Need-anchored copy: the score IS need coverage after eligibility/geography`,
  `  }

  // Matching funds are a cost/feasibility signal, not an absolute exclusivity
  // lock. It must run only after all hard applicant and geography gates, so a
  // state-exclusive opportunity cannot bypass rejection merely because it also
  // requires a cost share.
  if (opp.requires_match) {
    reasons.push('Requires matching funds — review whether the applicant can meet cost-share')
    return {
      decision: 'REVIEW',
      explanation: 'Opportunity requires matching funds; confirm cost-share capacity before applying.',
      reasons,
    }
  }

  // Need-anchored copy: the score IS need coverage after eligibility/geography`,
)
replaceOnce(
  'backend/services/matchEngine.js',
  `  if (hardRelevanceEval?.pass && hardRelevanceEval?.softFail) {`,
  `  const isPointerResource = isPointerOpportunityRow(rawOpportunity) || Boolean(oppNorm?.isDirectory)
  if (hardRelevanceEval?.pass && hardRelevanceEval?.softFail && !isPointerResource) {`,
)

replaceOnce(
  'src/lib/discoverCatalogKeep.js',
  `export function keepDiscoverCatalogRow(opp, minScoreFloor, recoveryApplied) {`,
  `export function normalizeDiscoverResultPayload(payload) {
  const normalized = payload?.data ?? payload ?? {}
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized
    : {}
}

export function keepDiscoverCatalogRow(opp, minScoreFloor, recoveryApplied) {`,
)
replaceOnce(
  'src/pages/DiscoverGrants.jsx',
  `import { keepDiscoverCatalogRow, isDirectoryDiscoverRow } from '@/lib/discoverCatalogKeep';`,
  `import {
  keepDiscoverCatalogRow,
  isDirectoryDiscoverRow,
  normalizeDiscoverResultPayload,
} from '@/lib/discoverCatalogKeep';`,
)
replaceOnce(
  'src/pages/DiscoverGrants.jsx',
  `      const rawOpportunities = Array.isArray(finalPayload?.opportunities)
        ? finalPayload.opportunities
        : Array.isArray(finalPayload?.data?.opportunities)
          ? finalPayload.data.opportunities
          : []
      // Frontend preferred floor for REVIEW/undecided rows. ACCEPT and
      // directory rows from the backend must not be re-dropped here.
      const opportunities = strictMinScore
        ? rawOpportunities.filter((opp) =>
            keepDiscoverCatalogRow(opp, effectiveMinMatchScore, Boolean(finalPayload?.relaxation?.applied)),
          )
        : rawOpportunities
      setScoreHint(finalPayload?.score_hint || null)
      await handleCrawlerResults(opportunities, finalPayload)`,
  `      const finalResultPayload = normalizeDiscoverResultPayload(finalPayload)
      const rawOpportunities = Array.isArray(finalResultPayload.opportunities)
        ? finalResultPayload.opportunities
        : []
      // Frontend preferred floor for REVIEW/undecided rows. ACCEPT and
      // directory rows from the backend must not be re-dropped here.
      const opportunities = strictMinScore
        ? rawOpportunities.filter((opp) =>
            keepDiscoverCatalogRow(
              opp,
              effectiveMinMatchScore,
              Boolean(finalResultPayload.relaxation?.applied),
            ),
          )
        : rawOpportunities
      setScoreHint(finalResultPayload.score_hint || null)
      await handleCrawlerResults(opportunities, finalResultPayload)`,
)

replaceOnce(
  'backend/tests/matchEngineSoftRelevanceAndMatchFunds.test.js',
  `import { computeMatchDecision, makeDecision } from '../services/matchEngine.js'`,
  `import { computeMatchDecision, makeDecision, normalizeOpportunity } from '../services/matchEngine.js'`,
)
replaceOnce(
  'backend/tests/matchEngineSoftRelevanceAndMatchFunds.test.js',
  `  it('softFail from relevanceFilter reduces canonical score vs clean peer', () => {`,
  `  it('does not apply soft relevance penalties to directory or referral pointers', () => {
    for (const opportunityKind of ['DIRECTORY', 'REFERRAL']) {
      const decision = computeMatchDecision(
        maleTnIndividual,
        baseOpp({
          id: \`pointer-\${opportunityKind.toLowerCase()}\`,
          title: 'Education resources for women scholars',
          description: 'A directory of education and workforce resources for women scholars.',
          opportunity_kind: opportunityKind,
          type: opportunityKind,
          is_directory_resource: opportunityKind === 'DIRECTORY',
        }),
      )
      expect(decision.match_explain?.soft_relevance_gate).toBeUndefined()
      expect((decision.match_explain?.scoreCaps || []).join(' ').toLowerCase())
        .not.toContain('soft relevance')
    }
  })

  it('softFail from relevanceFilter reduces canonical score vs clean peer', () => {`,
)
replaceOnce(
  'backend/tests/matchEngineSoftRelevanceAndMatchFunds.test.js',
  `  it('computeMatchDecision does not REJECT solely for requires_match', () => {
    const decision = computeMatchDecision(
      maleTnIndividual,
      baseOpp({
        requires_match: true,
        title: 'Tennessee Workforce Training Cost-Share Grant',
        description: 'Local workforce support for Tennessee residents; matching funds may be required.',
      }),
    )
    expect(decision.decision).not.toBe('REJECT')
    expect(decision.decision).toBe('REVIEW')
  })`,
  `  it('computeMatchDecision does not REJECT solely for requires_match', () => {
    const decision = computeMatchDecision(
      maleTnIndividual,
      baseOpp({
        requires_match: true,
        title: 'Tennessee Workforce Training Cost-Share Grant',
        description: 'Local workforce support for Tennessee residents; matching funds may be required.',
      }),
    )
    expect(decision.decision).not.toBe('REJECT')
    expect(decision.decision).toBe('REVIEW')
  })

  it('rejects an out-of-state profile before matching-funds review', () => {
    const floridaProfile = {
      ...maleTnIndividual,
      profile: { ...maleTnIndividual.profile, state: 'FL', city: 'Tampa', zip: '33602' },
      sections: {
        ...maleTnIndividual.sections,
        basic_information: {
          ...maleTnIndividual.sections.basic_information,
          state: 'FL',
          city: 'Tampa',
        },
      },
    }
    const decision = computeMatchDecision(
      floridaProfile,
      baseOpp({
        requires_match: true,
        title: 'Tennessee Residents Only Workforce Cost-Share Grant',
        description: 'Exclusively for Tennessee residents. Matching funds are required.',
        state: 'TN',
        state_residents_only: true,
      }),
    )
    expect(decision.decision).toBe('REJECT')
    expect(String(decision.explanation || '')).toMatch(/Geographic (?:mismatch|exclusivity)|Tennessee|TN/i)
  })`,
)
replaceOnce(
  'backend/tests/matchEngineSoftRelevanceAndMatchFunds.test.js',
  `  it('hard-rejects only explicit women-only language', () => {`,
  `  it('uses the same hard classification for named women-restricted programs', () => {
    const namedProgram = baseOpp({
      title: 'Society of Women Engineers Scholarship',
      description: 'Scholarship program for women engineers pursuing technical degrees.',
    })
    const strict = applyRelevanceFilter(
      namedProgram,
      { primary_type: 'individual', state: 'TN', gender: 'male' },
      { mode: 'soft' },
    )
    const normalized = normalizeOpportunity(namedProgram)
    const canonical = computeMatchDecision(maleTnIndividual, namedProgram)

    expect(strict.pass).toBe(false)
    expect(strict.ruleId).toBe('demographic_women_only')
    expect(normalized.requiresWomen).toBe(true)
    expect(normalized.requiresGender).toBe('female')
    expect(canonical.decision).toBe('REJECT')
  })

  it('hard-rejects only explicit women-only language', () => {`,
)

replaceOnce(
  'tests/unit/discoverCatalogKeep.test.js',
  `import { keepDiscoverCatalogRow } from '../../src/lib/discoverCatalogKeep.js'`,
  `import {
  keepDiscoverCatalogRow,
  normalizeDiscoverResultPayload,
} from '../../src/lib/discoverCatalogKeep.js'`,
)
replaceOnce(
  'tests/unit/discoverCatalogKeep.test.js',
  `describe('keepDiscoverCatalogRow', () => {`,
  `describe('normalizeDiscoverResultPayload', () => {
  it('returns direct response metadata and opportunities unchanged', () => {
    const payload = {
      opportunities: [{ id: 'direct' }],
      relaxation: { applied: true },
      score_hint: { floor: 7 },
    }
    expect(normalizeDiscoverResultPayload(payload)).toBe(payload)
  })

  it('unwraps the supported data envelope including recovery metadata', () => {
    const inner = {
      opportunities: [{ id: 'wrapped', threshold_relaxed: true }],
      relaxation: { applied: true },
      score_hint: { floor: 4 },
    }
    expect(normalizeDiscoverResultPayload({ data: inner })).toBe(inner)
  })
})

describe('keepDiscoverCatalogRow', () => {`,
)

writeNew(
  'backend/tests/matchThresholdsSoftPenalty.test.js',
  `import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL = process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY
  else process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY = ORIGINAL
  vi.resetModules()
})

describe('SOFT_RELEVANCE_PENALTY environment override', () => {
  it('falls back to the model default when the override is empty', async () => {
    process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY = '   '
    vi.resetModules()
    const thresholds = await import('../config/matchThresholds.js')
    expect(thresholds.SOFT_RELEVANCE_PENALTY)
      .toBe(thresholds.SCORING_MODEL === 'data_point' ? 4 : 25)
  })

  it('still accepts an explicit zero override', async () => {
    process.env.GRANTFLOW_SOFT_RELEVANCE_PENALTY = '0'
    vi.resetModules()
    const thresholds = await import('../config/matchThresholds.js')
    expect(thresholds.SOFT_RELEVANCE_PENALTY).toBe(0)
  })
})
`,
)

console.log('Applied PR #1179 review fixes')
