import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

import {
  quarantineUnverifiedDirectOpportunities,
  runLinkVerification,
  verifyOpportunityLinkNow,
} from '../services/linkVerificationService.js'

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
      status TEXT DEFAULT 'active',
      deadline TEXT,
      deadline_type TEXT,
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
           link_status_code, verification_method, verification_error,
           status, deadline, deadline_type
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
        fetchImpl: globalThis.fetch,
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
        fetchImpl: globalThis.fetch,
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

  it('never probes or rewrites a permanently retired row', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    try {
      insertOpportunity(db, {
        id: 'permanently-retired',
        url: 'https://8.8.8.8/retired',
        status: 'skipped',
        hidden: 1,
        active: 0,
      })
      db.prepare(`
        UPDATE funding_opportunities
           SET status='expired',
               verification_error='retired_after_definitive_recheck:permanent_http_gone:HTTP 410'
         WHERE id='permanently-retired'
      `).run()

      const result = await verifyOpportunityLinkNow(db, readRow(db, 'permanently-retired'))

      expect(result).toEqual({ status: 'skipped', code: null, updated: false })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(readRow(db, 'permanently-retired')).toMatchObject({
        status: 'expired',
        link_status: 'skipped',
        is_hidden: 1,
        is_active: 0,
      })
      expect(readRow(db, 'permanently-retired').verification_error).toMatch(/^retired_after_definitive_recheck:/)
    } finally {
      fetchSpy.mockRestore()
      db.close()
    }
  })

  it('does not let link success resurrect a deadline-expired direct row', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    try {
      insertOpportunity(db, {
        id: 'deadline-expired',
        url: 'https://8.8.8.8/old-award',
        status: 'broken',
        hidden: 1,
        active: 0,
      })
      db.prepare(`
        UPDATE funding_opportunities
           SET status='expired', deadline='2020-01-01', deadline_type='fixed'
         WHERE id='deadline-expired'
      `).run()

      const stats = await runLinkVerification(db, { limit: 10, verifiedBy: 'deadline-race-test', fetchImpl: globalThis.fetch })

      expect(stats.checked).toBe(0)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(readRow(db, 'deadline-expired')).toMatchObject({
        status: 'expired',
        link_status: 'broken',
        is_hidden: 1,
        is_active: 0,
      })
    } finally {
      fetchSpy.mockRestore()
      db.close()
    }
  })

  it('never probes or restores a row quarantined by an independent lifecycle decision', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    try {
      insertOpportunity(db, {
        id: 'independent-quarantine',
        url: 'https://8.8.8.8/quarantined',
        status: 'broken',
        hidden: 1,
        active: 0,
      })
      db.prepare(`
        UPDATE funding_opportunities
           SET status='quarantined'
         WHERE id='independent-quarantine'
      `).run()

      const result = await verifyOpportunityLinkNow(db, readRow(db, 'independent-quarantine'))

      expect(result).toEqual({ status: 'skipped', code: null, updated: false })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(readRow(db, 'independent-quarantine')).toMatchObject({
        status: 'quarantined',
        link_status: 'broken',
        is_hidden: 1,
        is_active: 0,
      })
    } finally {
      fetchSpy.mockRestore()
      db.close()
    }
  })
})


