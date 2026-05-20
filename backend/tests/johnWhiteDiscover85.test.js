/**
 * Dr. John White must return funding at 85% strict threshold on Discover.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getAppAndDb, resetDb } from './testServer.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { seedNationalPrograms } from '../services/seed/seedNationalPrograms.js'
import { runCrawler } from '../services/crawlers/crawlerManager.js'
import { canonicalizeOpportunityList } from '../services/matching/resultEnricher.js'
import { extractProfileData, applyRelevanceFilter } from '../services/relevanceFilter.js'
import { computeMatchDecision } from '../services/matchDecisionEngine.js'

const JOHN_WHITE = {
  id: 'profile-john-white-discover85',
  display_name: 'Dr. John White',
  primary_type: 'individual',
  status: 'active',
  tags: ['healthcare professional', 'educator', 'food security', 'community advocate'],
  sections: {
    basic_information: {
      full_name: 'John White',
      address: '3940 Eveningside Dr. NE\nCleveland, TN 37312',
      notes: 'Molecular geneticist, registered nurse, and educator.',
    },
    location_focus: {
      geographic_focus: 'Bradley County, Tennessee, with outreach to regional food security programs.',
    },
    narrative: {
      mission:
        'Mobilize scientific expertise, nursing practice, and faith-informed service to address food insecurity and health disparities.',
      primary_goal:
        'Secure multi-year funding to expand community health education, nutrition assistance, and youth mentorship programs.',
      target_population:
        'Underserved families in Bradley County needing access to healthy food, healthcare navigation, and STEM education pathways.',
    },
    demographics: {
      ethnicity: 'White/Caucasian',
      disability_status: 'Has disability',
    },
  },
}

function seedJohn(db) {
  db.prepare(`
    INSERT INTO profiles (id, display_name, primary_type, status, tags)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    JOHN_WHITE.id,
    JOHN_WHITE.display_name,
    JOHN_WHITE.primary_type,
    JOHN_WHITE.status,
    JSON.stringify(JOHN_WHITE.tags),
  )
  for (const [sectionKey, data] of Object.entries(JOHN_WHITE.sections)) {
    db.prepare(`
      INSERT INTO profile_sections (profile_id, section_key, data)
      VALUES (?, ?, ?)
    `).run(JOHN_WHITE.id, sectionKey, JSON.stringify(data))
  }
}

describe('Dr. John White Discover at 85%', () => {
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    db = loaded.db
  }, 120_000)

  beforeEach(async () => {
    resetDb(db)
    seedJohn(db)
    await seedNationalPrograms(db, { skipUrlVerification: true })
  })

  it('loads TN location signals from address', async () => {
    const ctx = await loadProfileContext(db, JOHN_WHITE.id)
    expect(ctx.signals?.location?.state).toBe('TN')
    expect(ctx.signals?.location?.zip).toBe('37312')
    expect(ctx.signals?.location?.city?.toLowerCase()).toContain('cleveland')
  })

  it('rejects irrelevant student scholarships and search portals', async () => {
    const ctx = await loadProfileContext(db, JOHN_WHITE.id)
    const irrelevant = [
      {
        title: 'Tennessee STEP UP Scholarship',
        description: 'Need-based supplement to the HOPE Scholarship for TN students with adjusted gross income of $36,000 or less.',
        state: 'TN',
        categories: ['scholarship', 'education', 'student_aid'],
        url: 'https://example.com/step-up',
      },
      {
        title: 'Society of Women Engineers (SWE) Scholarships',
        description: 'Scholarships for female students pursuing engineering, computer science, math, or related STEM fields.',
        categories: ['scholarship', 'education', 'women', 'stem'],
        is_national: true,
        url: 'https://swe.org',
      },
      {
        title: 'Fastweb — Housing & Living Expense Scholarship Search',
        description: 'Scholarship search for housing-eligible awards, room-and-board scholarships, and cost-of-attendance grants.',
        categories: ['scholarship', 'education', 'student_aid', 'housing'],
        type: 'portal',
        funding_type: 'referral',
        is_national: true,
        url: 'https://fastweb.com',
      },
    ]

    for (const opp of irrelevant) {
      const decision = computeMatchDecision(ctx.profile, opp, {
        profileSections: ctx.sections,
        signals: ctx.signals,
      })
      expect(decision.score).toBeLessThan(85)
      expect(decision.decision).not.toBe('ACCEPT')
    }
  })

  it('returns at least one opportunity at or above 85% after comprehensive crawl', async () => {
    const profileContext = await loadProfileContext(db, JOHN_WHITE.id)
    const profileData = extractProfileData(profileContext)

    const result = await runCrawler(db, JOHN_WHITE.id, {
      minScore: 20,
      maxResults: 100,
      crawlerType: 'comprehensive',
      profileContext,
    })

    const mapped = (result?.results ?? []).map((row) => ({
      ...row,
      title: row.title || row.name,
      url: row.url || row.applicationUrl || row.application_url || row.source_url,
      application_url: row.applicationUrl || row.application_url || row.url || null,
      state: row.state || row.stateRestriction || null,
      is_national: row.is_national ?? !row.stateRestriction,
      categories: row.categories || row.matchedCategories || [],
      funding_type: row.fundingType || row.funding_type || null,
      opportunity_type: row.type || row.opportunity_type || 'benefit',
    }))

    const canonicalized = canonicalizeOpportunityList(profileContext, mapped, {
      preserveDirectories: true,
      trustOptions: { allowDirectory: true, allowExpired: false },
    })

    const allMapped = canonicalized.kept
    const minMatchScore = 85

    const filtered = allMapped
      .filter((opp) => {
        const isDirectory =
          Boolean(opp.is_directory_resource) ||
          String(opp.source || '').startsWith('directory')
        if (typeof opp.match_score !== 'number' || opp.match_score < minMatchScore) return false
        const relevance = applyRelevanceFilter(opp, profileData)
        return relevance.pass || isDirectory
      })
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

    const top = allMapped
      .slice()
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      .slice(0, 8)
      .map((o) => ({
        title: o.title,
        score: o.match_score,
        decision: o.match_decision,
      }))

    expect(
      filtered.length,
      `expected >=1 at 85%; top scores: ${JSON.stringify(top)}; total=${allMapped.length}`,
    ).toBeGreaterThan(0)
  }, 120_000)
})
