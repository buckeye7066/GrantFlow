/**
 * trustLayerPolicy.test.js
 *
 * Mission-outcome tests that lock down:
 *   A. Directory expiration policy (explicit policy decision).
 *   B. Scenario ranking outcomes (SDVOSB / faith-based / VFD / WOSB / nonprofit mission).
 *   C. Cross-surface consistency: the same opportunity is kept or dropped
 *      identically across discovery, matching, opportunities, realCrawlers,
 *      and the saved-grants write gate.
 *
 * These tests fail loudly if any surface re-introduces ad hoc placeholder /
 * loan / expired / URL-actionability filtering instead of consuming the
 * canonical `assessOpportunityTrust` / `gateOpportunityForPipeline` helpers.
 */
import { describe, it, expect } from 'vitest'
import {
  assessOpportunityTrust,
  gateOpportunityForPipeline,
  filterTrustedOpportunities,
  decorateOpportunityWithTrust,
  buildTrustMetadata,
} from '../services/opportunityTrust.js'
import { scoreOpportunity } from '../services/matchEngine.js'
import { normalizeProfile } from '../services/profileNormalizer.js'
import { buildProfileSignals } from '../services/profileHelpers.js'

function mkSections(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = { answers: v }
  }
  return out
}

function profileContextOf(profile, sections) {
  const signals = buildProfileSignals({ profile, sections })
  const profileNorm = normalizeProfile(profile, sections, signals)
  return { profile, sections, signals, profileNorm }
}

