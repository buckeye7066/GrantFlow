import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  listFundingLibrary,
  getFundingLibraryItem,
  __testables,
} from '../../backend/services/fundingLibraryService.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      source_url TEXT,
      record_origin TEXT,
      description TEXT,
      eligibility_bullets TEXT,
      amount_min REAL,
      amount_max REAL,
      amount_description TEXT,
      deadline DATE,
      deadline_type TEXT,
      application_url TEXT,
      apply_url TEXT,
      apply_guidelines_url TEXT,
      application_mode TEXT,
      contact_info TEXT,
      funder_id TEXT,
      schema_id TEXT,
      is_national INTEGER DEFAULT 0,
      state TEXT,
      regions TEXT,
      categories TEXT,
      keywords TEXT,
      opportunity_type TEXT,
      funding_type TEXT,
      type TEXT,
      evidence_url TEXT,
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_verified_at DATETIME,
      link_status TEXT,
      link_status_code INTEGER,
      verification_method TEXT,
      verified_by TEXT,
      verification_error TEXT,
      opportunity_kind TEXT,
      source_trust_tier TEXT,
      reality_status TEXT,
      reality_reasons TEXT,
      final_url TEXT,
      http_status INTEGER,
      result_kind TEXT,
      is_hidden INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return wrap(raw)
}

function wrap(raw) {
  return {
    dialect: 'sqlite',
    _raw: raw,
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: (...a) => stmt.get(...a),
        all: (...a) => stmt.all(...a),
        run: (...a) => stmt.run(...a),
      }
    },
  }
}

function ins(db, row) {
  const defaults = {
    is_hidden: 0,
    link_status: 'ok',
    record_origin: 'live_crawl',
    is_national: 0,
    categories: '[]',
    keywords: '[]',
    type: 'OPPORTUNITY',
    discovered_at: '2026-01-01T00:00:00Z',
  }
  const merged = { ...defaults, ...row }
  const cols = Object.keys(merged)
  const vals = cols.map((k) => merged[k])
  const placeholders = cols.map(() => '?').join(',')
  db._raw
    .prepare(`INSERT INTO funding_opportunities (${cols.join(',')}) VALUES (${placeholders})`)
    .run(...vals)
}

test('returns empty result when no rows', async () => {
  const db = makeDb()
  const r = await listFundingLibrary(db)
  assert.equal(r.total, 0)
  assert.deepEqual(r.items, [])
  assert.deepEqual(r.facets, __testables.defaultFacets())
})

test('returns verified opportunities by default', async () => {
  const db = makeDb()
  ins(db, { id: 'a1', title: 'Verified Grant', state: 'OH', link_status: 'ok' })
  ins(db, { id: 'a2', title: 'Unverified', state: 'OH', link_status: 'unverified' })
  const r = await listFundingLibrary(db)
  const titles = r.items.map((x) => x.title)
  assert.ok(titles.includes('Verified Grant'))
  assert.ok(!titles.includes('Unverified'), 'unverified excluded by default')
})

test('include_unverified opens the gate', async () => {
  const db = makeDb()
  ins(db, { id: 'b1', title: 'X', state: 'OH', link_status: 'unverified' })
  const r = await listFundingLibrary(db, { include_unverified: true })
  assert.equal(r.total, 1)
  assert.equal(r.items[0].title, 'X')
})

test('loans excluded by default, included with include_loans', async () => {
  const db = makeDb()
  ins(db, { id: 'g1', title: 'Grant', opportunity_type: 'grant' })
  ins(db, { id: 'l1', title: 'Small Loan', opportunity_type: 'loan' })
  const def = await listFundingLibrary(db)
  assert.equal(def.total, 1)
  assert.equal(def.items[0].title, 'Grant')

  const incl = await listFundingLibrary(db, { include_loans: true })
  assert.equal(incl.total, 2)
})

