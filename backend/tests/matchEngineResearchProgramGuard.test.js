/**
 * matchEngineResearchProgramGuard.test.js
 *
 * Regression coverage for the 2026-07-27 owner report: a profile's Funding
 * Sources list surfaced federal institutional program notices that had nothing
 * to do with the profile, at scores 16-18 with ACCEPT explanations:
 *
 *   • "Disability and Rehabilitation Research Projects (DRRP) Program:
 *      Community Living and Participation (Development)" — ACL research
 *      grants for institutions that DO disability research.
 *   • "Vet-LIRN Capacity-Building Project and Equipment Grants (U18)" — an
 *      FDA cooperative agreement for veterinary diagnostic LABORATORIES. No
 *      phrase in the title says "research"; the tell is the activity code.
 *   • "Community Services Block Grant (CSBG) Communities of Practice (COP)"
 *      — a federal TA/peer-network award funding ONE national provider.
 *   • "30-Day Notice of Proposed Information Collection: Economic Development
 *      Initiative Community Project Funding Grants" — a Paperwork Reduction
 *      Act comment notice. NOT a funding opportunity for anyone; it leaked in
 *      because the title names a real program.
 *
 * Root cause was two-sided:
 *   1. The institutional/research hard gate is person-shaped — it REJECTs
 *      individuals but passes EVERY org profile, so a church/service
 *      nonprofit inherited a university's eligibility surface and reached the
 *      list on topical keyword overlap alone.
 *   2. Nothing anywhere recognized PRA/procedural notices as non-opportunities.
 *
 * The fix: TITLE-scoped precise tells in normalizeOpportunity
 * (titleIsResearchProgram, isProceduralNotice), a score-crushing mismatch for
 * profiles with no research/academic mission, and a hard REJECT for
 * procedural notices in computeMatchDecision.
 */
import { describe, it, expect } from 'vitest'
import { scoreOpportunity, computeMatchDecision } from '../services/matchEngine.js'
import { normalizeOpportunity, RE_PROCEDURAL_NOTICE_TITLE } from '../services/opportunityNormalizer.js'
import {
  createFederalRegisterAdapter,
  RE_PROCEDURAL_NOTICE_TITLE as FR_ADAPTER_PROCEDURAL_RE,
} from '../crawler-os/adapters/federalRegisterAdapter.js'
import { AUTO_ADD_SCORE } from '../config/matchThresholds.js'

// ── Real rows from the owner's screenshot (titles verbatim) ────────────────

const DRRP_OPP = {
  id: 'drrp-dev',
  title:
    'Disability and Rehabilitation Research Projects (DRRP) Program: Community Living and Participation (Development)',
  sponsor: 'Administration for Community Living',
  description:
    'Grants to generate new knowledge that improves community living and participation outcomes for people with disabilities.',
  application_url: 'https://www.grants.gov/search-results-detail/drrp-dev',
  is_national: true,
  categories: ['disability', 'community'],
}

const VET_LIRN_OPP = {
  id: 'vet-lirn',
  title: 'Vet-LIRN Capacity-Building Project and Equipment Grants (U18)',
  sponsor: 'Food and Drug Administration',
  description:
    'Cooperative agreement to expand veterinary diagnostic laboratory capacity and equipment within the network.',
  application_url: 'https://www.grants.gov/search-results-detail/vet-lirn',
  is_national: true,
  amount_min: 225000,
  amount_max: 2500000,
}

const CSBG_COP_OPP = {
  id: 'csbg-cop',
  title: 'Community Services Block Grant (CSBG) Communities of Practice (COP)',
  sponsor: 'Administration for Children and Families - OCS',
  description:
    'Supports peer learning and technical assistance across the CSBG network to strengthen services for low-income families, housing, and food security.',
  application_url: 'https://www.grants.gov/search-results-detail/csbg-cop',
  is_national: true,
}

