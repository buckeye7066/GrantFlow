/**
 * autoDiscoveryCrawlers relevance gating (on-demand "Find funding sources" fleet).
 *
 * Pins the canonical relevance contract for triggerAutoDiscoveryCrawlers — the
 * single selector reused by login, daily, AND the on-demand discover-all route:
 *   - foundation_990 fires for a nonprofit/organization, NOT for a student.
 *   - scholarship + student_grants fire for a student, but NOT fire-dept crawler
 *     params (a student never gets military/fire-only discovery).
 *   - clinical_trials fires ONLY when the profile opted in
 *     (health_medical.consent_for_studies) AND has medical conditions.
 *
 * The dispatcher is mocked to a no-op so the test asserts purely on which job
 * TYPES were enqueued (the honest summary the route returns), not on crawl
 * side-effects.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

// Mock the dispatcher BEFORE importing the module under test so the
// fire-and-forget dispatch is a no-op (relevance selection is the unit here).
vi.mock('../services/crawlerDispatcher.js', () => ({
  dispatchCrawlerJob: vi.fn(async () => ({ ok: true })),
}))

import { getAppAndDb, resetDb } from './testServer.js'
import { triggerAutoDiscoveryCrawlers } from '../services/autoDiscoveryCrawlers.js'

function seedUser(db) {
  const id = 'u-adr-' + Math.random().toString(36).slice(2, 10)
  db.prepare(`
    INSERT INTO users (id, primary_email, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, `${id}@test.local`)
  return id
}

function seedProfile(db, userId, { primaryType = 'individual', displayName = 'Test Profile' } = {}) {
  const id = 'p-adr-' + Math.random().toString(36).slice(2, 10)
  db.prepare(`
    INSERT INTO profiles (id, user_id, display_name, primary_type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, userId, displayName, primaryType)
  return id
}

function seedSection(db, profileId, sectionKey, data) {
  db.prepare(`
    INSERT INTO profile_sections (profile_id, section_key, data)
    VALUES (?, ?, ?)
  `).run(profileId, sectionKey, JSON.stringify(data))
}

describe('autoDiscoveryCrawlers relevance gating', () => {
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    db = loaded.db
  }, 60_000)

  beforeEach(() => {
    resetDb(db)
  })

  it('nonprofit gets foundation_990 but NOT student/scholarship crawlers', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId, {
      primaryType: 'nonprofit',
      displayName: 'Helping Hands Foundation',
    })

    const summary = await triggerAutoDiscoveryCrawlers(db, profileId)
    const types = summary.crawler_types

    expect(types).toContain('foundation_990')
    expect(types).not.toContain('scholarship')
    expect(types).not.toContain('student_grants')
    expect(types).not.toContain('clinical_trials')
    expect(summary.jobs_enqueued).toBeGreaterThan(0)
  })

  it('student gets scholarship + student_grants but NOT foundation_990, and no fire-dept-only params', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId, {
      primaryType: 'college_student',
      displayName: 'Jane Student',
    })

    const summary = await triggerAutoDiscoveryCrawlers(db, profileId)
    const types = summary.crawler_types

    expect(types).toContain('scholarship')
    expect(types).toContain('student_grants')
    // A student is NOT an org → no private-foundation discovery.
    expect(types).not.toContain('foundation_990')
    // No opt-in/conditions → no clinical trials.
    expect(types).not.toContain('clinical_trials')

    // The student must NOT have received the fire-department government_funding
    // job (which carries fire-only focus_areas). Inspect enqueued job params.
    const fireJobs = db
      .prepare(`SELECT parameters FROM crawler_jobs WHERE profile_id = ? AND type = 'government_funding'`)
      .all(profileId)
    for (const row of fireJobs) {
      const params = JSON.parse(row.parameters || '{}')
      const focus = Array.isArray(params.focus_areas) ? params.focus_areas : []
      expect(focus).not.toContain('fire_department')
      expect(focus).not.toContain('safer')
    }
  })

  it('fire department gets fire-focused government_funding but NOT student/foundation crawlers', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId, {
      primaryType: 'volunteer_fire_department',
      displayName: 'Smalltown Volunteer Fire Dept',
    })

    const summary = await triggerAutoDiscoveryCrawlers(db, profileId)
    const types = summary.crawler_types

    expect(types).not.toContain('scholarship')
    expect(types).not.toContain('student_grants')

    // At least one government_funding job carries fire-department focus.
    const fireJobs = db
      .prepare(`SELECT parameters FROM crawler_jobs WHERE profile_id = ? AND type = 'government_funding'`)
      .all(profileId)
    const hasFireFocus = fireJobs.some((row) => {
      const params = JSON.parse(row.parameters || '{}')
      return Array.isArray(params.focus_areas) && params.focus_areas.includes('fire_department')
    })
    expect(hasFireFocus).toBe(true)
  })

  it('clinical_trials fires ONLY when opted-in AND has medical conditions', async () => {
    const userId = seedUser(db)

    // Case A: opted in + has conditions → clinical_trials enqueued.
    const optedIn = seedProfile(db, userId, { primaryType: 'individual', displayName: 'Patient A' })
    seedSection(db, optedIn, 'health_medical', {
      consent_for_studies: true,
      conditions: ['type 2 diabetes'],
    })
    const summaryA = await triggerAutoDiscoveryCrawlers(db, optedIn)
    expect(summaryA.crawler_types).toContain('clinical_trials')

    resetDb(db)

    // Case B: has conditions but did NOT opt in → no clinical_trials.
    const userId2 = seedUser(db)
    const noConsent = seedProfile(db, userId2, { primaryType: 'individual', displayName: 'Patient B' })
    seedSection(db, noConsent, 'health_medical', {
      consent_for_studies: false,
      conditions: ['type 2 diabetes'],
    })
    const summaryB = await triggerAutoDiscoveryCrawlers(db, noConsent)
    expect(summaryB.crawler_types).not.toContain('clinical_trials')

    resetDb(db)

    // Case C: opted in but NO conditions → no clinical_trials.
    const userId3 = seedUser(db)
    const consentNoCondition = seedProfile(db, userId3, { primaryType: 'individual', displayName: 'Patient C' })
    seedSection(db, consentNoCondition, 'health_medical', {
      consent_for_studies: true,
    })
    const summaryC = await triggerAutoDiscoveryCrawlers(db, consentNoCondition)
    expect(summaryC.crawler_types).not.toContain('clinical_trials')
  })
})
