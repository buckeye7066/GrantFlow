import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VERIFIED_FOUR_TRUTH_PROOF } from './helpers/fourTruthFixture.js'
import {
  ACCEPT_SCORE,
  REVIEW_SCORE,
  SCORE_SCALE_ID,
  STRONG_MATCH_SCORE,
} from '../config/matchThresholds.js'
import {
  attachStoredMatchAuthority,
  selectCanonicalDisplayOpportunities,
} from '../routes/realCrawlers.js'

const profileContext = {
  profile: {
    id: 'profile-display-authority',
    primary_type: 'individual',
    state: 'OH',
  },
  sections: {
    employment: { career_goal: 'professional development' },
  },
  signals: {
    needs: new Set(['professional_development']),
  },
}

function storedMatch(overrides = {}) {
  return {
    id: 'stored-match',
    title: 'Veterans and Military Family Assistance Grant',
    description: 'Official assistance grants for veterans and military families.',
    sponsor: 'Department of Veterans Affairs',
    source: 'official_federal',
    record_origin: 'live_crawl',
    source_url: 'https://va.gov/family-assistance-grant',
    application_url: 'https://va.gov/family-assistance-grant/apply',
    is_national: true,
    is_active: true,
    opportunity_kind: 'direct_grant',
    deadline_type: 'rolling',
    categories: ['professional_development'],
    matcher_version: 'crawler-os',
    match_score: ACCEPT_SCORE,
    match_decision: 'ACCEPT',
    match_explanation: 'Persisted canonical decision.',
    four_truth_proof: VERIFIED_FOUR_TRUTH_PROOF,
    ...overrides,
  }
}

