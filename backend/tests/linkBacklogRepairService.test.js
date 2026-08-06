import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

import {
  brokenDirectSummary,
  candidateUrlEntries,
  candidateUrls,
  failureClass,
  osmElementUrl,
  reclassifyBrokenResources,
  repairBrokenDirectBatch,
} from '../services/linkBacklogRepairService.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function dbFixture() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      -- link_backlog_extended_url_fixture
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
      link_status TEXT CHECK (link_status IN ('ok','broken','redirect','unverified','skipped')),
      link_status_code INTEGER,
      verification_method TEXT,
      verified_by TEXT,
      verification_error TEXT,
      http_status INTEGER,
      is_hidden INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
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
      id,title,sponsor,source,source_id,application_url,apply_url,apply_guidelines_url,source_url,final_url,contact_info,
      type,opportunity_type,result_kind,opportunity_kind,link_status,
      link_status_code,verification_error,is_hidden,is_active,status
    ) VALUES (@id,@title,@sponsor,@source,@source_id,@application_url,@apply_url,@apply_guidelines_url,@source_url,@final_url,@contact_info,
      @type,@opportunity_type,@result_kind,@opportunity_kind,@link_status,
      @link_status_code,@verification_error,@is_hidden,@is_active,@status)
  `).run({
    title: 'Test Program', sponsor: 'Test Sponsor', source: 'verified_real', source_id: null,
    application_url: null, apply_url: null, apply_guidelines_url: null,
    source_url: null, final_url: null, contact_info: null,
    type: 'OPPORTUNITY', opportunity_type: 'grant', result_kind: 'direct',
    opportunity_kind: 'direct', link_status: 'broken', link_status_code: 404,
    verification_error: 'HTTP 404', is_hidden: 1, is_active: 0, status: 'active',
    ...row,
  })
}

afterEach(() => vi.restoreAllMocks())

describe('link backlog repair', () => {
  it('classifies Overpass locations as stable directory resources and preserves their contact website', async () => {
    const db = dbFixture()
    insert(db, {
      id: 'osm-1',
      source: 'osm_overpass',
      source_id: 'node:12345',
      application_url: 'https://community.example.org/help',
    })

    const result = await reclassifyBrokenResources(db)
    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('osm-1')

    expect(result.osm).toBe(1)
    expect(osmElementUrl('node:12345')).toBe('https://www.openstreetmap.org/node/12345')
    expect(row.opportunity_kind).toBe('directory')
    expect(row.result_kind).toBe('directory')
    expect(row.type).toBe('DIRECTORY')
    expect(row.application_url).toBe('https://www.openstreetmap.org/node/12345')
    expect(JSON.parse(row.contact_info)).toMatchObject({ website: 'https://community.example.org/help' })
    expect(row.link_status).toBe('unverified')
    expect(row.is_hidden).toBe(0)
    expect(row.is_active).toBe(1)
    db.close()
  })

  it('moves persisted action steps out of direct funding without making broken links visible', async () => {
    const db = dbFixture()
    insert(db, { id: 'step-1', result_kind: 'action_step', opportunity_kind: 'benefit' })

    const result = await reclassifyBrokenResources(db)
    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('step-1')

    expect(result.semantic).toBe(1)
    expect(row.opportunity_kind).toBe('referral')
    expect(row.is_hidden).toBe(1)
    expect(row.is_active).toBe(0)
    db.close()
  })

  it('repairs the shared six-kind lifecycle plus NULL/blank legacy rows and excludes pointers', async () => {
    const db = dbFixture()
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
    for (const [index, [id, opportunityKind]] of lifecycleRows.entries()) {
      insert(db, {
        id,
        opportunity_kind: opportunityKind,
        application_url: `https://8.8.8.8/live-${index}`,
      })
    }
    insert(db, {
      id: 'pointer-result',
      opportunity_kind: 'DIRECT',
      result_kind: ' referral ',
      application_url: 'https://8.8.8.8/pointer-result',
    })
    insert(db, {
      id: 'pointer-type',
      opportunity_kind: 'DIRECT',
      type: 'SCHOOL_PORTAL',
      application_url: 'https://8.8.8.8/pointer-type',
    })
    insert(db, {
      id: 'unknown-kind',
      opportunity_kind: 'OTHER',
      application_url: 'https://8.8.8.8/unknown',
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => ({ status: 200, url: String(url) }))

    const result = await repairBrokenDirectBatch(db, {
      limit: 10,
      concurrency: 2,
      timeoutMs: 3000,
      verifiedBy: 'test-canonical-kinds',
      findOfficialUrlImpl: async () => ({ url: null, searched: true, hits: 0 }),
    })

    expect(result).toMatchObject({ selected: 8, restored: 8, retired: 0, pending: 0 })
    for (const [id] of lifecycleRows) {
      expect(db.prepare(`
        SELECT link_status, status, is_hidden, is_active
          FROM funding_opportunities
         WHERE id = ?
      `).get(id)).toEqual({
        link_status: 'ok',
        status: 'active',
        is_hidden: 0,
        is_active: 1,
      })
    }
    for (const id of ['pointer-result', 'pointer-type', 'unknown-kind']) {
      expect(db.prepare(`
        SELECT link_status, status, is_hidden, is_active
          FROM funding_opportunities
         WHERE id = ?
      `).get(id)).toEqual({
        link_status: 'broken',
        status: 'active',
        is_hidden: 1,
        is_active: 0,
      })
    }
    db.close()
  })

  it('tries alternate stored URLs, restores proven rows, and retires only definitive 404/410 exhaustion', async () => {
    const db = dbFixture()
    insert(db, {
      id: 'recover',
      application_url: 'https://8.8.8.8/dead',
      source_url: 'https://8.8.4.4/live',
    })
    insert(db, {
      id: 'retire',
      application_url: 'https://8.8.8.8/gone',
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const text = String(url)
      if (text.includes('8.8.4.4/live')) return { status: 200, url: text }
      return { status: 404, url: text }
    })

    const result = await repairBrokenDirectBatch(db, {
      limit: 10,
      concurrency: 2,
      timeoutMs: 3000,
      verifiedBy: 'test-repair',
      findOfficialUrlImpl: async () => ({ url: null, searched: true, hits: 0 }),
    })
    const recovered = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('recover')
    const retired = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('retire')

    expect(candidateUrls(recovered)).toContain('https://8.8.4.4/live')
    expect(candidateUrlEntries(recovered)).toContainEqual({ role: 'final_url', url: 'https://8.8.4.4/live' })
    expect(result.restored).toBe(1)
    expect(result.retired).toBe(1)
    expect(result.pending).toBe(0)
    expect(result.official_searches).toBe(1)
    expect(result.official_search_rescues).toBe(0)
    expect(recovered.link_status).toBe('ok')
    expect(recovered.status).toBe('active')
    expect(recovered.is_hidden).toBe(0)
    expect(recovered.is_active).toBe(1)
    // A source page may rescue the row, but it is never relabeled as an apply URL.
    expect(recovered.application_url).toBeNull()
    expect(recovered.source_url).toBe('https://8.8.4.4/live')
    expect(recovered.final_url).toBe('https://8.8.4.4/live')
    expect(retired.link_status).toBe('skipped')
    expect(retired.status).toBe('expired')
    expect(retired.verification_error).toMatch(/^retired_after_definitive_recheck:/)
    expect(retired.is_hidden).toBe(1)
    expect(retired.is_active).toBe(0)
    expect(await brokenDirectSummary(db)).toEqual({
      visible: 0,
      quarantined: 0,
      repair_pending: 0,
      retired: 1,
      scheduled_retry: 0,
    })
    expect(db.prepare('SELECT link_status FROM verification_events WHERE opportunity_id=?').get('retire').link_status).toBe('skipped')
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_events').get().n).toBe(2)
    db.close()
  })

  it('uses a proven official-page search result to rescue an otherwise dead record', async () => {
    const db = dbFixture()
    insert(db, {
      id: 'search-rescue',
      title: 'Specific Community Scholarship',
      sponsor: 'Community Foundation',
      application_url: 'https://8.8.8.8/old-page',
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 404, url: 'https://8.8.8.8/old-page' })
    const officialUrl = 'https://official.example.org/specific-community-scholarship'
    const result = await repairBrokenDirectBatch(db, {
      limit: 10,
      concurrency: 1,
      timeoutMs: 3000,
      verifiedBy: 'test-search-rescue',
      findOfficialUrlImpl: async ({ title, sponsor }) => {
        expect(title).toBe('Specific Community Scholarship')
        expect(sponsor).toBe('Community Foundation')
        return {
          url: officialUrl,
          searched: true,
          hits: 3,
          probe: { status: 'ok', code: 200, method: 'get', finalUrl: officialUrl },
        }
      },
    })
    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('search-rescue')

    expect(result.restored).toBe(1)
    expect(result.official_searches).toBe(1)
    expect(result.official_search_rescues).toBe(1)
    expect(result.retired).toBe(0)
    expect(row.application_url).toBeNull()
    expect(row.source_url).toBe(officialUrl)
    expect(row.final_url).toBe(officialUrl)
    expect(row.link_status).toBe('ok')
    expect(row.status).toBe('active')
    expect(row.is_hidden).toBe(0)
    expect(row.is_active).toBe(1)
    db.close()
  })

  it('keeps 403, timeout, network, rate-limit, and 5xx failures retryable instead of erasing valid programs', async () => {
    const db = dbFixture()
    insert(db, {
      id: 'retry',
      application_url: 'https://8.8.8.8/gone',
      source_url: 'https://8.8.4.4/blocked',
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const text = String(url)
      if (text.includes('/gone')) return { status: 404, url: text }
      return { status: 403, url: text }
    })

    const result = await repairBrokenDirectBatch(db, {
      limit: 10,
      concurrency: 1,
      timeoutMs: 3000,
      verifiedBy: 'test-retry',
      findOfficialUrlImpl: async () => ({ url: null, searched: false, error: 'provider unavailable' }),
    })
    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('retry')

    expect(failureClass({ code: 403 })).toBe('access_or_bot_block')
    expect(failureClass({ code: 429 })).toBe('rate_limited')
    expect(failureClass({ code: 503 })).toBe('remote_5xx')
    expect(failureClass({ code: null, error: 'network timeout' })).toBe('timeout')
    expect(result.retired).toBe(0)
    expect(result.pending).toBe(1)
    expect(result.official_searches).toBe(1)
    expect(result.official_search_unavailable).toBe(1)
    expect(row.link_status).toBe('broken')
    expect(row.status).toBe('paused')
    expect(row.is_hidden).toBe(1)
    expect(row.is_active).toBe(0)
    expect(row.verification_error).toMatch(/^retryable_after_recheck:access_or_bot_block:/)
    expect(await brokenDirectSummary(db)).toEqual({
      visible: 0,
      quarantined: 0,
      repair_pending: 1,
      retired: 0,
      scheduled_retry: 0,
    })
    expect(db.prepare('SELECT link_status FROM verification_events').get().link_status).toBe('broken')
    db.close()
  })

  it('pins the production verifier, resource producer, official rescue, and retry-safe lifecycle contract', () => {
    const verifier = fs.readFileSync(path.join(HERE, '..', 'services', 'linkVerificationService.js'), 'utf8')
    const producer = fs.readFileSync(path.join(HERE, '..', 'services', 'crawlers', 'nationalZipCrawler.js'), 'utf8')
    const repair = fs.readFileSync(path.join(HERE, '..', 'services', 'linkBacklogRepairService.js'), 'utf8')
    const server = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8')

    expect(verifier).toContain('SET is_hidden = ?')
    expect(verifier).toContain('hide.run(isPostgres ? true : 1, row.id)')
    expect(verifier).toContain("link_status = 'skipped'")
    expect(verifier).toContain("retired_after_definitive_recheck:%")
    expect(verifier).not.toContain("<> 'retired'")
    expect(verifier).not.toContain('SET is_hidden = 1')
    expect(producer).toContain('link_backlog_resource_contract')
    expect(producer).toContain("opportunity_kind: 'directory'")
    expect(producer).toContain("type: 'DIRECTORY'")
    expect(repair).toContain('findOfficialUrlForOpportunity')
    expect(repair).toContain('retryable_after_recheck:')
    expect(repair).toContain("link_status='skipped'")
    expect(repair).not.toContain("link_status='retired'")
    expect(repair).not.toContain('retired_after_exhaustive_recheck:')
    expect(server).toContain("app.use('/api/admin/link-repair'")
    expect(server).toContain('[link-repair] recurring lifecycle pass')
  })
})