test('hidden records always excluded', async () => {
  const db = makeDb()
  ins(db, { id: 'h1', title: 'Hidden', is_hidden: 1, link_status: 'ok' })
  ins(db, { id: 'v1', title: 'Visible', link_status: 'ok' })
  const r = await listFundingLibrary(db)
  assert.equal(r.total, 1)
  assert.equal(r.items[0].title, 'Visible')
})

test('curated_verified records pass even with link_status=unverified (mission rule: directories survive)', async () => {
  const db = makeDb()
  ins(db, {
    id: 'c1',
    title: 'Curated Directory',
    record_origin: 'curated_verified',
    link_status: 'unverified',
  })
  const r = await listFundingLibrary(db)
  assert.equal(r.total, 1)
})

test('state filter respects national flag', async () => {
  const db = makeDb()
  ins(db, { id: 's1', title: 'OH grant', state: 'OH' })
  ins(db, { id: 's2', title: 'TX grant', state: 'TX' })
  ins(db, { id: 's3', title: 'National', is_national: 1 })
  const r = await listFundingLibrary(db, { state: 'OH' })
  const titles = r.items.map((x) => x.title).sort()
  assert.deepEqual(titles, ['National', 'OH grant'])
})

test('q searches title, sponsor, description', async () => {
  const db = makeDb()
  ins(db, { id: 'q1', title: 'Childcare Grant', sponsor: 'Acme' })
  ins(db, { id: 'q2', title: 'Solar Grant', sponsor: 'Childcare Foundation' })
  ins(db, { id: 'q3', title: 'Other', description: 'Helps with childcare' })
  const r = await listFundingLibrary(db, { q: 'childcare' })
  assert.equal(r.total, 3)
})

test('limit + offset paginate', async () => {
  const db = makeDb()
  for (let i = 0; i < 5; i += 1) {
    ins(db, { id: `p${i}`, title: `Row ${i}`, discovered_at: `2026-01-0${i + 1}T00:00:00Z` })
  }
  const page1 = await listFundingLibrary(db, { limit: 2 })
  assert.equal(page1.items.length, 2)
  assert.equal(page1.total, 5)
  const page2 = await listFundingLibrary(db, { limit: 2, offset: 2 })
  assert.equal(page2.items.length, 2)
  assert.notEqual(page1.items[0].id, page2.items[0].id)
})

test('categories JSON is decoded for the row', async () => {
  const db = makeDb()
  ins(db, { id: 'j1', title: 'X', categories: JSON.stringify(['a', 'b']) })
  const r = await listFundingLibrary(db)
  assert.deepEqual(r.items[0].categories, ['a', 'b'])
})

test('getFundingLibraryItem returns null for missing', async () => {
  const db = makeDb()
  ins(db, { id: 'fx', title: 'Found' })
  assert.ok(await getFundingLibraryItem(db, 'fx'))
  assert.equal(await getFundingLibraryItem(db, 'missing'), null)
})

test('facets count by state and origin', async () => {
  const db = makeDb()
  ins(db, { id: 'f1', state: 'OH', record_origin: 'curated_verified' })
  ins(db, { id: 'f2', state: 'OH', record_origin: 'live_crawl' })
  ins(db, { id: 'f3', state: 'TX', record_origin: 'curated_verified' })
  const r = await listFundingLibrary(db)
  const ohFacet = r.facets.by_state.find((x) => x.state === 'OH')
  assert.ok(ohFacet, 'expected OH facet')
  assert.equal(ohFacet.count, 2)
})

test('handles missing db gracefully', async () => {
  const r = await listFundingLibrary(null)
  assert.equal(r.total, 0)
  assert.deepEqual(r.items, [])
})

test('parseJsonArray helper handles malformed input', () => {
  const { parseJsonArray } = __testables
  assert.deepEqual(parseJsonArray(null), [])
  assert.deepEqual(parseJsonArray('not json'), [])
  assert.deepEqual(parseJsonArray('["a","b"]'), ['a', 'b'])
  assert.deepEqual(parseJsonArray(['x']), ['x'])
})
