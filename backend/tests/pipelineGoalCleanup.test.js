/**
 * pipelineGoalCleanup.test.js
 *
 * Pins the per-item verdict matrix produced by classifyPipelineItem so the
 * mission-goal cleanup never silently regresses across profiles.
 *
 * Covers:
 *   - Goal 1 — items from disallowed sources are removed.
 *   - Goal 1 + Goal 7 — items with no usable URL on the grant or its linked
 *     opportunity are removed (unless it's a directory resource).
 *   - Goal 8 — directory resources ALWAYS survive (recall over suppression),
 *     even with no URL and even when other rules would normally fail.
 *   - Goal 9 — duplicate titles within the same profile collapse to a
 *     single keep + a removal of the rest.
 *   - Goal 6 — title-state mismatches are removed.
 *   - Goal 2 + Goal 4 — relevance_reject pulls in canonical match-engine
 *     verdicts; soft mismatches are NOT a reason to remove.
 *   - Manual entries (no funding_opportunity_id) bypass source/match-engine
 *     checks but still enforce dedupe and dead-URL.
 */
import { describe, it, expect } from 'vitest'
import { classifyPipelineItem } from '../services/pipelineGoalCleanupService.js'

const TN_PROFILE = { id: 'p1', primary_type: 'individual', tags: [] }
const TN_SECTIONS = { basic_information: { state: 'TN' } }

function makeRow(overrides = {}) {
  return {
    id: overrides.id || 'g-1',
    title: overrides.title ?? 'Example Grant',
    funder: 'Example Foundation',
    notes: null,
    status: 'interested',
    deadline: null,
    created_at: '2026-01-01T00:00:00.000Z',
    application_url: 'https://example.org/apply',
    grant_url: null,
    portal_url: null,
    profile_id: 'p1',
    organization_id: null,
    funding_opportunity_id: 'opp-1',
    opp_source: 'grants.gov',
    opp_description: 'Funding for individuals',
    opp_sponsor: 'Example Foundation',
    opp_eligibility_bullets: [],
    opp_categories: [],
    opp_keywords: [],
    opp_is_national: true,
    opp_state: null,
    opp_application_url: 'https://example.org/apply',
    opp_apply_url: null,
    opp_source_url: 'https://example.org',
    opp_evidence_url: null,
    opp_verified_url: null,
    opp_kind: null,
    opp_record_origin: 'curated',
    opp_is_loan: false,
    opp_deadline: null,
    opp_deadline_type: null,
    opp_funding_type: 'grant',
    opp_opportunity_type: null,
    opp_entity_types_allowed: null,
    opp_need_types_supported: null,
    ...overrides,
  }
}

