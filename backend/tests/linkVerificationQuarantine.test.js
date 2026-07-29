import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

import { runLinkVerification } from '../services/linkVerificationService.js'

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      application_url TEXT,
      source_url TEXT,
      type TEXT,
      opportunity_type TEXT,
      result_kind TEXT,
      opportunity_kind TEXT,
      last_verified_at TEXT,
      link_status TEXT,
      link_status_code INTEGER,
      verification_method TEXT,
      verified_by TEXT,
      verification_error TEXT,
      final_url TEXT,
      http_status INTEGER,
      is_hidden INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      discovered_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

function insertOpportunity(db, {
  id,
  url = null,
  kind = 'direct',
  status = 'unverified',
  hidden = 0,
  active = 1,
}) {
  db.prepare(`
    INSERT INTO funding_opportunities (
      id, application_url, opportunity_kind, type, result_kind,
      link_status, is_hidden, is_active, discovered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    url,
    kind,
    kind === 'directory' ? 'DIRECTORY' : 'OPPORTUNITY',
    kind === 'directory' ? 'directory' : 'direct',
    status,
    hidden,
    active,
    '2026-07-01T00:00:00.000Z',
  )
}

function readRow(db, id) {
  return db.prepare(`
    SELECT id, link_status, last_verified_at, is_hidden, is_active,
           link_status_code, verification_method
      FROM funding_opportunities
     WHERE id = ?
  `).get(id)
}

describe('link verification quarantine', () => {
  it('hides unproven direct rows, keeps resources visible, and restores a successful target', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      url: 'https://8.8.8.8/live',
    })

    try {
      insertOpportunity(db, { id: 'direct-live', url: 'https://8.8.8.8/live' })
      insertOpportunity(db, { id: 'direct-unchecked' })
      insertOpportunity(db, { id: 'directory-unchecked', kind: 'directory' })

      const stats = await runLinkVerification(db, {
        limit: 10,
        verifiedBy: 'test-quarantine',
      })

      expect(stats.quarantined).toBe(2)
      expect(stats.restored).toBe(1)
      expect(stats.ok).toBe(1)

      const live = readRow(db, 'direct-live')
      expect(live.link_status).toBe('ok')
      expect(live.link_status_code).toBe(200)
      expect(live.verification_method).toBe('head')
      expect(live.last_verified_at).toBeTruthy()
      expect(live.is_hidden).toBe(0)
      expect(live.is_active).toBe(1)

      const unproven = readRow(db, 'direct-unchecked')
      expect(unproven.link_status).toBe('unverified')
      expect(unproven.is_hidden).toBe(1)
      expect(unproven.is_active).toBe(1)

      const directory = readRow(db, 'directory-unchecked')
      expect(directory.link_status).toBe('unverified')
      expect(directory.is_hidden).toBe(0)
      expect(directory.is_active).toBe(1)
    } finally {
      fetchSpy.mockRestore()
      db.close()
    }
  })

  it('keeps a failed direct target quarantined and deactivates it', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 404,
      url: 'https://8.8.8.8/missing',
    })

    try {
      insertOpportunity(db, { id: 'direct-broken', url: 'https://8.8.8.8/missing' })

      const stats = await runLinkVerification(db, {
        limit: 10,
        verifiedBy: 'test-broken',
      })

      expect(stats.broken).toBe(1)
      expect(stats.deactivated).toBe(1)

      const broken = readRow(db, 'direct-broken')
      expect(broken.link_status).toBe('broken')
      expect(broken.link_status_code).toBe(404)
      expect(broken.is_hidden).toBe(1)
      expect(broken.is_active).toBe(0)
    } finally {
      fetchSpy.mockRestore()
      db.close()
    }
  })
})
