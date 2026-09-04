import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { upsertFundingOpportunity } from '../../backend/services/opportunityInserter.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      title TEXT NOT NULL,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      canonical_opportunity_key TEXT,
      source_url TEXT,
      evidence_url TEXT,
      record_origin TEXT DEFAULT 'live_crawl',
      description TEXT,
      eligibility_bullets TEXT DEFAULT '[]',
      amount_min REAL,
      amount_max REAL,
      amount_description TEXT,
      amount_text TEXT,
      amount_status TEXT,
      amount_confidence REAL,
      deadline TEXT,
      deadline_type TEXT,
      application_url TEXT,
      is_national INTEGER DEFAULT 0,
      state TEXT,
      categories TEXT DEFAULT '[]',
      keywords TEXT DEFAULT '[]',
      opportunity_type TEXT,
      funding_type TEXT,
      type TEXT DEFAULT 'OPPORTUNITY',
      -- Production reality gate: discovery vs verification are separate.
      discovered_at DATETIME,
      last_verified_at DATETIME,
      link_status TEXT DEFAULT 'unverified',
      link_status_code INTEGER,
      verification_method TEXT,
      verified_by TEXT,
      verification_error TEXT,
      -- Reality gate phase 1.2: kind + source trust tier (migration 068).
      opportunity_kind TEXT,
      result_kind TEXT,
      source_trust_tier TEXT,
      -- RC-8: persisted reality verdict (migration 077).
      reality_status TEXT,
      reality_reasons TEXT,
      final_url TEXT,
      http_status INTEGER,
      profile_id TEXT,
      requires_501c3 INTEGER DEFAULT 0,
      requires_match INTEGER DEFAULT 0,
      match_percentage REAL,
      match_reasons TEXT DEFAULT '[]',
      notes TEXT,
      is_loan INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      last_crawled DATETIME,
      contact_info TEXT DEFAULT NULL,
      funding_domain TEXT,
      funding_subdomain TEXT,
      source_category TEXT,
      compliance_required TEXT DEFAULT '[]',
      certifications_required TEXT DEFAULT '[]',
      geo_eligibility TEXT,
      signal_tags TEXT DEFAULT '[]',
      verified_url INTEGER DEFAULT 0,
      crawler_version TEXT,
      funding_source_type TEXT,
      funding_category TEXT,
      usable_for_housing INTEGER DEFAULT 0,
      refund_potential INTEGER DEFAULT 0,
      eligibility_signals TEXT DEFAULT '[]',
      verification_status TEXT,
      -- Award-calendar columns (schema.sql; added by the calendar PRs). The
      -- ingest choke point writes them, so the fixture must carry them or every
      -- insert throws SQLITE_ERROR "no column named expected_decision_date".
      expected_decision_date DATE,
      decision_review_days INTEGER,
      reporting_requirements TEXT
    );

    CREATE UNIQUE INDEX funding_opportunities_source_source_id_uniq
      ON funding_opportunities(source, source_id);
  `)
  return db
}

test('opportunityInserter: live_crawl requires evidence/source/application URL', async () => {
  const db = createDb()
  const res = await upsertFundingOpportunity(db, {
    title: 'No URL Opp',
    sponsor: 'Nobody',
    source: 'unit_test',
    source_id: 'no-url-1',
    record_origin: 'live_crawl',
  })

  assert.equal(res.skipped, true)
  const count = db.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get().c
  assert.equal(Number(count), 0)
})

test('opportunityInserter: inserts live crawl and updates existing row', async () => {
  const db = createDb()

  const inserted = await upsertFundingOpportunity(db, {
    title: 'Example Opportunity',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'opp-1',
    source_url: 'https://www.grants.gov/',
    application_url: 'https://www.grants.gov/',
    record_origin: 'live_crawl',
    description: 'v1',
  })
  assert.equal(inserted.inserted, true)

  const row1 = db
    .prepare(
      `SELECT description, evidence_url, last_verified_at, discovered_at, link_status, is_hidden
       FROM funding_opportunities
       WHERE source = ? AND source_id = ?`,
    )
    .get('unit_test', 'opp-1')
  assert.equal(row1.description, 'v1')
  assert.ok(row1.evidence_url)
  // Production reality gate: last_verified_at MUST be null when no real check
  // happened. discovered_at is the honest "first ingested" timestamp instead.
  assert.equal(
    row1.last_verified_at,
    null,
    'last_verified_at must be null without proof of verification',
  )
  assert.ok(row1.discovered_at, 'discovered_at must be set on insert')
  assert.equal(row1.link_status, 'unverified')
  assert.equal(row1.is_hidden, 1, 'unverified direct rows must fail closed from visible results')

  const updated = await upsertFundingOpportunity(db, {
    title: 'Example Opportunity',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'opp-1',
    source_url: 'https://www.grants.gov/',
    record_origin: 'live_crawl',
    description: 'v2',
  })
  assert.equal(updated.updated, true)

  const row2 = db
    .prepare(`SELECT description FROM funding_opportunities WHERE source = ? AND source_id = ?`)
    .get('unit_test', 'opp-1')
  assert.equal(row2.description, 'v2')
})

test('opportunityInserter: same-target recrawl preserves proof; unverified target change quarantines', async () => {
  const db = createDb()
  const verifiedAt = new Date().toISOString()

  await upsertFundingOpportunity(db, {
    title: 'Verified Live Opp',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'verified-recrawl-1',
    source_url: 'https://www.grants.gov/original',
    application_url: 'https://www.grants.gov/original',
    record_origin: 'live_crawl',
    last_verified_at: verifiedAt,
    link_status: 'ok',
    link_status_code: 200,
    verification_method: 'head',
    verified_by: 'unit-test',
  })

  const sameTarget = await upsertFundingOpportunity(db, {
    title: 'Verified Live Opp',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'verified-recrawl-1',
    source_url: 'https://www.grants.gov/original',
    application_url: 'https://www.grants.gov/original',
    record_origin: 'live_crawl',
    description: 'fresh crawler metadata without a duplicate network probe',
  })
  assert.equal(sameTarget.updated, true)
  assert.deepEqual(
    db.prepare(`SELECT link_status, last_verified_at, verification_method, is_hidden
                  FROM funding_opportunities WHERE source_id = ?`).get('verified-recrawl-1'),
    { link_status: 'ok', last_verified_at: verifiedAt, verification_method: 'head', is_hidden: 0 },
    'same-target metadata refresh must not erase current link proof',
  )

  const changedTarget = await upsertFundingOpportunity(db, {
    title: 'Verified Live Opp',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'verified-recrawl-1',
    source_url: 'https://www.grants.gov/replacement',
    application_url: 'https://www.grants.gov/replacement',
    record_origin: 'live_crawl',
  })
  assert.equal(changedTarget.updated, true)
  assert.deepEqual(
    db.prepare(`SELECT application_url, link_status, last_verified_at, verification_method,
                       verification_error, is_hidden
                  FROM funding_opportunities WHERE source_id = ?`).get('verified-recrawl-1'),
    {
      application_url: 'https://www.grants.gov/replacement',
      link_status: 'unverified',
      last_verified_at: null,
      verification_method: null,
      verification_error: 'url_changed_requires_reverification',
      is_hidden: 1,
    },
    'a changed target cannot inherit proof from the previous URL',
  )
})

test('opportunityInserter: baseline cannot downgrade verified record', async () => {
  const db = createDb()

  // Create a verified record by passing real verification proof.
  await upsertFundingOpportunity(db, {
    title: 'Verified Opp',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'verified-1',
    source_url: 'https://www.grants.gov/',
    record_origin: 'live_crawl',
    last_verified_at: new Date().toISOString(),
    link_status: 'ok',
    link_status_code: 200,
    verification_method: 'head',
    verified_by: 'unit-test',
  })

  // Baseline/unverified incoming should not overwrite
  const res = await upsertFundingOpportunity(db, {
    title: 'Verified Opp (baseline overwrite attempt)',
    sponsor: 'Other',
    source: 'unit_test',
    source_id: 'verified-1',
    source_url: 'https://www.grants.gov/',
    record_origin: 'curated_verified',
    last_verified_at: null,
  })

  assert.equal(res.skipped, true)
  const row = db
    .prepare(`SELECT title, sponsor FROM funding_opportunities WHERE source = ? AND source_id = ?`)
    .get('unit_test', 'verified-1')
  assert.equal(row.title, 'Verified Opp')
  assert.equal(row.sponsor, 'Agency')
})

test('opportunityInserter: caller-supplied last_verified_at is stripped without verification proof', async () => {
  const db = createDb()

  const fakeVerifiedAt = '2026-01-01T00:00:00Z'
  await upsertFundingOpportunity(db, {
    title: 'Hallucinated Verification Opp',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'hallucinated-1',
    source_url: 'https://www.grants.gov/',
    application_url: 'https://www.grants.gov/',
    record_origin: 'live_crawl',
    description: 'Caller claims it was verified but supplies no proof.',
    last_verified_at: fakeVerifiedAt,
    // Intentionally omitting link_status / verification_method.
  })

  const row = db
    .prepare(
      `SELECT last_verified_at, discovered_at, link_status, verification_method
       FROM funding_opportunities WHERE source = ? AND source_id = ?`,
    )
    .get('unit_test', 'hallucinated-1')
  assert.equal(
    row.last_verified_at,
    null,
    'gate must strip caller-supplied last_verified_at without proof',
  )
  assert.equal(row.link_status, 'unverified')
  assert.equal(row.verification_method, null)
  assert.ok(row.discovered_at, 'discovered_at fallback must be present')
})

test('opportunityInserter: caller-supplied verification proof is honored', async () => {
  const db = createDb()

  const verifiedAt = new Date().toISOString()
  await upsertFundingOpportunity(db, {
    title: 'Truly Verified Opp',
    sponsor: 'Agency',
    source: 'unit_test',
    source_id: 'verified-2',
    source_url: 'https://www.grants.gov/',
    application_url: 'https://www.grants.gov/',
    record_origin: 'live_crawl',
    description: 'A live HEAD probe succeeded just before insert.',
    last_verified_at: verifiedAt,
    link_status: 'ok',
    link_status_code: 200,
    verification_method: 'head',
    verified_by: 'crawler:unit-test',
  })

  const row = db
    .prepare(
      `SELECT last_verified_at, link_status, link_status_code, verification_method, verified_by
       FROM funding_opportunities WHERE source = ? AND source_id = ?`,
    )
    .get('unit_test', 'verified-2')
  assert.equal(row.last_verified_at, verifiedAt)
  assert.equal(row.link_status, 'ok')
  assert.equal(row.link_status_code, 200)
  assert.equal(row.verification_method, 'head')
  assert.equal(row.verified_by, 'crawler:unit-test')
})

test('opportunityInserter: rejects article URLs before storing funding opportunities', async () => {
  const db = createDb()

  const result = await upsertFundingOpportunity(db, {
    title: 'Benevolence Fund Basics',
    sponsor: 'Church Law & Tax',
    source: 'unit_test',
    source_id: 'article-1',
    application_url: 'https://www.churchlawandtax.com/web/2021/september/benevolence-fund-basics.html',
    record_origin: 'live_crawl',
    description: 'Article about benevolence funds.',
  })

  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'quality:article_or_informational_url')
  const count = db.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get().c
  assert.equal(Number(count), 0)
})

test('opportunityInserter: deduplicates referral lookup permutations at ingest', async () => {
  const db = createDb()

  const first = await upsertFundingOpportunity(db, {
    title: 'Find Your Local Community Action Agency',
    sponsor: 'Community Action Partnership',
    source: 'unit_test_referral',
    application_url: 'https://communityactionpartnership.com/find-a-cap/?zip=43215',
    record_origin: 'live_crawl',
    description: 'Find local assistance by ZIP code.',
  })
  const second = await upsertFundingOpportunity(db, {
    title: 'Find Your Local Community Action Agency',
    sponsor: 'Community Action Partnership',
    source: 'unit_test_referral',
    application_url: 'https://communityactionpartnership.com/find-a-cap/?zip=44101',
    record_origin: 'live_crawl',
    description: 'Find local assistance by ZIP code.',
  })

  assert.equal(first.inserted, true)
  assert.equal(second.updated, true)
  const rows = db.prepare('SELECT source_id, opportunity_type, type, application_url, is_hidden FROM funding_opportunities').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source_id, 'communityactionpartnership.com/find-a-cap')
  assert.equal(rows[0].opportunity_type, 'referral')
  assert.equal(rows[0].type, 'DIRECTORY')
  assert.equal(rows[0].application_url, 'https://communityactionpartnership.com/find-a-cap/')
  assert.equal(rows[0].is_hidden, 0, 'pointer resources remain visible without per-award proof')
})

test('opportunityInserter: normalizes state values at ingest and drops invalid country placeholders', async () => {
  const db = createDb()

  await upsertFundingOpportunity(db, {
    title: 'Pennsylvania Equipment Grant',
    sponsor: 'Agency',
    source: 'unit_test_state',
    source_id: 'pa-state',
    source_url: 'https://www.grants.gov/pa-state',
    application_url: 'https://www.grants.gov/pa-state',
    record_origin: 'live_crawl',
    state: 'Pennsylvania',
    description: 'Grant for Pennsylvania organizations.',
  })
  await upsertFundingOpportunity(db, {
    title: 'Invalid Country State Grant',
    sponsor: 'Agency',
    source: 'unit_test_state',
    source_id: 'usa-state',
    source_url: 'https://www.grants.gov/usa-state',
    application_url: 'https://www.grants.gov/usa-state',
    record_origin: 'live_crawl',
    state: 'USA',
    description: 'Grant with invalid state placeholder.',
  })
  await upsertFundingOpportunity(db, {
    title: 'Invalid Nation Wide Grant',
    sponsor: 'Agency',
    source: 'unit_test_state',
    source_id: 'nation-wide-state',
    source_url: 'https://www.grants.gov/nation-wide-state',
    application_url: 'https://www.grants.gov/nation-wide-state',
    record_origin: 'live_crawl',
    state: 'nation-wide',
    description: 'Grant with invalid nationwide variant.',
  })

  const rows = db
    .prepare('SELECT source_id, state FROM funding_opportunities ORDER BY source_id')
    .all()

  assert.equal(rows.some((row) => row.state === 'USA' || row.state === 'United States' || row.state === 'nation-wide'), false)
  assert.deepEqual(rows.filter((row) => row.source_id !== 'usa-state'), [
    { source_id: 'nation-wide-state', state: null },
    { source_id: 'pa-state', state: 'PA' },
  ])
})


test('opportunityInserter: sponsor accepts funder/agency naming-drift aliases at the ingest choke point', async () => {
  const db = createDb()

  // Producer that (wrongly but historically) emits `funder` instead of `sponsor`
  // must still land a populated sponsor column — never a silent NULL (#725 class).
  const viaFunder = await upsertFundingOpportunity(db, {
    title: 'Drift Funder Opp',
    funder: 'Volunteer Foundation',
    source: 'unit_test',
    source_id: 'drift-funder-1',
    source_url: 'https://www.grants.gov/',
    application_url: 'https://www.grants.gov/',
    record_origin: 'live_crawl',
  })
  assert.equal(viaFunder.inserted, true)
  assert.equal(
    db.prepare('SELECT sponsor FROM funding_opportunities WHERE source_id = ?').get('drift-funder-1').sponsor,
    'Volunteer Foundation',
  )

  const viaAgency = await upsertFundingOpportunity(db, {
    title: 'Drift Agency Opp',
    agency: 'Department of Example',
    source: 'unit_test',
    source_id: 'drift-agency-1',
    source_url: 'https://www.grants.gov/',
    application_url: 'https://www.grants.gov/',
    record_origin: 'live_crawl',
  })
  assert.equal(viaAgency.inserted, true)
  assert.equal(
    db.prepare('SELECT sponsor FROM funding_opportunities WHERE source_id = ?').get('drift-agency-1').sponsor,
    'Department of Example',
  )

  // Canonical `sponsor` always wins over any alias.
  const viaBoth = await upsertFundingOpportunity(db, {
    title: 'Canonical Sponsor Opp',
    sponsor: 'Canonical Sponsor',
    funder: 'Alias Ignored',
    source: 'unit_test',
    source_id: 'drift-both-1',
    source_url: 'https://www.grants.gov/',
    application_url: 'https://www.grants.gov/',
    record_origin: 'live_crawl',
  })
  assert.equal(viaBoth.inserted, true)
  assert.equal(
    db.prepare('SELECT sponsor FROM funding_opportunities WHERE source_id = ?').get('drift-both-1').sponsor,
    'Canonical Sponsor',
  )
})