describe('classifyPipelineItem — Goal 1 (real funding only)', () => {
  it('removes items from disallowed sources', () => {
    const row = makeRow({ opp_source: 'random_blog_scraper' })
    const result = classifyPipelineItem(row, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('source_disallowed')
    expect(result.ruleId).toBe('goal1.source_allowlist')
    expect(result.reason).toContain('random_blog_scraper')
  })

  it('keeps items from any allowlisted source', () => {
    const row = makeRow({ opp_source: 'verified_real' })
    const result = classifyPipelineItem(row, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('keep')
  })
})

describe('classifyPipelineItem — Goal 1 + Goal 7 (dead URLs)', () => {
  it('removes items with no usable URL anywhere', () => {
    const row = makeRow({
      application_url: null,
      grant_url: null,
      portal_url: null,
      opp_application_url: null,
      opp_apply_url: null,
      opp_source_url: null,
      opp_evidence_url: null,
      opp_verified_url: null,
    })
    const result = classifyPipelineItem(row, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('dead_url')
    expect(result.ruleId).toBe('goal1.no_dead_links')
  })

  it('keeps items if any one of the URL columns is populated', () => {
    const row = makeRow({
      application_url: null,
      opp_application_url: null,
      opp_apply_url: null,
      opp_source_url: 'https://program.example.gov/apply',
      opp_evidence_url: null,
    })
    const result = classifyPipelineItem(row, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('keep')
  })
})

describe('classifyPipelineItem — Goal 8 (directory resources always survive)', () => {
  it('keeps a directory resource even without a URL', () => {
    const row = makeRow({
      title: 'United Way 211 — Local Assistance Finder',
      application_url: null,
      grant_url: null,
      portal_url: null,
      opp_application_url: null,
      opp_apply_url: null,
      opp_source_url: null,
      opp_evidence_url: null,
      opp_verified_url: null,
      opp_kind: 'DIRECTORY',
      opp_record_origin: 'directory.local',
      opp_source: 'local_directory_united_way',
    })
    const result = classifyPipelineItem(row, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('keep')
  })

  it('does not remove a directory resource on wrong-state grounds', () => {
    const row = makeRow({
      title: 'Ohio United Way Resource Directory',
      opp_kind: 'DIRECTORY',
      opp_record_origin: 'directory.local',
      opp_source: 'local_directory_united_way',
    })
    const result = classifyPipelineItem(row, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('keep')
  })
})

describe('classifyPipelineItem — Goal 9 (no duplicates)', () => {
  it('keeps the first occurrence and removes later duplicates', () => {
    const seen = new Set()
    // Use a title that does NOT trip exclusive-eligibility flags (no student-aid,
    // women-only, veteran-only signals). The Goal 9 dedupe rule must fire before
    // any matching-engine REJECT can mask it.
    const row1 = makeRow({ id: 'g-1', title: 'Tennessee Family Resource Grant' })
    const row2 = makeRow({ id: 'g-2', title: 'Tennessee Family Resource Grant' })
    const r1 = classifyPipelineItem(row1, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: seen,
    })
    const r2 = classifyPipelineItem(row2, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: seen,
    })
    expect(r1.verdict).toBe('keep')
    expect(r2.verdict).toBe('duplicate_title')
    expect(r2.ruleId).toBe('goal9.no_duplicates')
  })
})

describe('classifyPipelineItem — Goal 6 (geographic match)', () => {
  it('removes items whose title implies a different state than the profile', () => {
    const row = makeRow({ title: 'Ohio Family and Children First Grant' })
    const result = classifyPipelineItem(row, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('wrong_state')
    expect(result.ruleId).toBe('goal6.geographic_match')
  })

  it('keeps items whose title matches the profile state', () => {
    // Same constraint as the Goal 9 dedupe test: pick a TN program whose title
    // does not also trigger exclusive-eligibility flags (HOPE / Pell / FAFSA
    // etc.), so the geography check is what's being exercised here.
    const row = makeRow({ title: 'Tennessee Family Resource Grant' })
    const result = classifyPipelineItem(row, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('keep')
  })

  it('does NOT treat a county/city NAME sharing a state name as a state claim (county-as-state guard)', () => {
    // "Delaware County, Ohio" is a real place inside Ohio -- the bare
    // substring "delaware" must not be read as a claim about the state of
    // Delaware. A bare-substring extractStateNameFromTitle would have
    // resolved this to 'DE' and wrongly rejected a legitimate Ohio county
    // resource for an Ohio profile as wrong_state.
    const row = makeRow({ title: 'Delaware County, Ohio 211 Community Resources' })
    const result = classifyPipelineItem(row, {
      profile: { id: 'p2', primary_type: 'individual', tags: [] },
      sections: { basic_information: { state: 'OH' } },
      seenTitles: new Set(),
    })
    expect(result.verdict).not.toBe('wrong_state')
  })

  it('resolves a title naming the state of Washington (was previously missing from the state-name list)', () => {
    // Washington was omitted entirely from STATE_NAME_TO_ABBR, so a title
    // naming it could never trigger the wrong_state check for any profile
    // (extractStateNameFromTitle returned null -> treated as neutral).
    const row = makeRow({ title: 'Washington State Housing Assistance Program' })
    const result = classifyPipelineItem(row, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('wrong_state')
    expect(result.ruleId).toBe('goal6.geographic_match')
  })
})

describe('classifyPipelineItem — recall over suppression (Goal 8)', () => {
  it('keeps an item with a profile-state we cannot determine — never silently filters', () => {
    const row = makeRow({ title: 'Ohio Generic Program' })
    const result = classifyPipelineItem(row, {
      profile: { id: 'p2', primary_type: 'individual' },
      sections: {}, // no state anywhere
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('keep')
  })

  it('a soft eligibility mismatch (population) does NOT remove the item', () => {
    // Match engine + relevance filter must prefer recall when only soft
    // signals would push back. We simulate by giving the matcher minimal
    // data and asserting the verdict is keep.
    const row = makeRow({
      title: 'Generic Community Grant',
      opp_description: 'Open to community organizations and individuals',
    })
    const result = classifyPipelineItem(row, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('keep')
  })
})

describe('classifyPipelineItem — manual entries', () => {
  it('keeps a manual entry (no funding_opportunity_id) when URL + title are valid', () => {
    const row = makeRow({
      funding_opportunity_id: null,
      opp_source: null,
      application_url: 'https://manual.example.org/apply',
    })
    const result = classifyPipelineItem(row, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('keep')
  })

  it('removes a manual entry that has no URL anywhere (still violates Goal 1)', () => {
    const row = makeRow({
      funding_opportunity_id: null,
      opp_source: null,
      application_url: null,
      grant_url: null,
      portal_url: null,
      opp_application_url: null,
      opp_apply_url: null,
      opp_source_url: null,
      opp_evidence_url: null,
      opp_verified_url: null,
    })
    const result = classifyPipelineItem(row, {
      profile: TN_PROFILE,
      sections: TN_SECTIONS,
      seenTitles: new Set(),
    })
    expect(result.verdict).toBe('dead_url')
  })
})
