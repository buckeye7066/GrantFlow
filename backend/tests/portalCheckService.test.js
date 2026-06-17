import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import {
  getPortalCheckStatus,
  mergePortalAwardIntoApplications,
} from '../services/portalCheckService.js'

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
