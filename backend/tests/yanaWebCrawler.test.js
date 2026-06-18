/**
 * Unit tests for backend/services/yana/yanaWebCrawler.js
 *
 * Proves the broad-web client-discovery engine: default-off, robots-aware,
 * real-only (liveness-verified), deduped, and org-only — fully offline via
 * injected fetch/headCheck/robots/delay.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  getYanaCrawlerConfig,
  normalizeWebsite,
  dedupeKey,
  isJunkOrg,
  registerWebSource,
  registerConfiguredWebSources,
  listWebSources,
  _clearWebSources,
  runYanaWebCrawl,
  makeProPublicaNonprofitSource,
} from '../services/yana/yanaWebCrawler.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, website TEXT, mission TEXT,
      focus_areas TEXT, program_areas TEXT, applicant_type TEXT, organization_type TEXT,
      ein TEXT, city TEXT, state TEXT, contact_name TEXT, contact_title TEXT, created_by TEXT,
      created_at DATETIME, updated_at DATETIME, deleted_at DATETIME
    );
  `)
  return db
}

const cfg = (over = {}) => ({
  enabled: true, sources: ['stub'], maxPerRun: 200, perDomainDelayMs: 0,
  userAgent: 'GrantFlow Crawler/1.0', ...over,
})

const NOOP = { async info() {}, async warn() {}, async error() {} }
const noDelay = async () => {}
const allowRobots = async () => ({ allowed: true })
// live unless the host contains "dead"
const headCheck = async (url) => ({ ok: !/dead/i.test(url) })
const fetchImpl = async () => ({ ok: true, text: '' })

const CANDIDATES = [
  { name: 'Helping Hands', email: 'a@hh.org', website: 'hh.org', mission: 'We provide direct services to families in need.', focus_areas: ['housing'], applicant_type: 'nonprofit' },
  { name: 'Faith Center', email: 'b@fc.org', website: 'fc.org' },
  { name: 'Test Org', website: 'junk.org' }, // placeholder → junk
  { name: 'Dead Charity', website: 'dead.org' }, // headCheck fails → dead
]

function registerStub(candidates = CANDIDATES) {
  registerWebSource({
    name: 'stub',
    baseUrl: 'https://dir.example.org',
    async fetchCandidates({ limit = 100 }) { return candidates.slice(0, limit) },
  })
}

beforeEach(() => { _clearWebSources() })

describe('pure helpers', () => {
  it('normalizeWebsite adds scheme, lowercases, strips trailing slash', () => {
    expect(normalizeWebsite('HH.org/')).toBe('https://hh.org')
    expect(normalizeWebsite('https://x.org/path/')).toBe('https://x.org/path')
    expect(normalizeWebsite('')).toBe(null)
  })

  it('dedupeKey prefers website host, then ein, then email, then name+state', () => {
    expect(dedupeKey({ website: 'https://x.org/a' })).toBe('web:x.org')
    expect(dedupeKey({ ein: '12-3456789' })).toBe('ein:123456789')
    expect(dedupeKey({ email: 'A@B.ORG' })).toBe('email:a@b.org')
    expect(dedupeKey({ name: 'Helping Hands', state: 'OH' })).toBe('name:helping hands|oh')
    expect(dedupeKey({})).toBe(null)
  })

  it('isJunkOrg rejects placeholders / no-identity / too-short', () => {
    expect(isJunkOrg({ name: 'Test Org', website: 'x.org' })).toBe(true)
    expect(isJunkOrg({ name: 'Ok' })).toBe(true) // <3 chars
    expect(isJunkOrg({})).toBe(true)
    expect(isJunkOrg({ name: 'Real Nonprofit', email: 'r@n.org' })).toBe(false)
  })
})

describe('getYanaCrawlerConfig', () => {
  it('is OFF with no sources by default', () => {
    const c = getYanaCrawlerConfig({})
    expect(c.enabled).toBe(false)
    expect(c.sources).toEqual([])
  })
  it('parses sources + flags from env', () => {
    const c = getYanaCrawlerConfig({ YANA_WEB_CRAWLER_ENABLED: 'true', YANA_WEB_SOURCES: 'a, b ,c', YANA_WEB_MAX_PER_RUN: '10' })
    expect(c.enabled).toBe(true)
    expect(c.sources).toEqual(['a', 'b', 'c'])
    expect(c.maxPerRun).toBe(10)
  })
})

describe('runYanaWebCrawl gating', () => {
  it('skips when disabled', async () => {
    const r = await runYanaWebCrawl(makeDb(), { config: cfg({ enabled: false }), logger: NOOP })
    expect(r).toMatchObject({ skipped: true, reason: 'crawler_disabled' })
  })
  it('skips when no sources configured', async () => {
    const r = await runYanaWebCrawl(makeDb(), { config: cfg({ sources: [] }), logger: NOOP })
    expect(r).toMatchObject({ skipped: true, reason: 'no_sources_configured' })
  })
})

describe('runYanaWebCrawl discovery', () => {
  it('inserts live orgs, rejects junk + dead, and is idempotent', async () => {
    const db = makeDb()
    registerStub()
    const opts = { config: cfg(), fetchImpl, headCheck, robotsCheck: allowRobots, delay: noDelay, logger: NOOP }

    const r1 = await runYanaWebCrawl(db, opts)
    expect(r1).toMatchObject({ fetched: 4, inserted: 2, rejected_junk: 1, rejected_dead: 1, skipped_dupes: 0 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM organizations').get().c).toBe(2)
    expect(db.prepare("SELECT created_by FROM organizations LIMIT 1").get().created_by).toBe('yana-web-crawler')

    // Second run: the two live orgs already exist → all deduped, none inserted.
    const r2 = await runYanaWebCrawl(db, opts)
    expect(r2).toMatchObject({ inserted: 0, skipped_dupes: 2 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM organizations').get().c).toBe(2)
  })

  it('respects maxPerRun', async () => {
    const db = makeDb()
    registerStub()
    const r = await runYanaWebCrawl(db, { config: cfg({ maxPerRun: 1 }), fetchImpl, headCheck, robotsCheck: allowRobots, delay: noDelay, logger: NOOP })
    expect(r.inserted).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS c FROM organizations').get().c).toBe(1)
  })

  it('skips a source disallowed by robots.txt', async () => {
    const db = makeDb()
    registerStub()
    const r = await runYanaWebCrawl(db, {
      config: cfg(), fetchImpl, headCheck, delay: noDelay, logger: NOOP,
      robotsCheck: async () => ({ allowed: false }),
    })
    expect(r.robots_blocked).toContain('stub')
    expect(r.inserted).toBe(0)
  })

  it('dedupes against a pre-existing organization', async () => {
    const db = makeDb()
    db.prepare("INSERT INTO organizations (id, name, website, created_at, updated_at) VALUES ('x','Helping Hands','https://hh.org',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run()
    registerStub([CANDIDATES[0]]) // just Helping Hands
    const r = await runYanaWebCrawl(db, { config: cfg(), fetchImpl, headCheck, robotsCheck: allowRobots, delay: noDelay, logger: NOOP })
    expect(r).toMatchObject({ inserted: 0, skipped_dupes: 1 })
  })
})

describe('configured sources + ProPublica adapter', () => {
  it('registers a known source named in config', () => {
    _clearWebSources()
    const registered = registerConfiguredWebSources({ sources: ['propublica_nonprofits'] })
    expect(registered).toContain('propublica_nonprofits')
    expect(listWebSources()).toContain('propublica_nonprofits')
  })

  it('ProPublica adapter maps API rows to org candidates', async () => {
    const src = makeProPublicaNonprofitSource({ query: 'foundation' })
    expect(src.name).toBe('propublica_nonprofits')
    const fetchJson = async () => ({ ok: true, json: { organizations: [{ name: 'X Foundation', ein: 123, city: 'Columbus', state: 'OH', ntee_classification: 'Education' }] } })
    const cands = await src.fetchCandidates({ fetchImpl: fetchJson, limit: 10 })
    expect(cands[0]).toMatchObject({ name: 'X Foundation', ein: '123', state: 'OH', applicant_type: 'nonprofit', mission: 'Education' })
  })
})