const PRA_NOTICE_OPP = {
  id: 'hud-pra',
  title:
    '30-Day Notice of Proposed Information Collection: Economic Development Initiative Community Project Funding Grants',
  sponsor: 'Housing and Urban Development Department',
  description:
    'HUD is seeking approval from the Office of Management and Budget for the information collection described below. Comments due within 30 days.',
  application_url: 'https://www.federalregister.gov/documents/hud-pra-notice',
  is_national: true,
}

// A legitimate org-facing grant that must NOT trip the new title tells: local
// capacity-building money a service nonprofit really can pursue.
const LEGIT_ORG_GRANT = {
  id: 'legit-capacity',
  title: 'Nonprofit Capacity Building Program',
  sponsor: 'Community Foundation of Middle Tennessee',
  description:
    'General operating and capacity building support for nonprofits serving people with disabilities. Nonprofits and local governments may apply.',
  application_url: 'https://www.cfmt.org/capacity',
  state: 'TN',
}

// ── Profiles ───────────────────────────────────────────────────────────────

const SERVICE_NONPROFIT_PROFILE = {
  id: 'p-church',
  primary_type: 'nonprofit',
  organization_name: 'Grace Community Outreach',
  state: 'TN',
  city: 'Nashville',
  needs: ['disability', 'housing', 'food'],
}

const RESEARCH_ORG_PROFILE = {
  id: 'p-research',
  primary_type: 'nonprofit',
  organization_name: 'Appalachian Disability Research Institute',
  state: 'TN',
  needs: ['research', 'disability'],
}

const INDIVIDUAL_PROFILE = {
  id: 'p-ind',
  primary_type: 'individual',
  first_name: 'Dana',
  state: 'TN',
  needs: ['disability', 'housing'],
}

// ── Normalizer tells ───────────────────────────────────────────────────────

describe('normalizeOpportunity TITLE-scoped tells', () => {
  it('flags the DRRP research-projects title', () => {
    expect(normalizeOpportunity(DRRP_OPP).titleIsResearchProgram).toBe(true)
  })

  it('flags a parenthesized federal activity code — the Vet-LIRN (U18) class', () => {
    expect(normalizeOpportunity(VET_LIRN_OPP).titleIsResearchProgram).toBe(true)
  })

  it('flags Communities of Practice TA awards — the CSBG COP class', () => {
    expect(normalizeOpportunity(CSBG_COP_OPP).titleIsResearchProgram).toBe(true)
  })

  it('flags a Paperwork Reduction Act notice as procedural', () => {
    expect(normalizeOpportunity(PRA_NOTICE_OPP).isProceduralNotice).toBe(true)
  })

  it('flags recission / waiver-record / guideline-modification notices (live prod titles, 2026-07-27)', () => {
    const titles = [
      'Notice of Recission of Funding Opportunity for the Rural Community Development Program',
      'Notice of Rescission of Funding Opportunity Announcement',
      'Notice of Regulatory Waiver Requests Granted for the Fourth Quarter of Calendar Year 2025',
      'Modification of Living Organ Donation Reimbursement Program Eligibility Guidelines',
    ]
    for (const title of titles) {
      expect(normalizeOpportunity({ id: 't', title }).isProceduralNotice, title).toBe(true)
    }
    // A real program whose title merely contains "modification" stays live.
    expect(
      normalizeOpportunity({ id: 'h', title: 'Home Modification Assistance Grants for Seniors' }).isProceduralNotice,
    ).toBe(false)
  })

  it('does NOT flag a legitimate nonprofit capacity grant (org-eligibility prose stays safe)', () => {
    const norm = normalizeOpportunity(LEGIT_ORG_GRANT)
    expect(norm.titleIsResearchProgram).toBe(false)
    expect(norm.isProceduralNotice).toBe(false)
  })

  it('does NOT flag SBIR/STTR — small-business research grants ARE for businesses', () => {
    expect(
      normalizeOpportunity({ id: 's', title: 'SBA Small Business Innovation Research Grant' }).titleIsResearchProgram,
    ).toBe(false)
    expect(
      normalizeOpportunity({ id: 't', title: 'STTR Phase I Research Grants (R41)' }).titleIsResearchProgram,
    ).toBe(false)
  })

  it('does NOT flag fellowships (they fund people) or K12 (education, not an activity code)', () => {
    expect(
      normalizeOpportunity({ id: 'f', title: 'NSF Graduate Research Fellowship Program' }).titleIsResearchProgram,
    ).toBe(false)
    expect(
      normalizeOpportunity({ id: 'k', title: 'STEM Education Awards (K12)' }).titleIsResearchProgram,
    ).toBe(false)
  })
})

