/**
 * Website-purpose matching — Axiom BioLabs / research-lab regression.
 *
 * Owner 2026-08-20: Hamilton showed ~87 "Working on now" portal tasks for
 * Axiom BioLabs, almost none of which match a CAR-T / transplant biotech lab.
 * GrantFlow must read the profile website URL to know what the profile is.
 */

import { describe, expect, it } from 'vitest'

import {
  classifyOpportunitiesAgainstWebsitePurpose,
  deriveWebsitePurpose,
  detectUnrelatedPurposeLock,
  opportunityHasResearchAlignedIdentity,
  resolveProfileWebsiteUrl,
  websitePurposeConflict,
} from '../config/profileWebsitePurpose.js'
import { deriveProfileFacts, searchTermsFromFacts } from '../config/profileDerivedFacts.js'
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
    // Of the full 87-item Hamilton list the owner pasted, only a small
    // biotech/SBIR-aligned minority survives this gate (~7). The rest are
    // unrelated purpose locks or neutral stretch BAAs — not "matches".
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
})

// computeMatchDecision is POSITIONAL — (profile, opportunity, { profileSections }).
// Both cases below used to pass a single `{ profile, sections, opportunity }`
// object, so `rawOpportunity` was undefined and the engine returned its
// "missing profile or opportunity" REVIEW stub before reaching ANY gate. That
// made the REJECT case fail for a reason unrelated to website purpose, and made
// the STTR case a test that could not fail (the stub is REVIEW, which satisfies
// `not.toBe('REJECT')` no matter how badly the gate over-fires).
// The rows also need a real URL, or the data-quality "no actionable URL" gate
// rejects both before the website-purpose gate is ever consulted.
const AXIOM_PROFILE = {
  id: 'axiom-1',
  primary_type: 'small_business',
  display_name: 'Axiom BioLabs',
}

describe('matchEngine — website purpose REJECT', () => {
  it('REJECTs Title X for an Axiom-shaped profile with website URL', async () => {
    const decision = await computeMatchDecision(AXIOM_PROFILE, {
      id: 'opp-title-x',
      title: 'Title X Family Planning Services Grants',
      sponsor: 'HHS',
      opportunity_kind: 'PROGRAM',
      is_national: true,
      url: 'https://www.grants.gov/opp/title-x',
      application_url: 'https://www.grants.gov/opp/title-x',
    }, { profileSections: AXIOM_SECTIONS })
    expect(decision.decision).toBe('REJECT')
    expect(String(decision.explanation || decision.reasons?.join(' ') || '')).toMatch(/website purpose mismatch/i)
  })

  it('does NOT refuse an STTR for the same profile', async () => {
    const decision = await computeMatchDecision(AXIOM_PROFILE, {
      id: 'opp-sttr',
      title: 'NIH Small Business Technology Transfer Grant (Parent STTR [R41/R42] Clinical Trial Optional)',
      sponsor: 'NIH',
      opportunity_kind: 'PROGRAM',
      is_national: true,
      url: 'https://www.grants.gov/opp/sttr',
      application_url: 'https://www.grants.gov/opp/sttr',
    }, { profileSections: AXIOM_SECTIONS })
    expect(decision.decision).not.toBe('REJECT')
    // Pin the positive side too, so this case can actually fail: the engine
    // must not have short-circuited into its "insufficient data" stub.
    expect(decision.decision).toBe('ACCEPT')
  })
})
