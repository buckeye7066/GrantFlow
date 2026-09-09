import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY ||= 'b'.repeat(64)
const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { investigateFunderLeads } = await import('../services/robert/robertFunderLeads.js')
const opened = []

afterEach(() => {
  for (const raw of opened.splice(0)) raw.close()
})

function fixture({ sourceUrl = true, urlColumns = true, attempts = 0 } = {}) {
  const raw = new Database(':memory:')
  opened.push(raw)
  raw.exec(`CREATE TABLE grants (
    id TEXT PRIMARY KEY, title TEXT, funder TEXT,
    status TEXT DEFAULT 'interested', notes TEXT,
    pipeline_category TEXT, funder_lead_state TEXT,
    funder_lead_attempts INTEGER DEFAULT 0,
    funder_lead_last_investigated_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    ${urlColumns ? ', application_url TEXT, portal_url TEXT, url TEXT' : ''}
    ${sourceUrl ? ', source_url TEXT' : ''}
  )`)
  raw.prepare(`INSERT INTO grants
    (id, title, funder, pipeline_category, funder_lead_state, funder_lead_attempts, notes)
    VALUES (?, ?, ?, 'funder_lead', 'candidate', ?, ?)`)
    .run('funder-1', 'Housing Foundation', 'Housing Foundation', attempts, 'Owner note: call the grants officer.')
  return wrapSqlite(raw)
}

const homepage = async () => ({ url: 'https://foundation.example', searched: true, hits: 2 })
const rowOf = (db) => db.raw.prepare('SELECT * FROM grants WHERE id = ?').get('funder-1')

describe('funder investigation against the deployed grants contract', () => {
  it('investigates when grants has no catalog-only source_url column', async () => {
    const db = fixture({ sourceUrl: false })
    const result = await investigateFunderLeads(db, { findUrl: homepage })
    expect(result.skipped).toBeNull()
    expect(result.scanned).toBe(1)
    expect(result.investigated).toBe(1)
    expect(rowOf(db).funder_lead_attempts).toBe(1)
  })

  it('reads only existing optional URL columns in a reduced grants schema', async () => {
    const db = fixture({ sourceUrl: false, urlColumns: false })
    const result = await investigateFunderLeads(db, { findUrl: homepage })
    expect(result.skipped).toBeNull()
    expect(result.investigated).toBe(1)
    expect(rowOf(db).pipeline_category).toBe('funder_lead')
  })

  it('promotes an actual application path without requiring source_url', async () => {
    const db = fixture({ sourceUrl: false })
    const result = await investigateFunderLeads(db, {
      findUrl: async () => ({ url: 'https://foundation.example/grants/apply', searched: true, hits: 2 }),
    })
    expect(result.skipped).toBeNull()
    expect(result.promoted).toBe(1)
    expect(rowOf(db).application_url).toBe('https://foundation.example/grants/apply')
    expect(rowOf(db).pipeline_category).toBe('apply_ready')
  })

  it.each([
    ['provider exception', async () => { throw new Error('search provider unavailable') }],
    ['search not performed', async () => ({ url: null, searched: false, error: 'no healthy provider' })],
    ['provider failure after search', async () => ({ url: null, searched: true, hits: 2, error: 'fetch failed' })],
  ])('does not exhaust a lead after %s', async (_name, findUrl) => {
    const db = fixture({ attempts: 2 })
    const before = rowOf(db)
    const result = await investigateFunderLeads(db, { findUrl })
    expect(result.deferredOutage).toBe(1)
    expect(result.notApplicable).toBe(0)
    expect(result.investigated).toBe(0)
    expect(rowOf(db)).toEqual(before)
  })

  it('retains the existing empty-search outage behavior', async () => {
    const db = fixture({ attempts: 2 })
    const before = rowOf(db)
    const result = await investigateFunderLeads(db, {
      findUrl: async () => ({ url: null, searched: true, hits: 0 }),
    })
    expect(result.deferredOutage).toBe(1)
    expect(rowOf(db)).toEqual(before)
  })

  it('records a completed search with no application path as an investigation', async () => {
    const db = fixture()
    const result = await investigateFunderLeads(db, {
      findUrl: async () => ({ url: null, searched: true, hits: 2 }),
    })
    expect(result.deferredOutage).toBe(0)
    expect(result.investigated).toBe(1)
    expect(rowOf(db).funder_lead_attempts).toBe(1)
    expect(rowOf(db).notes).toBe('Owner note: call the grants officer.')
  })

  it('preserves owner notes when recording the funder research page', async () => {
    const db = fixture()
    await investigateFunderLeads(db, { findUrl: homepage })
    const first = rowOf(db).notes
    expect(first).toContain('Owner note: call the grants officer.')
    expect(first).toContain('https://foundation.example')
    await investigateFunderLeads(db, { findUrl: homepage })
    expect(rowOf(db).notes).toBe(first)
    expect(rowOf(db).funder_lead_attempts).toBe(2)
  })
})