// ── Score crush for profiles with no research/academic mission ────────────

describe('research-program guard (score path)', () => {
  it.each([
    ['DRRP', DRRP_OPP],
    ['Vet-LIRN (U18)', VET_LIRN_OPP],
    ['CSBG COP', CSBG_COP_OPP],
  ])('crushes %s below the surfacing bar for a service nonprofit with no research mission', (_label, opp) => {
    const { score, match_explain } = scoreOpportunity(SERVICE_NONPROFIT_PROFILE, opp)
    expect(match_explain.scoreBreakdown.eligibility_mismatches).toContain('research_program_no_research_mission')
    expect(score).toBeLessThan(AUTO_ADD_SCORE)
  })

  it('a research org keeps its full score (G4: mismatch reduces, never blanket-crushes)', () => {
    const { match_explain } = scoreOpportunity(RESEARCH_ORG_PROFILE, DRRP_OPP)
    expect(match_explain.scoreBreakdown.eligibility_mismatches ?? []).not.toContain('research_program_no_research_mission')
  })

  it('a procedural notice is crushed for every profile type', () => {
    for (const profile of [SERVICE_NONPROFIT_PROFILE, INDIVIDUAL_PROFILE]) {
      const { score, match_explain } = scoreOpportunity(profile, PRA_NOTICE_OPP)
      expect(match_explain.scoreBreakdown.eligibility_mismatches).toContain('procedural_notice_not_fundable')
      expect(score).toBeLessThan(AUTO_ADD_SCORE)
    }
  })

  it('does not crush a legitimate capacity grant for the same nonprofit', () => {
    const { match_explain } = scoreOpportunity(SERVICE_NONPROFIT_PROFILE, LEGIT_ORG_GRANT)
    expect(match_explain.scoreBreakdown.eligibility_mismatches ?? []).not.toContain('research_program_no_research_mission')
  })
})

// ── Decision path ──────────────────────────────────────────────────────────

describe('research-program + procedural-notice guard (decision path)', () => {
  it('REJECTs an activity-code cooperative agreement for an individual (the Vet-LIRN class)', () => {
    const d = computeMatchDecision(INDIVIDUAL_PROFILE, VET_LIRN_OPP)
    expect(d.decision).toBe('REJECT')
  })

  it('REJECTs a Paperwork Reduction Act notice for every profile type', () => {
    for (const profile of [INDIVIDUAL_PROFILE, SERVICE_NONPROFIT_PROFILE, RESEARCH_ORG_PROFILE]) {
      const d = computeMatchDecision(profile, PRA_NOTICE_OPP)
      expect(d.decision).toBe('REJECT')
      expect(d.explanation).toMatch(/not a funding opportunity/i)
    }
  })

  it('never lets DRRP claim ACCEPT for a non-research nonprofit', () => {
    const d = computeMatchDecision(SERVICE_NONPROFIT_PROFILE, DRRP_OPP)
    expect(d.decision).not.toBe('ACCEPT')
    expect(d.score).toBeLessThan(AUTO_ADD_SCORE)
  })
})

// ── Structural-kind override: resource kinds never trip prose-based
//    restriction tells (the MTSU off-campus-housing class, 2026-07-27) ─────

