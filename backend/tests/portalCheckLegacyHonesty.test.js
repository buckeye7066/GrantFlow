import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import ensurePortalCheckResultsTable, {
  repairLegacyPublicAwardClaims,
} from '../utils/ensurePortalCheckResultsTable.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT,
      PRIMARY KEY (profile_id, section_key)
    );
  `)
  return db
}

function insertPortalResult(db, {
  id,
  profileId = 'profile-1',
  portalName = 'Public scholarship landing page',
  portalUrl = 'https://example.test/scholarships',
  awardsDetected = 1,
  payload = {},
}) {
  db.prepare(`
    INSERT INTO portal_check_results
      (id, profile_id, portal_name, portal_url, status, awards_detected, results_json, checked_at)
    VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)
  `).run(
    id,
    profileId,
    portalName,
    portalUrl,
    awardsDetected,
    JSON.stringify({ portalName, portalUrl, ...payload }),
    '2026-07-28T00:00:00.000Z',
  )
}

function storeApplications(db, applications) {
  db.prepare(`
    INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
    VALUES (?, 'university_applications', ?, 'test')
  `).run('profile-1', JSON.stringify({ applications }))
}

function readResult(db, id) {
  const stored = db.prepare(
    'SELECT awards_detected, results_json FROM portal_check_results WHERE id = ?',
  ).get(id)
  return { ...stored, parsed: JSON.parse(stored.results_json) }
}

describe('legacy public portal-award honesty', () => {
  it('reclassifies an unauthenticated public-page claim as advertising evidence', async () => {
    const db = makeDb()
    try {
      await ensurePortalCheckResultsTable(db)
      insertPortalResult(db, {
        id: 'legacy-public',
        awardsDetected: 274,
        payload: {
          updateType: 'scholarship_award',
          awardName: 'Advertised scholarship',
          awardAmount: 5000,
          awardAmountRaw: '$5,000',
        },
      })

      expect(await repairLegacyPublicAwardClaims(db)).toBe(1)
      const { awards_detected: awardsDetected, parsed } = readResult(db, 'legacy-public')

      expect(awardsDetected).toBe(0)
      expect(parsed).toMatchObject({
        publicPortalHonestyVersion: 1,
        updateType: null,
        update_type: null,
        awardName: null,
        awardAmount: null,
        awardAmountRaw: null,
        publicSignals: {
          has_award_language: true,
          advertised_amount: 5000,
          advertised_amount_raw: '$5,000',
          legacy_reclassified: true,
        },
      })
    } finally {
      db.close()
    }
  })

  it('does not turn a missing advertised amount into a fabricated zero', async () => {
    const db = makeDb()
    try {
      await ensurePortalCheckResultsTable(db)
      insertPortalResult(db, {
        id: 'legacy-no-amount',
        awardsDetected: 3,
        payload: { updateType: 'scholarship_award', awardName: 'Marketing headline' },
      })

      expect(await repairLegacyPublicAwardClaims(db)).toBe(1)
      const { parsed } = readResult(db, 'legacy-no-amount')
      expect(parsed.publicSignals.advertised_amount).toBeNull()
      expect(parsed.awardAmount).toBeNull()
    } finally {
      db.close()
    }
  })

  it('preserves only independently owner-recorded award facts', async () => {
    const db = makeDb()
    try {
      await ensurePortalCheckResultsTable(db)
      storeApplications(db, [{
        id: 'app-1',
        imported_portal_awards: [{
          portal_name: 'TSAC Portal',
          portal_url: 'https://example.test/aid',
          award_name: 'Owner-confirmed merit scholarship',
          award_amount: 2500,
          award_amount_raw: '$2,500',
        }],
      }])
      insertPortalResult(db, {
        id: 'legacy-owner-confirmed',
        portalName: 'TSAC Portal',
        portalUrl: 'https://example.test/aid',
        awardsDetected: 99,
        payload: {
          applicationId: 'app-1',
          updateType: 'scholarship_award',
          awardName: 'Owner-confirmed merit scholarship',
          awardAmount: 2500,
          awardAmountRaw: '$2,500',
        },
      })

      expect(await repairLegacyPublicAwardClaims(db)).toBe(1)
      const { awards_detected: awardsDetected, parsed } = readResult(db, 'legacy-owner-confirmed')

      expect(awardsDetected).toBe(0)
      expect(parsed).toMatchObject({
        publicPortalHonestyVersion: 1,
        updateType: 'owner_merged_award',
        update_type: 'owner_merged_award',
        awardName: 'Owner-confirmed merit scholarship',
        awardAmount: 2500,
        awardAmountRaw: '$2,500',
      })
    } finally {
      db.close()
    }
  })

  it('never guesses between multiple owner awards on the same portal', async () => {
    const db = makeDb()
    try {
      await ensurePortalCheckResultsTable(db)
      storeApplications(db, [{
        id: 'app-1',
        imported_portal_awards: [
          { portal_name: 'TSAC Portal', portal_url: 'https://example.test/aid', award_name: 'Award A' },
          { portal_name: 'TSAC Portal', portal_url: 'https://example.test/aid', award_name: 'Award B' },
        ],
      }])
      insertPortalResult(db, {
        id: 'ambiguous-owner-awards',
        portalName: 'TSAC Portal',
        portalUrl: 'https://example.test/aid',
        awardsDetected: 2,
        payload: { applicationId: 'app-1', updateType: 'scholarship_award' },
      })

      expect(await repairLegacyPublicAwardClaims(db)).toBe(1)
      const { parsed } = readResult(db, 'ambiguous-owner-awards')
      expect(parsed.updateType).toBeNull()
      expect(parsed.awardName).toBeNull()
      expect(parsed.publicSignals.legacy_reclassified).toBe(true)
    } finally {
      db.close()
    }
  })

  it('does not match a same-named portal when both URLs conflict', async () => {
    const db = makeDb()
    try {
      await ensurePortalCheckResultsTable(db)
      storeApplications(db, [{
        id: 'app-1',
        imported_portal_awards: [{
          portal_name: 'Shared Portal Name',
          portal_url: 'https://owner.example/aid',
          award_name: 'Owner award',
        }],
      }])
      insertPortalResult(db, {
        id: 'conflicting-urls',
        portalName: 'Shared Portal Name',
        portalUrl: 'https://public.example/landing',
        awardsDetected: 1,
        payload: { applicationId: 'app-1', updateType: 'scholarship_award' },
      })

      expect(await repairLegacyPublicAwardClaims(db)).toBe(1)
      const { parsed } = readResult(db, 'conflicting-urls')
      expect(parsed.updateType).toBeNull()
      expect(parsed.awardName).toBeNull()
    } finally {
      db.close()
    }
  })

  it('is idempotent after rows receive the honesty marker', async () => {
    const db = makeDb()
    try {
      await ensurePortalCheckResultsTable(db)
      insertPortalResult(db, { id: 'once', payload: { publicSignals: { has_award_language: false } } })
      expect(await repairLegacyPublicAwardClaims(db)).toBe(1)
      expect(await repairLegacyPublicAwardClaims(db)).toBe(0)
    } finally {
      db.close()
    }
  })
})