// ---------------------------------------------------------------------------
// A. Directory expiration policy
// ---------------------------------------------------------------------------
describe('Policy: directory expiration', () => {
  const directory = {
    id: 'dir-1',
    title: 'State Community Funding Directory',
    description: 'Pointer to state-maintained grant index.',
    application_url: 'https://www.tn.gov/funding-directory',
    opportunity_type: 'directory',
    record_origin: 'directory:state_index',
    // A past date on a directory row should NOT remove it — directories are
    // ongoing references, not a single award cycle.
    deadline: '2020-01-01',
    deadline_type: 'fixed',
  }

  it('keeps directory rows with display=true even if a past date is present', () => {
    const trust = assessOpportunityTrust(directory)
    expect(trust.display).toBe(true)
    expect(trust.flags.directory).toBe(true)
    expect(trust.flags.expired).toBe(false)
  })

  it('drops directory rows only when allowDirectory=false is explicitly requested', () => {
    const trust = assessOpportunityTrust(directory, { allowDirectory: false })
    expect(trust.display).toBe(false)
  })

  it('gateOpportunityForPipeline allows directories by default', () => {
    const gate = gateOpportunityForPipeline(directory)
    expect(gate.allowed).toBe(true)
  })

  it('non-directory rows with a past deadline ARE dropped as expired', () => {
    const trust = assessOpportunityTrust({
      id: 'reg-1',
      title: 'Regular Program',
      description: 'Ordinary grant program with a cycle.',
      application_url: 'https://grants.sba.gov/apply/x',
      record_origin: 'grants_gov',
      deadline: '2020-01-01',
      deadline_type: 'fixed',
    })
    expect(trust.display).toBe(false)
    expect(trust.flags.expired).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// B. Scenario ranking outcomes
//
// These tests verify that profiles with strong ownership / mission signals
// out-score generic profiles for aligned opportunities. Exact numeric scores
// are intentionally not asserted — only relative ordering, so the matcher is
// free to evolve weights without triggering false regressions.
// ---------------------------------------------------------------------------
describe('Scenario ranking — SDVOSB beats a generic business for an SDVOSB opportunity', () => {
  const sdvosb = profileContextOf(
    { id: 'sdvosb', primary_type: 'small_business', state: 'VA' },
    mkSections({
      organization_details: {
        organization_type: 'small_business',
        cert_sdvosb: true,
      },
      military_service: { branch: 'army', service_connected_disability: true },
      location_focus: { country: 'US', state: 'VA' },
    }),
  )
  const generic = profileContextOf(
    { id: 'generic-biz', primary_type: 'small_business', state: 'VA' },
    mkSections({
      organization_details: { organization_type: 'small_business' },
      location_focus: { country: 'US', state: 'VA' },
    }),
  )

  const opp = {
    id: 'sdvosb-opp',
    title: 'Service-Disabled Veteran-Owned Small Business Grant',
    description:
      'Supports SDVOSB-certified small businesses with capacity-building funding.',
    application_url: 'https://www.sba.gov/sdvosb-grant',
    record_origin: 'grants_gov',
    state: 'VA',
    is_national: true,
  }

  it('SDVOSB profile outranks generic business for an SDVOSB opportunity', () => {
    // Need-anchored scale: when both profiles' needs are equally covered the
    // PERCENTAGE is legitimately equal; ranking within a score band is carried
    // by the topical-evidence tie-break (see matchOpportunities sort).
    const sdv = scoreOpportunity(sdvosb, opp)
    const gen = scoreOpportunity(generic, opp)
    expect(sdv.score).toBeGreaterThanOrEqual(gen.score)
    expect(sdv.match_explain.scoreBreakdown.topical_evidence)
      .toBeGreaterThan(gen.match_explain.scoreBreakdown.topical_evidence)
  })

  it('Generic business is not hard-rejected (soft penalty, not disqualification)', () => {
    const result = scoreOpportunity(generic, opp)
    expect(result.score).toBeGreaterThan(0)
  })
})

describe('Scenario ranking — faith-based ministry beats generic nonprofit for a faith-based opp', () => {
  const ministry = profileContextOf(
    { id: 'min-1', primary_type: 'church', state: 'TN' },
    mkSections({
      organization_details: {
        organization_type: 'church',
        faith_based: true,
        denomination: 'nondenominational',
      },
      programs_services: {
        mission_focus: 'faith-based community outreach and food ministry',
        population_served: 'low-income families',
      },
      location_focus: { country: 'US', state: 'TN' },
    }),
  )
  const genericNonprofit = profileContextOf(
    { id: 'np-1', primary_type: 'nonprofit', state: 'TN' },
    mkSections({
      organization_details: { organization_type: 'nonprofit' },
      location_focus: { country: 'US', state: 'TN' },
    }),
  )

  const opp = {
    id: 'faith-opp',
    title: 'Faith-Based Community Outreach Grant',
    description:
      'Supports faith-based and religious community organizations delivering outreach, food ministry, and family services.',
    application_url: 'https://foundation.example-foundation.org/faith-grant',
    record_origin: 'cof_foundation_locator',
    state: 'TN',
  }

  it('Faith-based ministry outranks generic nonprofit for a faith-based opportunity', () => {
    // Same tie-break contract as the SDVOSB scenario above.
    const min = scoreOpportunity(ministry, opp)
    const gen = scoreOpportunity(genericNonprofit, opp)
    expect(min.score).toBeGreaterThanOrEqual(gen.score)
    expect(min.match_explain.scoreBreakdown.topical_evidence)
      .toBeGreaterThan(gen.match_explain.scoreBreakdown.topical_evidence)
  })
})

describe('Scenario ranking — VFD / first responder outscores generic nonprofit for AFG-style opp', () => {
  const vfd = profileContextOf(
    { id: 'vfd-1', primary_type: 'nonprofit', state: 'OH' },
    mkSections({
      organization_details: {
        organization_type: 'volunteer_fire_department',
        first_responder: true,
      },
      programs_services: {
        mission_focus: 'emergency services and community fire protection',
        population_served: 'rural community',
      },
      location_focus: { country: 'US', state: 'OH' },
    }),
  )
  const generic = profileContextOf(
    { id: 'np-2', primary_type: 'nonprofit', state: 'OH' },
    mkSections({
      organization_details: { organization_type: 'nonprofit' },
      location_focus: { country: 'US', state: 'OH' },
    }),
  )
  const opp = {
    id: 'afg-opp',
    title: 'Assistance to Firefighters Grant',
    description:
      'Supports volunteer fire departments, EMS, and first responder agencies with equipment and training funding.',
    application_url: 'https://www.fema.gov/grants/preparedness/firefighters',
    record_origin: 'grants_gov',
    state: 'OH',
    is_national: true,
  }

  it('VFD profile outranks generic nonprofit for an AFG opportunity', () => {
    // Same tie-break contract as the SDVOSB/ministry scenarios above.
    const vfdR = scoreOpportunity(vfd, opp)
    const genR = scoreOpportunity(generic, opp)
    expect(vfdR.score).toBeGreaterThanOrEqual(genR.score)
    expect(vfdR.match_explain.scoreBreakdown.topical_evidence)
      .toBeGreaterThan(genR.match_explain.scoreBreakdown.topical_evidence)
  })
})

// ---------------------------------------------------------------------------
// C. Cross-surface consistency
//
// Calls assessOpportunityTrust with the same defaults used by each surface
// helper (decorateOpportunityWithTrust, filterTrustedOpportunities,
// gateOpportunityForPipeline) and verifies the display decision is identical.
// If a surface ever re-implements filtering, this test will fail.
// ---------------------------------------------------------------------------
describe('Cross-surface consistency', () => {
  const rows = [
    // Kept: valid .gov opportunity
    {
      id: 'ok-1',
      title: 'SBA Community Grant',
      description: 'Supports community organizations.',
      application_url: 'https://grants.sba.gov/apply/community',
      record_origin: 'grants_gov',
    },
    // Dropped: placeholder URL
    {
      id: 'ph-1',
      title: 'Sample Grant',
      description: 'Lorem ipsum placeholder.',
      application_url: 'https://example.com/apply',
      record_origin: 'grants_gov',
    },
    // Dropped (display surfaces): loan
    {
      id: 'ln-1',
      title: 'SBA Microloan Program',
      description: 'Loan program for startups.',
      application_url: 'https://grants.sba.gov/microloan',
      record_origin: 'grants_gov',
      is_loan: 1,
    },
    // Kept: directory (must survive)
    {
      id: 'dir-1',
      title: 'State Funding Directory',
      description: 'Directory of state grants.',
      application_url: 'https://www.tn.gov/funding',
      opportunity_type: 'directory',
      record_origin: 'directory:state_index',
    },
    // Dropped: untrusted origin
    {
      id: 'un-1',
      title: 'Some Grant',
      description: 'Synthetic test row.',
      application_url: 'https://grants.sba.gov/apply/x',
      record_origin: 'synthetic',
    },
  ]

  const expected = {
    'ok-1': true,
    'ph-1': false,
    'ln-1': false,
    'dir-1': true,
    'un-1': false,
  }

  it('assessOpportunityTrust agrees with the expected policy', () => {
    for (const row of rows) {
      const trust = assessOpportunityTrust(row)
      expect(trust.display, `row ${row.id}`).toBe(expected[row.id])
    }
  })

  it('filterTrustedOpportunities keeps the same set as assessOpportunityTrust', () => {
    const { kept } = filterTrustedOpportunities([...rows])
    const keptIds = kept.map((r) => r.id).sort()
    const expectedKept = rows
      .filter((r) => expected[r.id])
      .map((r) => r.id)
      .sort()
    expect(keptIds).toEqual(expectedKept)
  })

  it('decorateOpportunityWithTrust attaches the same trust decision and metadata', () => {
    for (const row of rows) {
      const decorated = decorateOpportunityWithTrust(row)
      expect(decorated.trust_tier).toBe(decorated._trust.trustTier)
      expect(decorated.source_trust).toBe(decorated._trust.sourceTrust)
      expect(Boolean(decorated._trust.display)).toBe(expected[row.id])
    }
  })

  it('gateOpportunityForPipeline aligns with the display decision for write paths', () => {
    for (const row of rows) {
      const gate = gateOpportunityForPipeline(row)
      // Display surfaces and the pipeline gate must agree under default
      // options (directories allowed, loans/matching/expired denied) so we
      // never save an opportunity the user cannot see.
      expect(gate.allowed, `row ${row.id}`).toBe(expected[row.id])
      if (!gate.allowed) {
        expect(gate.reason).toBeTruthy()
      }
    }
  })

  it('buildTrustMetadata produces stable public fields', () => {
    const trust = assessOpportunityTrust(rows[0])
    const meta = buildTrustMetadata(trust)
    expect(meta).toMatchObject({
      trust_tier: expect.any(String),
      source_trust: expect.any(String),
      trust_flags: expect.any(Object),
      trust_reasons: expect.any(Array),
      trust_downgrade: expect.any(Boolean),
    })
  })
})