describe('resource-kind override for institutional/research tells', () => {
  // Real prod row (verbatim description): Anastasia's own university housing
  // portal hard-rejected as "institutions or research organizations only"
  // because its prose contains 'institutions'/'institutional'.
  const MTSU_PORTAL = {
    id: 'mtsu-portal',
    title: 'Middle Tennessee State University — Off-Campus Housing Portal',
    sponsor: 'Middle Tennessee State University Department of Housing & Residential Life',
    description:
      'Official off-campus housing listing portal vetted by Middle Tennessee State University. Lists landlord contact info, pricing, lease terms for properties near campus. Many institutions partner with the listing service to flag properties that accept the institutional housing voucher / direct-bill the student account.',
    application_url: 'https://offcampushousing.mtsu.edu',
    source_url: 'https://offcampushousing.mtsu.edu',
    deadline_type: 'rolling',
    record_origin: 'live_crawl',
    opportunity_kind: 'school_portal',
  }

  const MTSU_STUDENT = {
    id: 'p-mtsu-student',
    primary_type: 'student',
    first_name: 'Anastasia',
    state: 'TN',
    needs: ['housing', 'education'],
  }

  it('a declared school_portal never reads as institutional-only from its prose', () => {
    const n = normalizeOpportunity(MTSU_PORTAL)
    expect(n.isInstitutionalOnly).toBe(false)
    expect(n.isResearchOnly).toBe(false)
  })

  it('A/B: the SAME text WITHOUT a resource kind still trips the pattern (recall preserved)', () => {
    const n = normalizeOpportunity({ ...MTSU_PORTAL, opportunity_kind: null })
    expect(n.isInstitutionalOnly).toBe(true)
  })

  it('an explicit is_institutional_only DB flag still wins on a resource kind (structural beats structural)', () => {
    const n = normalizeOpportunity({ ...MTSU_PORTAL, is_institutional_only: 1 })
    expect(n.isInstitutionalOnly).toBe(true)
  })

  it('a student is never hard-rejected from her own school portal', () => {
    const d = computeMatchDecision(MTSU_STUDENT, MTSU_PORTAL)
    expect(d.decision).not.toBe('REJECT')
  })

  it('a research directory (resource kind) does not trip the title tell either', () => {
    expect(normalizeOpportunity({
      id: 'rd', title: 'Federal Research Grants Directory', opportunity_kind: 'DIRECTORY',
    }).titleIsResearchProgram).toBe(false)
  })
})

// ── Ingest side: the Federal Register adapter drops PRA notices ───────────

describe('federalRegisterAdapter procedural exclusion (ingest side)', () => {
  const adapter = createFederalRegisterAdapter()
  const ctx = { thesis: {}, source: { source_id: 'federal_register' } }

  it('drops a PRA notice even though its title contains funding vocabulary', () => {
    const mapped = adapter.mapCandidate({
      external_id: '2026-12345',
      title: PRA_NOTICE_OPP.title,
      info_url: 'https://www.federalregister.gov/documents/2026-12345',
      summary: PRA_NOTICE_OPP.description,
      agencies: [{ name: 'Housing and Urban Development Department' }],
    }, ctx)
    expect(mapped).toBeNull()
  })

  it('keeps a genuine NOFO notice', () => {
    const mapped = adapter.mapCandidate({
      external_id: '2026-67890',
      title: 'Notice of Funding Opportunity: Rural Health Network Development Program',
      info_url: 'https://www.federalregister.gov/documents/2026-67890',
      summary: 'HRSA announces the availability of funds for rural health networks.',
      agencies: [{ name: 'Health Resources and Services Administration' }],
    }, ctx)
    expect(mapped).not.toBeNull()
    expect(mapped.title).toMatch(/Rural Health Network/)
  })

  it('DRIFT TRIPWIRE: the adapter and normalizer procedural regexes are identical', () => {
    // crawler-os is deliberately self-contained, so the pattern lives in both
    // modules. If they drift, ingest and match-time judgments disagree — one
    // side keeps admitting what the other rejects.
    expect(String(FR_ADAPTER_PROCEDURAL_RE)).toBe(String(RE_PROCEDURAL_NOTICE_TITLE))
  })
})
