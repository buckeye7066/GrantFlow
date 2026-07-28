import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  getPortalCheckStatus,
  mergePortalAwardIntoApplications,
} from '../services/portalCheckService.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('public portal checks can NEVER create a personal award (canonical G0)', () => {
  // Static tripwire (the funderFieldDrift pattern): the unauthenticated
  // landing-page checker used to promote award keywords / the LARGEST dollar
  // figure on a public page into updateType='scholarship_award' and merge it
  // into the student's financial-aid pipeline as 'merged'/'completed'
  // (2026-07-28 audit — fabricated funding presented as real). The award
  // write path must stay deleted: only an authenticated connector
  // (hamilton/portalSync) may create a personal award.
  const src = readFileSync(join(__dirname, '..', 'services', 'portalCheckService.js'), 'utf8')

  it('the public checker has no award-sync path', () => {
    expect(src).not.toMatch(/async function syncAwardToProfile/)
    expect(src).not.toMatch(/updateType = amount \? 'scholarship_award'/)
  })

  it('public detection is recorded as SIGNALS, never as an award', () => {
    expect(src).toMatch(/publicSignals = \{/)
    expect(src).toMatch(/has_award_language/)
    // The run summary reports a hard 0 — not a computed count of "detections".
    expect(src).toMatch(/awardsDetected: 0/)
  })
})

describe('mergePortalAwardIntoApplications', () => {
  it('stores merged portal awards and adds a completed pipeline item', () => {
    const applications = [
      {
        id: 'app-1',
        name: 'Tennessee Tech',
        financial_aid_pipeline: [],
      },
    ]

    const merged = mergePortalAwardIntoApplications(applications, {
      applicationId: 'app-1',
      portalName: 'TSAC Portal',
      portalUrl: 'https://example.edu/aid',
      awardName: 'TSAC Merit Scholarship',
      awardAmount: 2500,
      awardAmountRaw: '$2,500',
      detectedAt: '2026-06-16T12:00:00.000Z',
    }, { nowIso: '2026-06-16T13:00:00.000Z' })

    expect(merged.application.imported_portal_awards).toHaveLength(1)
    expect(merged.application.imported_portal_awards[0]).toMatchObject({
      portal_name: 'TSAC Portal',
      award_name: 'TSAC Merit Scholarship',
      award_amount: 2500,
      award_amount_raw: '$2,500',
      status: 'merged',
    })
    expect(merged.application.financial_aid_pipeline[0]).toMatchObject({
      label: 'Scholarship Award Detected: TSAC Merit Scholarship',
      status: 'completed',
      notes: 'Amount: $2,500 — Source: TSAC Portal — Merged from portal check',
    })
  })

  it('updates an existing merged award instead of duplicating it', () => {
    const once = mergePortalAwardIntoApplications([
      {
        id: 'app-1',
        name: 'Tennessee Tech',
        financial_aid_pipeline: [],
      },
    ], {
      applicationId: 'app-1',
      portalName: 'TSAC Portal',
      portalUrl: 'https://example.edu/aid',
      awardName: 'TSAC Merit Scholarship',
      awardAmountRaw: '$2,500',
      detectedAt: '2026-06-16T12:00:00.000Z',
    }, { nowIso: '2026-06-16T13:00:00.000Z' })

    const twice = mergePortalAwardIntoApplications(once.applications, {
      applicationId: 'app-1',
      portalName: 'TSAC Portal',
      portalUrl: 'https://example.edu/aid',
      awardName: 'TSAC Merit Scholarship',
      awardAmountRaw: '$2,500',
      detectedAt: '2026-06-16T12:30:00.000Z',
    }, { nowIso: '2026-06-16T14:00:00.000Z' })

    expect(twice.application.imported_portal_awards).toHaveLength(1)
    expect(twice.application.financial_aid_pipeline).toHaveLength(1)
    expect(twice.application.imported_portal_awards[0].merged_at).toBe('2026-06-16T14:00:00.000Z')
  })
})

describe('getPortalCheckStatus', () => {
  it('returns the latest portal result with merged profile metadata', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE profile_sections (
          profile_id TEXT NOT NULL,
          section_key TEXT NOT NULL,
          data TEXT NOT NULL,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_by TEXT,
          PRIMARY KEY (profile_id, section_key)
        );
        CREATE TABLE portal_check_results (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL,
          portal_name TEXT NOT NULL,
          portal_url TEXT,
          check_type TEXT,
          status TEXT,
          awards_detected INTEGER DEFAULT 0,
          results_json TEXT,
          checked_at TEXT NOT NULL
        );
      `)

      db.prepare(`
        INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
        VALUES (?, 'university_applications', ?, 'test')
      `).run(
        'profile-1',
        JSON.stringify({
          applications: [
            {
              id: 'app-1',
              name: 'Tennessee Tech',
              imported_portal_awards: [
                {
                  id: 'award-1',
                  portal_name: 'TSAC Portal',
                  portal_url: 'https://example.edu/aid',
                  award_name: 'TSAC Merit Scholarship',
                  award_amount_raw: '$2,500',
                  merged_at: '2026-06-16T14:00:00.000Z',
                },
              ],
            },
          ],
        }),
      )

      db.prepare(`
        INSERT INTO portal_check_results
          (id, profile_id, portal_name, portal_url, check_type, status, awards_detected, results_json, checked_at)
        VALUES (?, ?, ?, ?, 'manual', 'completed', 1, ?, ?)
      `).run(
        'result-old',
        'profile-1',
        'TSAC Portal',
        'https://example.edu/aid',
        JSON.stringify({
          portalName: 'TSAC Portal',
          portalUrl: 'https://example.edu/aid',
          awardName: 'TSAC Merit Scholarship',
          awardAmountRaw: '$1,000',
          applicationId: 'app-1',
        }),
        '2026-06-16T12:00:00.000Z',
      )

      db.prepare(`
        INSERT INTO portal_check_results
          (id, profile_id, portal_name, portal_url, check_type, status, awards_detected, results_json, checked_at)
        VALUES (?, ?, ?, ?, 'manual', 'completed', 1, ?, ?)
      `).run(
        'result-new',
        'profile-1',
        'TSAC Portal',
        'https://example.edu/aid',
        JSON.stringify({
          portalName: 'TSAC Portal',
          portalUrl: 'https://example.edu/aid',
          awardName: 'TSAC Merit Scholarship',
          awardAmountRaw: '$2,500',
          applicationId: 'app-1',
        }),
        '2026-06-16T15:00:00.000Z',
      )

      const results = await getPortalCheckStatus(db, 'profile-1')

      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        id: 'result-new',
        award_name: 'TSAC Merit Scholarship',
        award_amount_raw: '$2,500',
        merged_to_profile: true,
        merged_application_id: 'app-1',
        merged_application_name: 'Tennessee Tech',
      })
    } finally {
      db.close()
    }
  })
})
