import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  brokenDirectSummary,
  candidateUrlEntries,
  estimateRepairLockTtlMs,
  repairBrokenDirectBatch,
  scheduleRetryableBrokenRows,
} from '../services/linkBacklogRepairService.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

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
      status TEXT DEFAULT 'active'
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
      id,title,sponsor,source,source_id,application_url,apply_url,apply_guidelines_url,
      source_url,evidence_url,final_url,contact_info,type,opportunity_type,result_kind,
      opportunity_kind,record_origin,source_trust_tier,last_verified_at,link_status,
      link_status_code,verification_method,verified_by,verification_error,http_status,
      is_hidden,is_active,status
    ) VALUES (
      @id,@title,@sponsor,@source,@source_id,@application_url,@apply_url,@apply_guidelines_url,
      @source_url,@evidence_url,@final_url,@contact_info,@type,@opportunity_type,@result_kind,
      @opportunity_kind,@record_origin,@source_trust_tier,@last_verified_at,@link_status,
      @link_status_code,@verification_method,@verified_by,@verification_error,@http_status,
      @is_hidden,@is_active,@status
    )
  `).run({
    title: 'Test program', sponsor: 'Test sponsor', source: 'verified_real', source_id: null,
    application_url: null, apply_url: null, apply_guidelines_url: null,
    source_url: null, evidence_url: null, final_url: null, contact_info: null,
    type: 'OPPORTUNITY', opportunity_type: 'grant', result_kind: 'direct',
    opportunity_kind: 'direct', record_origin: 'verified_real', source_trust_tier: 'official_portal',
    last_verified_at: null, link_status: 'broken', link_status_code: 404,
    verification_method: 'head', verified_by: 'old-verifier', verification_error: 'HTTP 404',
    http_status: 404, is_hidden: 0, is_active: 1, status: 'active',
    ...row,
  })
}

afterEach(() => vi.restoreAllMocks())

describe('link backlog safety regression', () => {
  it('probes every canonical stored opportunity URL field before retirement', () => {
    const entries = candidateUrlEntries({
      application_url: 'https://8.8.8.8/application',
      apply_url: 'https://8.8.8.8/apply',
      apply_guidelines_url: 'https://8.8.8.8/guidelines',
      final_url: 'https://8.8.8.8/final',
      source_url: 'https://8.8.8.8/source',
      evidence_url: 'https://8.8.8.8/evidence',
    })
    expect(entries.map((entry) => entry.role)).toEqual([
      'application_url', 'apply_url', 'apply_guidelines_url',
      'final_url', 'source_url', 'evidence_url',
    ])
  })

  it('official-only rescue clears unprobeable URL fields', async () => {
    const db = makeDb()
    insert(db, {
      id: 'official-only-rescue',
      application_url: 'mailto:old@example.org',
      apply_url: '/relative-apply',
      apply_guidelines_url: 'not a URL',
      evidence_url: 'javascript:void(0)',
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HTTP probe should not run'))
    const officialUrl = 'https://official.example.org/current-program'

    const result = await repairBrokenDirectBatch(db, {
      limit: 1,
      concurrency: 1,
      timeoutMs: 3000,
      findOfficialUrlImpl: async () => ({
        url: officialUrl,
        searched: true,
        hits: 1,
        probe: { status: 'ok', code: 200, method: 'get', finalUrl: officialUrl },
      }),
    })
    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('official-only-rescue')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result).toMatchObject({ restored: 1, retired: 0, pending: 0 })
    expect(row).toMatchObject({
      application_url: null,
      apply_url: null,
      apply_guidelines_url: null,
      evidence_url: null,
      source_url: officialUrl,
      final_url: officialUrl,
      link_status: 'ok',
      status: 'active',
      is_hidden: 0,
      is_active: 1,
    })
    db.close()
  })

  it('sizes the shared lock lease for the bounded worst case', () => {
    const minimum = 30 * 60 * 1000
    const maximum = 12 * 60 * 60 * 1000
    expect(estimateRepairLockTtlMs()).toBeGreaterThanOrEqual(minimum)
    const worstCase = estimateRepairLockTtlMs({ limit: 100, concurrency: 1, timeoutMs: 20_000 })
    expect(worstCase).toBeGreaterThan(minimum)
    expect(worstCase).toBeLessThanOrEqual(maximum)
  })

  it('quarantines all broken rows but marks only selected rows pending', async () => {
    const db = makeDb()
    insert(db, { id: 'a-selected', application_url: 'https://8.8.8.8/blocked' })
    insert(db, { id: 'b-unselected', application_url: 'https://8.8.4.4/later' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 403, url: 'https://8.8.8.8/blocked' })

    const result = await repairBrokenDirectBatch(db, {
      limit: 1, concurrency: 1, timeoutMs: 3000, cycleId: 'selected-only',
      findOfficialUrlImpl: async () => ({ url: null, searched: false, error: 'provider unavailable' }),
    })

    expect(result).toMatchObject({ selected: 1, claimed: 1, pending: 1 })
    expect(db.prepare('SELECT status,is_hidden,is_active FROM funding_opportunities WHERE id=?').get('a-selected'))
      .toMatchObject({ status: 'paused', is_hidden: 1, is_active: 0 })
    expect(db.prepare('SELECT status,is_hidden,is_active FROM funding_opportunities WHERE id=?').get('b-unselected'))
      .toMatchObject({ status: 'active', is_hidden: 1, is_active: 0 })
    expect(await brokenDirectSummary(db)).toMatchObject({ quarantined: 1, repair_pending: 1 })
    db.close()
  })

  it('does not let a cycle marker skip the next active row or loop a fresh pending row', async () => {
    const db = makeDb()
    insert(db, { id: 'a-retry', application_url: 'https://8.8.8.8/retry' })
    insert(db, { id: 'b-live', application_url: 'https://8.8.4.4/live' })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const text = String(url)
      return text.includes('/live') ? { status: 200, url: text } : { status: 403, url: text }
    })
    const rescue = async () => ({ url: null, searched: false, error: 'provider unavailable' })

    const first = await repairBrokenDirectBatch(db, {
      limit: 1, concurrency: 1, timeoutMs: 3000, cycleId: 'same-cycle', findOfficialUrlImpl: rescue,
    })
    const second = await repairBrokenDirectBatch(db, {
      limit: 1, concurrency: 1, timeoutMs: 3000, cycleId: 'same-cycle', findOfficialUrlImpl: rescue,
    })
    const third = await repairBrokenDirectBatch(db, {
      limit: 1, concurrency: 1, timeoutMs: 3000, cycleId: 'same-cycle', findOfficialUrlImpl: rescue,
    })

    expect(first).toMatchObject({ selected: 1, pending: 1 })
    expect(second).toMatchObject({ selected: 1, restored: 1 })
    expect(third).toMatchObject({ selected: 0, checked: 0 })
    expect(db.prepare('SELECT status,link_status,is_hidden,is_active FROM funding_opportunities WHERE id=?').get('b-live'))
      .toMatchObject({ status: 'active', link_status: 'ok', is_hidden: 0, is_active: 1 })
    db.close()
  })

  it('isolates a provider exception to one row and completes the rest of the batch', async () => {
    const db = makeDb()
    insert(db, { id: 'a-bad', title: 'Bad rescue', application_url: 'https://8.8.8.8/gone' })
    insert(db, { id: 'b-good', title: 'Good live', application_url: 'https://8.8.4.4/live' })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const text = String(url)
      return text.includes('/live') ? { status: 200, url: text } : { status: 404, url: text }
    })

    const result = await repairBrokenDirectBatch(db, {
      limit: 2, concurrency: 2, timeoutMs: 3000,
      findOfficialUrlImpl: async ({ title }) => {
        if (title === 'Bad rescue') throw new Error('search provider exploded')
        return { url: null, searched: true, hits: 0 }
      },
    })

    expect(result.ok).toBe(true)
    expect(result).toMatchObject({ selected: 2, claimed: 2, restored: 1, pending: 1, row_errors: 1 })
    expect(db.prepare('SELECT status,link_status FROM funding_opportunities WHERE id=?').get('a-bad'))
      .toMatchObject({ status: 'paused', link_status: 'broken' })
    expect(db.prepare('SELECT status,link_status FROM funding_opportunities WHERE id=?').get('b-good'))
      .toMatchObject({ status: 'active', link_status: 'ok' })
    db.close()
  })

  it('clears definitively dead higher-priority URLs when evidence_url rescues the row', async () => {
    const db = makeDb()
    const liveEvidence = 'https://8.8.4.4/evidence-live'
    insert(db, {
      id: 'evidence-rescue',
      application_url: 'https://8.8.8.8/application-dead',
      apply_url: 'https://8.8.8.8/apply-dead',
      apply_guidelines_url: 'https://8.8.8.8/guidelines-dead',
      final_url: 'https://8.8.8.8/final-dead',
      source_url: 'https://8.8.8.8/source-dead',
      evidence_url: liveEvidence,
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const text = String(url)
      return text === liveEvidence ? { status: 200, url: text } : { status: 404, url: text }
    })

    const result = await repairBrokenDirectBatch(db, {
      limit: 1, concurrency: 1, timeoutMs: 3000,
      findOfficialUrlImpl: async () => ({ url: null, searched: true, hits: 0 }),
    })
    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('evidence-rescue')

    expect(result).toMatchObject({ restored: 1, retired: 0, pending: 0 })
    expect(row).toMatchObject({
      application_url: null,
      apply_url: null,
      apply_guidelines_url: null,
      source_url: null,
      evidence_url: liveEvidence,
      final_url: liveEvidence,
      link_status: 'ok',
      status: 'active',
      is_hidden: 0,
      is_active: 1,
    })
    db.close()
  })

  it('counts only rows carrying the definitive repair-retirement marker', async () => {
    const db = makeDb()
    insert(db, {
      id: 'repair-retired',
      link_status: 'skipped',
      status: 'expired',
      verification_error: 'retired_after_definitive_recheck:permanent_http_gone:HTTP 404',
      is_hidden: 1,
      is_active: 0,
    })
    insert(db, {
      id: 'ordinary-expired',
      link_status: 'skipped',
      status: 'expired',
      verification_error: 'expired_after_deadline',
      is_hidden: 1,
      is_active: 0,
    })

    expect(await brokenDirectSummary(db)).toMatchObject({ retired: 1 })
    db.close()
  })

  it('schedules exhausted transient rows without retiring them', async () => {
    const db = makeDb()
    insert(db, {
      id: 'bounded-transient',
      application_url: 'https://8.8.8.8/blocked',
      link_status: 'broken',
      status: 'paused',
      is_hidden: 1,
      is_active: 0,
      verification_error: 'retryable_after_recheck:access_or_bot_block:HTTP 403',
    })
    const addEvent = db.prepare(`
      INSERT INTO verification_events (
        opportunity_id, source, url, link_status, verification_method,
        verified_by, verification_error, duration_ms
      ) VALUES (?, 'verified_real', ?, 'broken', 'get', ?, 'HTTP 403', 10)
    `)
    addEvent.run('bounded-transient', 'https://8.8.8.8/blocked', 'admin-link-repair:proof-cycle-r1')
    addEvent.run('bounded-transient', 'https://8.8.8.8/blocked', 'admin-link-repair:proof-cycle-r2')

    const result = await scheduleRetryableBrokenRows(db, {
      cyclePrefix: 'proof-cycle-r',
      minAttempts: 2,
      retryAfterDays: 30,
    })
    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('bounded-transient')

    expect(result).toMatchObject({ selected: 1, scheduled: 1, min_attempts: 2, retry_after_days: 30 })
    expect(row).toMatchObject({
      link_status: 'skipped',
      status: 'paused',
      verification_method: 'scheduled_retry',
      is_hidden: 1,
      is_active: 0,
    })
    expect(row.verification_error).toMatch(/^retry_scheduled_after_bounded_recheck:/)
    expect(await brokenDirectSummary(db)).toMatchObject({
      visible: 0,
      quarantined: 0,
      repair_pending: 0,
      retired: 0,
      scheduled_retry: 1,
    })
    const latest = db.prepare('SELECT * FROM verification_events ORDER BY id DESC LIMIT 1').get()
    expect(latest).toMatchObject({ link_status: 'skipped', verification_method: 'scheduled_retry' })
    db.close()
  })

  it('pins scheduled retry to portable ordering and the verifier window', () => {
    const service = fs.readFileSync(path.resolve(HERE, '../services/linkBacklogRepairService.js'), 'utf8')
    const route = fs.readFileSync(path.resolve(HERE, '../routes/linkBacklogRepair.js'), 'utf8')
    expect(service).toContain('scheduled_retry_portable_order')
    expect(service).not.toContain('fo.last_verified_at ASC NULLS FIRST')
    expect(service).toContain('const retryAfterDays = 30')
    expect(route).toContain('scheduled_retry_uses_canonical_30_day_window')
    expect(route).toContain('retryAfterDays: 30')
  })

  it('pins shared locking and success-driven visibility restoration', () => {
    const route = fs.readFileSync(path.join(HERE, '..', 'routes', 'linkBacklogRepair.js'), 'utf8')
    const verifier = fs.readFileSync(path.join(HERE, '..', 'services', 'linkVerificationService.js'), 'utf8')
    expect(route).toContain('link_backlog_shared_scheduler_lock')
    expect(route).toContain('link_backlog_runtime_bounded_lock_ttl')
    expect(route).toContain("router.post('/schedule-retry'")
    expect(route).toContain('ttlMs: estimateRepairLockTtlMs(repairOptions)')
    expect(route).toContain("const LOCK_NAME = 'link-verification'")
    expect(route).toContain('admin-link-reclassify:')
    expect(route).toContain('admin-link-repair:')
    expect(verifier).toContain('link_repair_success_restores_visibility')
    expect(verifier).toContain("status = CASE WHEN status = 'paused' THEN 'active' ELSE status END")
  })
})
