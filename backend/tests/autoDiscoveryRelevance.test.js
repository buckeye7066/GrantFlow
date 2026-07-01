/**
 * autoDiscoveryCrawlers relevance gating (legacy on-demand fleet selector).
 *
 * Pins the canonical relevance contract for the legacy triggerAutoDiscoveryCrawlers
 * selector:
 *   - foundation_990 is selected for a nonprofit/organization, NOT for a student.
 *   - scholarship + student_grants are selected for a student, but NOT fire-dept
 *     government_funding params (a student never gets military/fire-only discovery).
 *   - clinical_trials is selected ONLY when the profile opted in
 *     (health_medical.consent_for_studies) AND has medical conditions.
 *
 * CUTOVER: every discovery crawler type this selector chooses is now RETIRED
 * (superseded by the Crawler OS / Robert), so NONE of them are persisted as
 * crawler_jobs rows anymore. The relevance gating still runs, so the contract is
 * asserted via `summary.superseded_types` (the relevance-selected-but-not-enqueued
 * set) rather than via DB rows. This proves we never regress the selection logic
 * while guaranteeing zero legacy job-row noise.
 *
 * The dispatcher is mocked to a no-op so the test asserts purely on selection.
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

describe('autoDiscoveryCrawlers relevance gating (retired-selector contract)', () => {
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    db = loaded.db
  }, 60_000)

  beforeEach(() => {
    resetDb(db)
  })

  it('never persists any retired discovery job rows (cutover invariant)', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId, { primaryType: 'nonprofit', displayName: 'Helping Hands' })

    const summary = await triggerAutoDiscoveryCrawlers(db, profileId)

    // Zero legacy rows, regardless of relevance selection.
    const rowCount = db
      .prepare('SELECT COUNT(*) AS c FROM crawler_jobs WHERE profile_id = ?')
      .get(profileId)
    expect(Number(rowCount.c)).toBe(0)
    expect(summary.jobs_enqueued).toBe(0)
    expect(summary.job_ids).toEqual([])
  })

  it('nonprofit selects foundation_990 but NOT student/scholarship crawlers', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId, {
      primaryType: 'nonprofit',
      displayName: 'Helping Hands Foundation',
    })

    const summary = await triggerAutoDiscoveryCrawlers(db, profileId)
    const selected = summary.superseded_types

    expect(selected).toContain('foundation_990')
    expect(selected).not.toContain('scholarship')
    expect(selected).not.toContain('student_grants')
    expect(selected).not.toContain('clinical_trials')
  })

  it('student selects scholarship + student_grants but NOT foundation_990', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId, {
      primaryType: 'college_student',
      displayName: 'Jane Student',
    })

    const summary = await triggerAutoDiscoveryCrawlers(db, profileId)
    const selected = summary.superseded_types

    expect(selected).toContain('scholarship')
    expect(selected).toContain('student_grants')
    // A student is NOT an org → no private-foundation discovery.
    expect(selected).not.toContain('foundation_990')
    // No opt-in/conditions → no clinical trials.
    expect(selected).not.toContain('clinical_trials')
  })

  it('fire department selects government_funding but NOT student/foundation crawlers', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId, {
      primaryType: 'volunteer_fire_department',
      displayName: 'Smalltown Volunteer Fire Dept',
    })

    const summary = await triggerAutoDiscoveryCrawlers(db, profileId)
    const selected = summary.superseded_types

    expect(selected).not.toContain('scholarship')
    expect(selected).not.toContain('student_grants')
    expect(selected).toContain('government_funding')
  })

  it('clinical_trials selected ONLY when opted-in AND has medical conditions', async () => {
    const userId = seedUser(db)

    // Case A: opted in + has conditions → clinical_trials selected.
    const optedIn = seedProfile(db, userId, { primaryType: 'individual', displayName: 'Patient A' })
    seedSection(db, optedIn, 'health_medical', {
      consent_for_studies: true,
      conditions: ['type 2 diabetes'],
    })
    const summaryA = await triggerAutoDiscoveryCrawlers(db, optedIn)
    expect(summaryA.superseded_types).toContain('clinical_trials')

    resetDb(db)

    // Case B: has conditions but did NOT opt in → no clinical_trials.
    const userId2 = seedUser(db)
    const noConsent = seedProfile(db, userId2, { primaryType: 'individual', displayName: 'Patient B' })
    seedSection(db, noConsent, 'health_medical', {
      consent_for_studies: false,
      conditions: ['type 2 diabetes'],
    })
    const summaryB = await triggerAutoDiscoveryCrawlers(db, noConsent)
    expect(summaryB.superseded_types).not.toContain('clinical_trials')

    resetDb(db)

    // Case C: opted in but NO conditions → no clinical_trials.
    const userId3 = seedUser(db)
    const consentNoCondition = seedProfile(db, userId3, { primaryType: 'individual', displayName: 'Patient C' })
    seedSection(db, consentNoCondition, 'health_medical', {
      consent_for_studies: true,
    })
    const summaryC = await triggerAutoDiscoveryCrawlers(db, consentNoCondition)
    expect(summaryC.superseded_types).not.toContain('clinical_trials')
  })
})