describe('startup SQL-only link quarantine', () => {
  it('quarantines every lifecycle kind plus NULL/blank legacy rows and excludes pointers', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const lifecycleRows = [
      ['legacy-direct', ' direct '],
      ['direct-grant', ' direct_grant '],
      ['program', 'Program'],
      ['scholarship', ' scholarship '],
      ['in-kind', 'IN_KIND'],
      ['benefit', ' benefit '],
      ['legacy-null', null],
      ['legacy-blank', '   '],
    ]

    try {
      for (const [id, kind] of lifecycleRows) {
        insertOpportunity(db, { id, kind, status: 'broken' })
      }
      insertOpportunity(db, { id: 'pointer-kind', kind: 'directory', status: 'broken' })
      insertOpportunity(db, { id: 'pointer-result', kind: null, status: 'broken' })
      insertOpportunity(db, { id: 'pointer-type', kind: 'DIRECT', status: 'broken' })
      insertOpportunity(db, { id: 'pointer-action', kind: 'DIRECT', status: 'broken' })
      insertOpportunity(db, { id: 'unknown-kind', kind: 'OTHER', status: 'broken' })
      db.prepare("UPDATE funding_opportunities SET result_kind=' referral ' WHERE id='pointer-result'").run()
      db.prepare("UPDATE funding_opportunities SET type='SCHOOL_PORTAL' WHERE id='pointer-type'").run()
      db.prepare("UPDATE funding_opportunities SET result_kind=' action_step ' WHERE id='pointer-action'").run()

      const stats = await quarantineUnverifiedDirectOpportunities(db)

      expect(stats).toMatchObject({ ok: true, quarantined: 9, deactivated: 9, restored: 0 })
      expect(fetchSpy).not.toHaveBeenCalled()
      for (const [id] of lifecycleRows) {
        expect(readRow(db, id)).toMatchObject({ is_hidden: 1, is_active: 0 })
      }
      for (const id of ['pointer-kind', 'pointer-result', 'pointer-type', 'pointer-action']) {
        expect(readRow(db, id)).toMatchObject({ is_hidden: 0, is_active: 1 })
      }
      expect(readRow(db, 'unknown-kind')).toMatchObject({ is_hidden: 1, is_active: 0 })
    } finally {
      fetchSpy.mockRestore()
      db.close()
    }
  })

  it('quarantines stale visible successes and restores them only after a current successful probe', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      url: 'https://8.8.8.8/stale',
    })

    try {
      insertOpportunity(db, { id: 'stale-visible', url: 'https://8.8.8.8/stale', status: 'ok' })
      insertOpportunity(db, { id: 'fresh-visible', url: 'https://8.8.8.8/fresh', status: 'ok' })
      insertOpportunity(db, {
        id: 'independently-hidden',
        url: 'https://8.8.8.8/hidden',
        status: 'ok',
        hidden: 1,
      })

      const staleAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
      const freshAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE funding_opportunities SET last_verified_at = ? WHERE id = ?')
        .run(staleAt, 'stale-visible')
      db.prepare('UPDATE funding_opportunities SET last_verified_at = ? WHERE id IN (?, ?)')
        .run(freshAt, 'fresh-visible', 'independently-hidden')

      const quarantine = await quarantineUnverifiedDirectOpportunities(db)

      expect(quarantine).toMatchObject({ ok: true, quarantined: 1, deactivated: 0 })
      expect(readRow(db, 'stale-visible')).toMatchObject({
        link_status: 'unverified',
        is_hidden: 1,
        is_active: 1,
      })
      expect(readRow(db, 'stale-visible').verification_error)
        .toMatch(/^stale_reverification_required:/)
      expect(readRow(db, 'fresh-visible')).toMatchObject({
        link_status: 'ok',
        is_hidden: 0,
        is_active: 1,
      })
      expect(readRow(db, 'independently-hidden')).toMatchObject({
        link_status: 'ok',
        is_hidden: 1,
        is_active: 1,
      })
      expect(fetchSpy).not.toHaveBeenCalled()

      const verified = await runLinkVerification(db, {
        fetchImpl: globalThis.fetch,
        limit: 10,
        verifiedBy: 'test-stale-reverification',
      })

      expect(verified).toMatchObject({ checked: 1, ok: 1, restored: 1 })
      expect(readRow(db, 'stale-visible')).toMatchObject({
        link_status: 'ok',
        link_status_code: 200,
        is_hidden: 0,
        is_active: 1,
        verification_error: null,
      })
      expect(readRow(db, 'fresh-visible')).toMatchObject({
        link_status: 'ok',
        is_hidden: 0,
      })
      expect(readRow(db, 'independently-hidden')).toMatchObject({
        link_status: 'ok',
        is_hidden: 1,
      })
    } finally {
      fetchSpy.mockRestore()
      db.close()
    }
  })

  it('fails closed without fetching, preserves resources, and restores proven rows', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    try {
      insertOpportunity(db, { id: 'unverified-direct', url: 'https://8.8.8.8/unverified' })
      insertOpportunity(db, { id: 'broken-direct', url: 'https://8.8.8.8/broken', status: 'broken' })
      insertOpportunity(db, { id: 'skipped-direct', url: 'https://8.8.8.8/skipped', status: 'skipped' })
      insertOpportunity(db, { id: 'directory-resource', kind: 'directory', status: 'unverified' })
      insertOpportunity(db, { id: 'proven-hidden', url: 'https://8.8.8.8/proven', status: 'ok', hidden: 1 })
      db.prepare('UPDATE funding_opportunities SET last_verified_at = ? WHERE id = ?')
        .run('2026-07-29T12:00:00.000Z', 'proven-hidden')

      const stats = await quarantineUnverifiedDirectOpportunities(db)

      expect(stats).toMatchObject({ ok: true, quarantined: 3, deactivated: 1, restored: 0 })
      expect(fetchSpy).not.toHaveBeenCalled()

      expect(readRow(db, 'unverified-direct')).toMatchObject({ is_hidden: 1, is_active: 1 })
      expect(readRow(db, 'broken-direct')).toMatchObject({ is_hidden: 1, is_active: 0 })
      expect(readRow(db, 'skipped-direct')).toMatchObject({ is_hidden: 1, is_active: 1 })
      expect(readRow(db, 'directory-resource')).toMatchObject({ is_hidden: 0, is_active: 1 })
      expect(readRow(db, 'proven-hidden')).toMatchObject({ is_hidden: 1, is_active: 1, link_status: 'ok' })
    } finally {
      fetchSpy.mockRestore()
      db.close()
    }
  })
})
