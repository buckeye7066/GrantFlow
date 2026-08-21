/**
 * Website-purpose matching — Axiom BioLabs / research-lab regression.
 *
 * Owner 2026-08-20: Hamilton showed ~87 "Working on now" portal tasks for
 * Axiom BioLabs, almost none of which match a CAR-T / transplant biotech lab.
 * GrantFlow must read the profile website URL to know what the profile is.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  classifyOpportunitiesAgainstWebsitePurpose,
  deriveWebsitePurpose,
  detectUnrelatedPurposeLock,
  opportunityHasResearchAlignedIdentity,
  resolveProfileWebsiteUrl,
  websitePurposeConflict,
} from '../config/profileWebsitePurpose.js'
import { deriveProfileFacts, searchTermsFromFacts } from '../config/profileDerivedFacts.js'
import { stageOfLifeConflictForSections } from '../config/stageOfLifeEligibility.js'
import { enrichProfileWebsitePurpose } from '../services/profileWebsitePurposeEnrichment.js'
import { computeMatchDecision } from '../services/matchEngine.js'

const AXIOM_SECTIONS = {
  basic_information: {
    website: 'https://axiombiolabs.org',
    email: 'dr.johnwhite@axiombiolabs.org',
  },
  organization_details: {
    organization_type: 'Biotechnology / research organization',
    mission:
      'Patent-pending CAR-T platform for transplant immune tolerance; genomics and diagnostics.',
  },
}

const AXIOM_JUNK_TITLES = [
  'FY 2026 CN Technology Innovation Grant for Child and Adult Care Food Program Integrity',
  'Agency Information Collection Activities: Proposed Collection: Public Comment Request; Information Collection Request Title: Questionnaire and Data Collection Testing, Evaluation, and Research for the Health Resources and Services Administration, OMB No. 0915-0379-Revision',
  'Innovation Challenge: Alternatives to Conventional Pesticides for Crop Desiccation; Notice of Availability',
  'FY26 Law Enforcement Mental Health and Wellness Act Program',
  'Title X Family Planning Services Grants',
  "Alzheimer's Disease Programs Initiative (ADPI) - State and Community Grant Program",
  'Outdoor Recreation Legacy Partnership Program (ORLP) Recurring Notice 5 Year',
  'Specialty Crop Multi-State Grant Program 2026',
  'Commercial Fishing Occupational Safety Research Cooperative Agreement (U01)',
  'FY26 Ruth D. Gates Coral Reef Conservation Grants - Fishery Management',
  'HSLDA Compassion Grants (homeschool families)',
  'FY26 Pathways to Removing Obstacles to Housing (PRO Housing)',
  'Lead-Safe and Healthy Homes Financing Demonstration',
  'National Technical Assistance Center on Kinship and Grandfamilies',
  'MINE HEALTH AND SAFETY STATE GRANTS',
  'Scaling Evidence-Based Falls Prevention Programs',
  'OVC FY 2026 National Mass Violence Center',
  'F26AS00085 Aquatic Invasive Species Interjurisdictional Grants to the Great Lakes States and Tribes - Fiscal Year 2026 Great Lakes Restoration Initiative',
  'Solicitation of Input from Stakeholder on Title II Food for Peace Non-Emergency Programming',
  'Vet-LIRN Capacity-Building Project and Equipment Grants (U18)',
]

const AXIOM_ALIGNED_TITLES = [
  'NIH Small Business Technology Transfer Grant (Parent STTR [R41/R42] Clinical Trial Optional)',
  'SBIR/STTR Commercialization Readiness Pilot (CRP) Program (Parent SB1 Clinical Trial Optional)',
  'Engineering of Biomedical Systems',
  'Engineering Biological and Biomedical Systems (EBBS)',
  'Catalyze: Product Definition for Small Molecules, Biologics and Combination Products - Target Identification and Validation, and Preliminary Product/Lead Series Identification (R61/R33 Clinical Trials Not Allowed)',
  'DoW Peer Reviewed Medical, Technology/Therapeutic Development Award',
  'DOD Defense Health Agency (DHA) Research & Development FY23-FY27 BROAD AGENCY ANNOUNCEMENT for Extramural Medical Research',
]

describe('profileWebsitePurpose — resolve + derive', () => {
  it('resolves axiombiolabs.org from basic_information.website', () => {
    const url = resolveProfileWebsiteUrl({ sections: AXIOM_SECTIONS })
    expect(url).toMatch(/axiombiolabs\.org/i)
  })

  it('derives research purpose terms from the known host + mission text', () => {
    const purpose = deriveWebsitePurpose({ sections: AXIOM_SECTIONS })
    expect(purpose.isResearchPurpose).toBe(true)
    expect(purpose.terms).toEqual(expect.arrayContaining([
      'car-t transplant',
      'immune tolerance',
      'biomedical research',
    ]))
  })

  it('feeds website purpose into deriveProfileFacts topical terms', () => {
    const facts = deriveProfileFacts({ display_name: 'Axiom BioLabs' }, AXIOM_SECTIONS)
    expect(facts.websitePurpose.isResearchPurpose).toBe(true)
    const terms = searchTermsFromFacts(facts)
    expect(terms.some((t) => /immune tolerance|car t transplant|biomedical research/i.test(t))).toBe(true)
    expect(facts.topicalTerms.some((t) => t.evidence === 'basic_information.website')).toBe(true)
    expect(facts.recallTerms.some((t) => t.evidence === 'basic_information.website')).toBe(false)
  })
})

describe('profileWebsitePurpose — Axiom Hamilton queue audit', () => {
  it('rejects the owner-pasted junk majority and keeps biotech-aligned titles', () => {
    const purpose = deriveWebsitePurpose({ sections: AXIOM_SECTIONS })
    const classified = classifyOpportunitiesAgainstWebsitePurpose(
      purpose,
      [...AXIOM_JUNK_TITLES, ...AXIOM_ALIGNED_TITLES],
    )
    expect(classified.rejected.length).toBe(AXIOM_JUNK_TITLES.length)
    expect(classified.matched.length).toBe(AXIOM_ALIGNED_TITLES.length)
  })

  it('websitePurposeConflict fires on Title X for Axiom and not on STTR', () => {
    const purpose = deriveWebsitePurpose({ sections: AXIOM_SECTIONS })
    expect(websitePurposeConflict({
      purpose,
      opportunity: { title: 'Title X Family Planning Services Grants' },
    })?.lock).toBe('title_x_family_planning')
    expect(websitePurposeConflict({
      purpose,
      opportunity: { title: 'NIH Small Business Technology Transfer Grant (Parent STTR)' },
    })).toBeNull()
    expect(opportunityHasResearchAlignedIdentity({
      title: 'NIH Small Business Technology Transfer Grant (Parent STTR)',
    })).toBe(true)
    expect(detectUnrelatedPurposeLock({
      title: 'FY 2026 CN Technology Innovation Grant for Child and Adult Care Food Program Integrity',
    })).toBe('cacfp_child_adult_food')
  })

  it('stageOfLifeConflictForSections REJECTs Title X via website purpose', () => {
    const conflict = stageOfLifeConflictForSections(AXIOM_SECTIONS, {
      title: 'Title X Family Planning Services Grants',
    })
    expect(conflict?.classId).toBe('website_purpose')
    expect(conflict?.reason).toMatch(/website purpose mismatch/i)
  })
})

describe('matchEngine — website purpose REJECT', () => {
  it('REJECTs Title X for an Axiom-shaped profile with website URL', async () => {
    const decision = await computeMatchDecision(
      {
        id: 'axiom-1',
        primary_type: 'small_business',
        display_name: 'Axiom BioLabs',
      },
      {
        id: 'opp-title-x',
        title: 'Title X Family Planning Services Grants',
        sponsor: 'HHS',
        source_url: 'https://example.org/title-x',
        application_url: 'https://example.org/title-x/apply',
        opportunity_kind: 'PROGRAM',
        is_national: true,
      },
      { profileSections: AXIOM_SECTIONS },
    )
    expect(decision.decision).toBe('REJECT')
    expect(String(decision.explanation || decision.reasons?.join(' ') || '')).toMatch(/website purpose mismatch/i)
  })

  it('does NOT refuse an STTR for the same profile', async () => {
    const decision = await computeMatchDecision(
      {
        id: 'axiom-1',
        primary_type: 'small_business',
        display_name: 'Axiom BioLabs',
      },
      {
        id: 'opp-sttr',
        title: 'NIH Small Business Technology Transfer Grant (Parent STTR [R41/R42] Clinical Trial Optional)',
        sponsor: 'NIH',
        source_url: 'https://example.org/sttr',
        application_url: 'https://example.org/sttr/apply',
        opportunity_kind: 'PROGRAM',
        is_national: true,
      },
      { profileSections: AXIOM_SECTIONS },
    )
    expect(decision.decision).not.toBe('REJECT')
  })
})

describe('website purpose enrichment', () => {
  it('reads and persists purpose for an ordinary, non-registry hostname', async () => {
    const writes = []
    const db = { prepare: () => ({ run: async (...args) => { writes.push(args); return { changes: 1 } } }) }
    const sections = { basic_information: { website: 'https://ordinary-biotech.example' } }
    const result = await enrichProfileWebsitePurpose(db, {
      profile: { id: 'ordinary-1' }, sections,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => ({ ok: true, headers: { get: (k) => k === 'content-type' ? 'text/html' : null }, text: async () => '<main>We conduct biomedical translational research and genomic diagnostics.</main>' }),
    })
    expect(result.status).toBe('fetched')
    expect(result.data.terms).toEqual(expect.arrayContaining(['biomedical research', 'genomic diagnostics']))
    expect(writes).toHaveLength(1)
    expect(deriveWebsitePurpose({ sections }).terms).toContain('biomedical research')
  })

  it.each([
    ['an IPv6 loopback literal', 'http://[::1]:8080/private', async () => [{ address: '::1', family: 6 }]],
    ['a public-looking name resolving privately', 'https://profile.example/private', async () => [{ address: '10.0.0.8', family: 4 }]],
  ])('rejects %s before the transport connects', async (_label, website, resolve) => {
    const fetchImpl = vi.fn()
    const result = await enrichProfileWebsitePurpose(
      { prepare: vi.fn() },
      { profile: { id: 'unsafe', website }, sections: {}, resolve, fetchImpl },
    )

    expect(result.status).toBe('unreadable')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses a linked organization website when the profile row has none', async () => {
    const writes = []
    const result = await enrichProfileWebsitePurpose(
      { prepare: () => ({ run: async (...args) => { writes.push(args); return { changes: 1 } } }) },
      {
        profile: { id: 'org-backed' },
        sections: {},
        organization: { website: 'https://org-purpose.example', mission: 'Biomedical research' },
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async () => ({
          ok: true,
          headers: { get: (key) => key === 'content-type' ? 'text/html' : null },
          text: async () => '<main>We conduct biomedical research.</main>',
        }),
      },
    )

    expect(result.status).toBe('fetched')
    expect(result.data.url).toBe('https://org-purpose.example/')
    expect(writes).toHaveLength(1)
  })

  it('keeps biomedical shared-use equipment on mission', () => {
    const purpose = deriveWebsitePurpose({ sections: AXIOM_SECTIONS })
    expect(websitePurposeConflict({ purpose, opportunity: { title: 'Modern Equipment for Shared-use Biomedical Research Facilities (S15)' } })).toBeNull()
  })
})
