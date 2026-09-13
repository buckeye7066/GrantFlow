import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

import { runLinkVerification } from '../services/linkVerificationService.js'

// The release gate (/readyz → missionHealthService) counts only the VISIBLE
// catalog. The recurring verifier has a bounded batch (300 rows / 3h in
// production). Measured 2026-09-12: under oldest-first ordering the batch was
// 282 hidden rows + 18 visible ones, so the visible stale pointers the gate
// measures were starved for ten days while hidden rows that count for nothing
// were refreshed. Visible rows must take the bounded slot first; hidden rows
// still drain afterwards (never starved forever).

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

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}

function insertRow(db, { id, url, kind = 'directory', hidden = 0, linkStatus = 'ok', lastVerifiedAt = null, verificationError = null }) {
  db.prepare(`
    INSERT INTO funding_opportunities (
      id, source_url, application_url, opportunity_kind, type, result_kind,
      link_status, is_hidden, is_active, last_verified_at, verification_error, discovered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    id,
    url,
    url,
    kind,
    kind === 'directory' ? 'DIRECTORY' : 'OPPORTUNITY',
    kind === 'directory' ? 'directory' : 'direct',
    linkStatus,
    hidden,
    lastVerifiedAt,
    verificationError,
    '2026-06-01T00:00:00.000Z',
  )
}

function lastVerified(db, id) {
  return db.prepare('SELECT last_verified_at, is_hidden FROM funding_opportunities WHERE id = ?').get(id)
}

describe('link verification — visible catalog takes the bounded slot first', () => {
  it('verifies a stale VISIBLE pointer before an OLDER hidden row when the batch is bounded', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200, url: 'https://8.8.8.8/x' })
    try {
      // Older evidence, but hidden: under oldest-first ordering this row won.
      insertRow(db, { id: 'hidden-older', url: 'https://8.8.8.8/hidden', kind: 'direct', hidden: 1, linkStatus: 'unverified', lastVerifiedAt: daysAgo(60), verificationError: 'stale_reverification_required:x' })
      // Visible pointer past the 30-day window — what /readyz actually measures.
      insertRow(db, { id: 'visible-stale-pointer', url: 'https://8.8.8.8/pointer', kind: 'directory', hidden: 0, linkStatus: 'ok', lastVerifiedAt: daysAgo(40) })

      const before = lastVerified(db, 'visible-stale-pointer').last_verified_at
      const stats = await runLinkVerification(db, { fetchImpl: globalThis.fetch, limit: 1, verifiedBy: 'test-visible-first' })

      expect(stats.checked).toBe(1)
      const visible = lastVerified(db, 'visible-stale-pointer')
      const hidden = lastVerified(db, 'hidden-older')
      expect(visible.last_verified_at).not.toBe(before)
      expect(Date.parse(visible.last_verified_at)).toBeGreaterThan(Date.now() - 60_000)
      expect(hidden.last_verified_at).toBe(daysAgo(60).slice(0, 10) + hidden.last_verified_at.slice(10)) // untouched (same day)
      expect(Date.parse(hidden.last_verified_at)).toBeLessThan(Date.now() - 59 * 24 * 60 * 60 * 1000)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('still drains hidden rows once the visible tier is fresh (no permanent starvation)', async () => {
    const db = makeDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200, url: 'https://8.8.8.8/x' })
    try {
      insertRow(db, { id: 'hidden-older', url: 'https://8.8.8.8/hidden', kind: 'direct', hidden: 1, linkStatus: 'unverified', lastVerifiedAt: daysAgo(60), verificationError: 'stale_reverification_required:x' })
      insertRow(db, { id: 'visible-stale-pointer', url: 'https://8.8.8.8/pointer', kind: 'directory', hidden: 0, linkStatus: 'ok', lastVerifiedAt: daysAgo(40) })
      insertRow(db, { id: 'visible-fresh-pointer', url: 'https://8.8.8.8/fresh', kind: 'directory', hidden: 0, linkStatus: 'ok', lastVerifiedAt: daysAgo(3) })

      await runLinkVerification(db, { fetchImpl: globalThis.fetch, limit: 1, verifiedBy: 'test-visible-first' })
      // Second bounded pass: the visible tier is now fresh, so the hidden row gets the slot.
      const stats = await runLinkVerification(db, { fetchImpl: globalThis.fetch, limit: 1, verifiedBy: 'test-visible-first' })
      expect(stats.checked).toBe(1)
      expect(Date.parse(lastVerified(db, 'hidden-older').last_verified_at)).toBeGreaterThan(Date.now() - 60_000)
      // The fresh visible row was never selected (still 3 days old).
      expect(Date.parse(lastVerified(db, 'visible-fresh-pointer').last_verified_at)).toBeLessThan(Date.now() - 2 * 24 * 60 * 60 * 1000)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