describe('real crawler display authority', () => {
  it('reattaches the persisted decision and lifecycle artifact by opportunity id', async () => {
    let boundArgs = null
    const db = {
      prepare(sql) {
        expect(sql).toContain('JOIN funding_opportunities')
        return {
          all(...args) {
            boundArgs = args
            return [{
              opportunity_id: 'stored-match',
              match_score: REVIEW_SCORE,
              match_confidence: null,
              match_decision: 'REVIEW',
              match_explanation: 'Persisted review.',
              match_reasons: '["profile need"]',
              match_explain_json: '{"why":"Persisted review."}',
              matcher_version: 'crawler-os',
              opportunity_kind: 'referral',
              link_status: 'unverified',
              reality_status: 'allowed',
            }]
          },
        }
      },
    }

    const [attached] = await attachStoredMatchAuthority(db, profileContext.profile.id, [{
      id: 'stored-match',
      name: 'Stored result',
      matchScore: STRONG_MATCH_SCORE,
    }])

    expect(boundArgs).toEqual([profileContext.profile.id, 'stored-match'])
    expect(attached.matchScore).toBe(REVIEW_SCORE)
    expect(attached.matchDecision).toBe('REVIEW')
    expect(attached.matcherVersion).toBe('crawler-os')
    expect(attached.opportunity_kind).toBe('referral')
    expect(attached.link_status).toBe('unverified')
  })

  it('preserves verified ACCEPT but withholds unproven direct REVIEW without rescoring', () => {
    const accept = storedMatch()
    const review = storedMatch({
      id: 'stored-review',
      title: 'Ohio Credential Resource',
      match_score: REVIEW_SCORE,
      match_decision: 'REVIEW',
    })

    const selection = selectCanonicalDisplayOpportunities(
      profileContext,
      [accept, review],
      { minScore: REVIEW_SCORE },
    )

    expect(selection.opportunities).toHaveLength(1)
    expect(selection.score_scale_id).toBe(SCORE_SCALE_ID)
    expect(selection.opportunities.map(({ id, match_score, match_decision }) => ({
      id,
      match_score,
      match_decision,
    }))).toEqual([
      { id: accept.id, match_score: ACCEPT_SCORE, match_decision: 'ACCEPT' },
    ])
  })

  it('uses minScore only as a display preference and keeps honest pointers', () => {
    const accept = storedMatch()
    const review = storedMatch({
      id: 'stored-review',
      match_score: REVIEW_SCORE,
      match_decision: 'REVIEW',
    })
    const referral = storedMatch({
      id: 'stored-referral',
      title: 'Ohio Workforce Funding Directory',
      opportunity_kind: 'referral',
      is_directory_resource: true,
      match_score: REVIEW_SCORE,
      match_decision: 'REVIEW',
    })

    const selection = selectCanonicalDisplayOpportunities(
      profileContext,
      [accept, review, referral],
      { minScore: STRONG_MATCH_SCORE },
    )

    expect(selection.opportunities.map((row) => row.id)).toEqual([
      accept.id,
      referral.id,
    ])
    expect(selection.display_preference_excluded).toBe(1)
    expect(accept.match_score).toBe(ACCEPT_SCORE)
    expect(review.match_decision).toBe('REVIEW')
  })

  it('keeps lifecycle/trust quarantine for direct rows while labeling pointers', () => {
    const brokenDirect = storedMatch({
      id: 'broken-direct',
      link_status: 'broken',
    })
    const brokenDirectory = storedMatch({
      id: 'broken-directory',
      title: 'Veterans Funding Resource Directory',
      opportunity_kind: 'directory',
      is_directory_resource: true,
      link_status: 'broken',
      match_score: REVIEW_SCORE,
      match_decision: 'REVIEW',
    })

    const selection = selectCanonicalDisplayOpportunities(
      profileContext,
      [brokenDirect, brokenDirectory],
      { minScore: STRONG_MATCH_SCORE },
    )

    expect(selection.opportunities).toHaveLength(1)
    expect(selection.opportunities[0].id).toBe(brokenDirectory.id)
    expect(selection.opportunities[0].trust_downgrade).toBe(true)
    expect(selection.dropped.trust).toBe(1)
  })

  it('drops explicit hidden/inactive rows before stored ACCEPT or pointer rescue', () => {
    const hiddenAccept = storedMatch({
      id: 'hidden-accept',
      is_hidden: 1,
      is_active: 1,
    })
    const inactiveAccept = storedMatch({
      id: 'inactive-accept',
      is_hidden: 0,
      is_active: 0,
    })
    const hiddenPointer = storedMatch({
      id: 'hidden-pointer',
      title: 'Quarantined Funding Directory',
      opportunity_kind: 'directory',
      is_directory_resource: true,
      is_hidden: true,
      is_active: true,
      match_score: REVIEW_SCORE,
      match_decision: 'REVIEW',
    })
    const visiblePointer = storedMatch({
      id: 'visible-pointer',
      title: 'Visible Funding Directory',
      opportunity_kind: 'directory',
      is_directory_resource: true,
      is_hidden: false,
      is_active: true,
      match_score: REVIEW_SCORE,
      match_decision: 'REVIEW',
    })

    const selection = selectCanonicalDisplayOpportunities(
      profileContext,
      [hiddenAccept, inactiveAccept, hiddenPointer, visiblePointer],
      { minScore: STRONG_MATCH_SCORE },
    )

    expect(selection.opportunities.map((row) => row.id)).toEqual(['visible-pointer'])
    expect(selection.dropped).toMatchObject({
      lifecycle_hidden: 2,
      lifecycle_inactive: 1,
    })
  })

  it('contains no route-local eligibility retry or retired score wording', () => {
    const routeSource = readFileSync(new URL('../routes/realCrawlers.js', import.meta.url), 'utf8')
    const pdSource = readFileSync(new URL('../services/matching/professionalDevelopmentPolicy.js', import.meta.url), 'utf8')
    const surfacingSource = readFileSync(new URL('../config/matchSurfacing.js', import.meta.url), 'utf8')
    const authoritySource = [routeSource, pdSource, surfacingSource].join('\n')

    expect(routeSource).not.toMatch(/applyRelevanceFilter|filterActionableOpportunities/)
    expect(routeSource).not.toMatch(/mode\s*:\s*['"]soft['"]/)
    expect(routeSource).not.toMatch(/match_score\s*>?=\s*(?:Number\()?minScore/)
    expect(routeSource.match(/selectCanonicalDisplayOpportunities/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(pdSource).not.toMatch(/pd_cross_category_capped|capped\s+at/i)
    expect(surfacingSource).not.toMatch(/ACCEPT_SCORE\s*\(\s*70\s*\)/)
    expect(authoritySource).not.toMatch(/\b(?:25|50|70|80)\s*%/)
    expect(authoritySource).not.toMatch(/\bpercent(?:age)?\b/i)
  })
})
