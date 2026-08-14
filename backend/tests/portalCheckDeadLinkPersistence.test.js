/**
 * runPortalCheck's publicSignals (which portal URLs it just found unreachable)
 * used to be computed and then DISCARDED by both consumers
 * (crawlerDispatcher.js's processPortalCheckJob, and
 * anyaAutonomousScheduler.js's nightly Phase 5 loop) — nothing ever wrote a
 * link_status from the signal, so a known-dead portal kept resurfacing.
 *
 * markDeadPortalLinks is the shared persistence function both consumers now
 * call. It matches an unreachable portal's URL against a funding_opportunities
 * row's stored URL columns and marks that row link_status='broken' using the
 * same write shape linkVerificationService.js's recurring verifier uses.
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { markDeadPortalLinks } from '../services/portalCheckService.js'

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      application_url TEXT,
      apply_url TEXT,
      apply_guidelines_url TEXT,
      source_url TEXT,
      evidence_url TEXT,
      final_url TEXT,
      opportunity_kind TEXT,
      result_kind TEXT,
      opportunity_type TEXT,
      type TEXT,
      last_verified_at TEXT,
      link_status TEXT,
      link_status_code INTEGER,
      verification_method TEXT,
      verified_by TEXT,
      verification_error TEXT,
      status TEXT DEFAULT 'active',
      deadline TEXT,
      deadline_type TEXT
    );
    CREATE TABLE verification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id TEXT,
      source TEXT,
      url TEXT,
      link_status TEXT,
      link_status_code INTEGER,
      verification_method TEXT,
      verified_by TEXT,
      verification_error TEXT,
      duration_ms INTEGER,
      ts TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

function insert(db, row) {
  db.prepare(`
    INSERT INTO funding_opportunities (
      id, title, sponsor, application_url, apply_url, apply_guidelines_url,
      source_url, evidence_url, final_url, opportunity_kind, result_kind,
      opportunity_type, type, last_verified_at, link_status, link_status_code,
      verification_method, verified_by, verification_error, status
    ) VALUES (
      @id, @title, @sponsor, @application_url, @apply_url, @apply_guidelines_url,
      @source_url, @evidence_url, @final_url, @opportunity_kind, @result_kind,
      @opportunity_type, @type, @last_verified_at, @link_status, @link_status_code,
      @verification_method, @verified_by, @verification_error, @status
    )
  `).run({
    title: 'Test scholarship', sponsor: 'Test U', application_url: null, apply_url: null,
    apply_guidelines_url: null, source_url: null, evidence_url: null, final_url: null,
    opportunity_kind: 'direct', result_kind: 'direct', opportunity_type: 'scholarship', type: 'OPPORTUNITY',
    last_verified_at: null, link_status: 'ok', link_status_code: 200,
    verification_method: 'head', verified_by: 'old-verifier', verification_error: null,
    status: 'active',
    ...row,
  })
}

describe('markDeadPortalLinks', () => {
  it('marks a funding_opportunities row broken when its URL matches an unreachable portal', async () => {
    const db = makeDb()
    insert(db, { id: 'opp-1', application_url: 'https://example.edu/aid/portal' })

    const stats = await markDeadPortalLinks(db, [
      { portalName: 'Example U — Financial Aid', portalUrl: 'https://example.edu/aid/portal/', status: 'unreachable', error: 'ECONNREFUSED' },
    ])

    expect(stats).toMatchObject({ candidates: 1, matched: 1, marked: 1 })
    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('opp-1')
    expect(row).toMatchObject({
      link_status: 'broken',
      verification_method: 'portal_check',
      verified_by: 'portal-check-service',
    })
    expect(row.verification_error).toMatch(/^portal_check_unreachable:/)
    expect(row.last_verified_at).toBeTruthy()

    const event = db.prepare('SELECT * FROM verification_events WHERE opportunity_id=?').get('opp-1')
    expect(event).toMatchObject({
      link_status: 'broken',
      verification_method: 'portal_check',
      source: 'portal_check',
    })
    db.close()
  })

  it('never touches a row when the portal is reachable', async () => {
    const db = makeDb()
    insert(db, { id: 'opp-live', application_url: 'https://example.edu/live-portal' })

    const stats = await markDeadPortalLinks(db, [
      { portalName: 'Live Portal', portalUrl: 'https://example.edu/live-portal', status: 'reachable', error: null },
    ])

    expect(stats).toMatchObject({ candidates: 0, matched: 0, marked: 0 })
    const row = db.prepare('SELECT link_status FROM funding_opportunities WHERE id=?').get('opp-live')
    expect(row.link_status).toBe('ok')
    db.close()
  })

  it('is a safe no-op when no catalog row shares the dead portal URL', async () => {
    const db = makeDb()
    insert(db, { id: 'opp-unrelated', application_url: 'https://other.example.org/unrelated' })

    const stats = await markDeadPortalLinks(db, [
      { portalName: 'Unknown Portal', portalUrl: 'https://nowhere.example.net/portal', status: 'unreachable', error: 'timeout' },
    ])

    expect(stats).toMatchObject({ candidates: 1, matched: 0, marked: 0 })
    const row = db.prepare('SELECT link_status FROM funding_opportunities WHERE id=?').get('opp-unrelated')
    expect(row.link_status).toBe('ok')
    db.close()
  })

  it('never re-marks a terminal/permanently-retired row (mutableLinkLifecycleSql gate)', async () => {
    const db = makeDb()
    insert(db, {
      id: 'opp-retired',
      application_url: 'https://example.edu/retired-portal',
      status: 'permanently_retired',
      link_status: 'broken',
    })

    const stats = await markDeadPortalLinks(db, [
      { portalName: 'Retired Portal', portalUrl: 'https://example.edu/retired-portal', status: 'unreachable', error: 'gone' },
    ])

    expect(stats).toMatchObject({ candidates: 1, matched: 1, marked: 0 })
    const event = db.prepare('SELECT * FROM verification_events WHERE opportunity_id=?').get('opp-retired')
    expect(event).toBeUndefined()
    db.close()
  })
})
