/**
 * Website-purpose matching — Axiom BioLabs / research-lab regression.
 *
 * Owner 2026-08-20: Hamilton showed ~87 "Working on now" portal tasks for
 * Axiom BioLabs, almost none of which match a CAR-T / transplant biotech lab.
 * GrantFlow must read the profile website URL to know what the profile is.
 */

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

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
import { computeMatchDecision } from '../services/matchEngine.js'
import { enforceWebsitePurposeMatchScope } from '../startup/enforceInvariants.js'

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

  it('derives research purpose terms from the known host without mining mission prose', () => {
    const purpose = deriveWebsitePurpose({ sections: AXIOM_SECTIONS })
    expect(purpose.isResearchPurpose).toBe(true)
    expect(purpose.terms).toEqual(expect.arrayContaining([
      'car-t transplant',
      'immune tolerance',
      'biomedical research',
    ]))
  })

  it('keeps drafting-only mission prose out of discovery and hard matching', () => {
    const sections = {
      organization_details: {
        mission: 'Biomedical life sciences and environmental DNA testing',
      },
    }
    const purpose = deriveWebsitePurpose({ sections })
    expect(purpose.terms).toEqual([])
    expect(purpose.isResearchPurpose).toBe(false)
    expect(searchTermsFromFacts(deriveProfileFacts({}, sections))).toEqual([])
    expect(websitePurposeConflict({
      purpose,
      opportunity: { title: 'FY26 Coral Reef Conservation Grants' },
    })).toBeNull()
  })

  it('does not apply Axiom locks to an unrelated research website', () => {
    const purpose = deriveWebsitePurpose({
      sections: {
        basic_information: { website: 'https://edna-example.org' },
        organization_details: { website_excerpt: 'Environmental DNA testing laboratory' },
      },
    })
    expect(purpose.terms).toContain('environmental dna testing')
    expect(websitePurposeConflict({
      purpose,
      opportunity: { title: 'FY26 Coral Reef Conservation Grants' },
    })).toBeNull()
    expect(websitePurposeConflict({
      purpose,
      opportunity: { title: 'Great Lakes Fish and Wildlife Restoration Act' },
    })).toBeNull()
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
  it('REJECTs Title X through the engine when the website is on the profile row', async () => {
    const decision = await computeMatchDecision(
      {
        id: 'axiom-1',
        primary_type: 'small_business',
        display_name: 'Axiom BioLabs',
        website: 'https://axiombiolabs.org',
      },
      {
        id: 'opp-title-x',
        title: 'Title X Family Planning Services Grants',
        sponsor: 'HHS',
        opportunity_kind: 'PROGRAM',
        is_national: true,
        application_url: 'https://www.hhs.gov/grants/title-x-example',
      },
      {
        profileSections: {
          organization_details: { mission: AXIOM_SECTIONS.organization_details.mission },
        },
      },
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
        opportunity_kind: 'PROGRAM',
        is_national: true,
        application_url: 'https://www.nih.gov/grants/sttr-example',
      },
      { profileSections: AXIOM_SECTIONS },
    )
    expect(decision.decision).not.toBe('REJECT')
  })
})

describe('website-purpose persisted-state reconciliation', () => {
  it('removes a context-less stored xmatch and cancels its existing Hamilton task', async () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY, website TEXT, status TEXT, deleted_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE profile_sections (
        profile_id TEXT, section_key TEXT, data TEXT
      );
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, application_url TEXT
      );
      CREATE TABLE profile_opportunity_matches (
        id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT,
        match_decision TEXT, matcher_version TEXT
      );
      CREATE TABLE application_tasks (
        id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, status TEXT,
        updated_at TEXT
      );
    `)
    db.prepare('INSERT INTO profiles (id, website, status) VALUES (?, ?, ?)')
      .run('axiom', 'https://axiombiolabs.org', 'active')
    db.prepare('INSERT INTO funding_opportunities VALUES (?, ?, ?, ?)')
      .run('title-x', 'Title X Family Planning Services Grants', 'HHS', 'https://hhs.gov/title-x')
    db.prepare('INSERT INTO profile_opportunity_matches VALUES (?, ?, ?, ?, ?)')
      .run('stale-xmatch', 'axiom', 'title-x', 'accept', 'crawler-os-xmatch')
    db.prepare('INSERT INTO application_tasks VALUES (?, ?, ?, ?, NULL)')
      .run('working-task', 'axiom', 'title-x', 'running')

    const result = await enforceWebsitePurposeMatchScope(db)

    expect(result).toMatchObject({ ok: true, repaired: 1, tasksCancelled: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_opportunity_matches').get().n).toBe(0)
    expect(db.prepare('SELECT status FROM application_tasks WHERE id = ?').get('working-task').status)
      .toBe('cancelled')
    expect((await enforceWebsitePurposeMatchScope(db)).repaired).toBe(0)
  })

  it('keeps an aligned stored match and task', async () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, website TEXT, status TEXT, deleted_at TEXT, created_at TEXT);
      CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
      CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, sponsor TEXT);
      CREATE TABLE profile_opportunity_matches (id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT);
      CREATE TABLE application_tasks (id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, status TEXT, updated_at TEXT);
      INSERT INTO profiles VALUES ('axiom', 'https://axiombiolabs.org', 'active', NULL, '2026-01-01');
      INSERT INTO funding_opportunities VALUES ('sttr', 'NIH Small Business Technology Transfer Grant (Parent STTR)', 'NIH');
      INSERT INTO profile_opportunity_matches VALUES ('good-match', 'axiom', 'sttr');
      INSERT INTO application_tasks VALUES ('good-task', 'axiom', 'sttr', 'running', NULL);
    `)

    const result = await enforceWebsitePurposeMatchScope(db)
    expect(result).toMatchObject({ repaired: 0, tasksCancelled: 0 })
    expect(db.prepare('SELECT status FROM application_tasks').get().status).toBe('running')
  })
})
