/**
 * Issue #1501, defect 4: a direct row whose opportunity_kind spelling the
 * finite registry has never seen must not be stranded. It is inside the
 * non-pointer denominator for quarantine, verification, AND repair, so a
 * successful probe restores it exactly like a known kind.
 */
import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

import { linkLifecycleOpportunitySql } from '../config/linkLifecycleKinds.js'
import { runLinkVerification } from '../services/linkVerificationService.js'
import { repairBrokenDirectBatch } from '../services/linkBacklogRepairService.js'

// Column set mirrors linkBacklogSafetyRegression's fixture (the repair
// service selects source_id / apply_* / contact_info / trust tier).
function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      application_url TEXT,
      apply_url TEXT,
      apply_guidelines_url TEXT,
      source_url TEXT,
      evidence_url TEXT,
      final_url TEXT,
      contact_info TEXT,
      type TEXT,
      opportunity_type TEXT,
      result_kind TEXT,
      opportunity_kind TEXT,
      record_origin TEXT,
      source_trust_tier TEXT,
      last_verified_at TEXT,
      link_status TEXT,
      link_status_code INTEGER,
      verification_method TEXT,
      verified_by TEXT,
      verification_error TEXT,
      http_status INTEGER,
      is_hidden INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      deadline TEXT,
      deadline_type TEXT,
      discovered_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
      id, title, source, source_id, application_url, opportunity_kind, result_kind, type, opportunity_type,
      record_origin, link_status, last_verified_at, is_hidden, is_active, status, discovered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, `Row ${row.id}`, 'unit', row.id, row.application_url, row.opportunity_kind, row.result_kind ?? null,
    'OPPORTUNITY', row.opportunity_type ?? 'grant', 'live_crawl',
    row.link_status, row.last_verified_at ?? null, row.is_hidden, row.is_active, row.status ?? 'active',
    '2026-07-01T00:00:00.000Z',
  )
}

const read = (db, id) => db.prepare(
  'SELECT link_status, is_hidden, is_active, status, last_verified_at FROM funding_opportunities WHERE id = ?',
).get(id)

describe('unknown/future direct kinds recover through the shared non-pointer denominator', () => {
  it('counts an unknown kind as direct while a structural pointer stays outside', () => {
    const db = makeDb()
    insert(db, { id: 'future', application_url: 'https://8.8.8.8/f', opportunity_kind: 'FUTURE_DIRECT_SPELLING', link_status: 'unverified', is_hidden: 1, is_active: 1 })
    insert(db, { id: 'pointer', application_url: 'https://8.8.8.8/p', opportunity_kind: null, result_kind: 'directory', link_status: 'unverified', is_hidden: 0, is_active: 1 })
    const safeDenominator = linkLifecycleOpportunitySql()
    const ids = db.prepare(`SELECT id FROM funding_opportunities WHERE ${safeDenominator} ORDER BY id`).all().map((r) => r.id)
    expect(ids).toEqual(['future'])
    db.close()
  })

  it('the recurring verifier restores a writer-hidden unknown-kind row after a successful probe', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 200 }))
    try {
      // Exactly how the write guard leaves an unproven direct row: hidden, active, unverified.
      insert(db, { id: 'future-unverified', application_url: 'https://8.8.8.8/future', opportunity_kind: 'FUTURE_DIRECT_SPELLING', link_status: 'unverified', is_hidden: 1, is_active: 1 })
      // A stale success of an unknown kind is re-quarantined, selected, and re-proved in the same run.
      insert(db, { id: 'future-stale', application_url: 'https://8.8.8.8/stale', opportunity_kind: 'another_new_kind', link_status: 'ok', last_verified_at: new Date(Date.now() - 40 * 86400000).toISOString(), is_hidden: 0, is_active: 1 })

      const stats = await runLinkVerification(db, { fetchImpl: globalThis.fetch, limit: 10, verifiedBy: 'unknown-kind-recovery' })

      expect(stats.checked).toBe(2)
      expect(stats.ok).toBe(2)
      expect(read(db, 'future-unverified')).toMatchObject({ link_status: 'ok', is_hidden: 0, is_active: 1, status: 'active' })
      expect(read(db, 'future-stale')).toMatchObject({ link_status: 'ok', is_hidden: 0, is_active: 1 })
      expect(Date.parse(read(db, 'future-stale').last_verified_at)).toBeGreaterThan(Date.now() - 60_000)
    } finally {
      fetchSpy.mockRestore()
      db.close()
    }
  })

  it('a broken unknown-kind row deactivated by quarantine is still repairable', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 200 }))
    try {
      // The quarantine pass deactivates broken direct rows; the verifier selects
      // only active rows, so recovery of this shape is the repair service's job.
      insert(db, { id: 'future-broken', application_url: 'https://8.8.8.8/broken', opportunity_kind: 'FUTURE_DIRECT_SPELLING', link_status: 'broken', is_hidden: 1, is_active: 0, status: 'paused' })

      const result = await repairBrokenDirectBatch(db, {
        fetchImpl: globalThis.fetch,
        limit: 5,
        concurrency: 1,
        timeoutMs: 3000,
        findOfficialUrlImpl: async () => ({ url: null, searched: false }),
      })

      expect(result).toMatchObject({ selected: 1, restored: 1 })
      expect(read(db, 'future-broken')).toMatchObject({ link_status: 'ok', is_hidden: 0, is_active: 1, status: 'active' })
    } finally {
      fetchSpy.mockRestore()
      db.close()
    }
  })
})
