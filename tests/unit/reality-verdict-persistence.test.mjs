// RC-8 contract tests: the persisted reality-gate verdict is the source of
// truth for display readers, and consumer-side trust agrees with insert-side
// reality at the verdict level. These tests pin the behavior so the two
// implementations cannot drift again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { assessReality } from '../../backend/services/opportunityRealityGate.js'
import { assessOpportunityTrust } from '../../backend/services/opportunityTrust.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SCHEMA_SQL = readFileSync(
  resolve(__dirname, '../../backend/db/schema.sql'),
  'utf8',
)
const SQLITE_MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../backend/db/migrations/077_funding_opportunities_reality_verdict.sql',
  ),
  'utf8',
)
const POSTGRES_MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../backend/db/postgres/migrations/0073_funding_opportunities_reality_verdict.sql',
  ),
  'utf8',
)

// Build a row with the insert-side verdict baked in, the way
// opportunityInserter does.
function persistVerdict(row) {
  const verdict = assessReality(row, {
    allowExpired: false,
    allowLoans: false,
    allowMatchingFunds: false,
    allowSocialDirect: false,
    allowBrokenDirect: false,
  })
  return {
    ...row,
    reality_status: verdict.allowed
      ? verdict.downgrade
        ? 'downgraded'
        : 'allowed'
      : 'rejected',
    reality_reasons: JSON.stringify(verdict.reasons),
    final_url: verdict.usableUrl ?? row.application_url ?? row.source_url ?? null,
  }
}

test('schema.sql declares reality_status / reality_reasons / final_url / http_status on funding_opportunities', () => {
  const tableMatch = SCHEMA_SQL.match(
    /CREATE TABLE IF NOT EXISTS funding_opportunities[\s\S]*?\);\s*\n/,
  )
  assert.ok(tableMatch, 'funding_opportunities table not found in schema.sql')
  const block = tableMatch[0]
  assert.match(block, /reality_status\s+TEXT/)
  assert.match(block, /reality_reasons\s+TEXT/)
  assert.match(block, /final_url\s+TEXT/)
  assert.match(block, /http_status\s+INTEGER/)
})

test('SQLite migration 077 adds the four reality verdict columns', () => {
  assert.match(SQLITE_MIGRATION, /ADD COLUMN reality_status TEXT/)
  assert.match(SQLITE_MIGRATION, /ADD COLUMN reality_reasons TEXT/)
  assert.match(SQLITE_MIGRATION, /ADD COLUMN final_url TEXT/)
  assert.match(SQLITE_MIGRATION, /ADD COLUMN http_status INTEGER/)
  assert.match(
    SQLITE_MIGRATION,
    /@sqlite-continue-on-idempotent-errors/,
    'must be idempotent on re-run',
  )
})

test('Postgres migration 0073 adds the four reality verdict columns idempotently', () => {
  assert.match(POSTGRES_MIGRATION, /ADD COLUMN IF NOT EXISTS reality_status TEXT/)
  assert.match(POSTGRES_MIGRATION, /ADD COLUMN IF NOT EXISTS reality_reasons JSONB/)
  assert.match(POSTGRES_MIGRATION, /ADD COLUMN IF NOT EXISTS final_url TEXT/)
  assert.match(POSTGRES_MIGRATION, /ADD COLUMN IF NOT EXISTS http_status INTEGER/)
})

test('drift: insert-side allowed -> display-side displays', () => {
  const row = {
    title: 'Real Direct Federal Grant',
    sponsor: 'USDA',
    application_url: 'https://www.grants.gov/web/grants/view-opportunity.html?oppId=12345',
    source: 'grants_gov',
    record_origin: 'live_crawl',
    type: 'OPPORTUNITY',
    deadline_type: 'rolling',
    is_loan: false,
    requires_match: false,
  }
  const reality = assessReality(row)
  assert.equal(reality.allowed, true, 'sanity: row should pass insert-side gate')
  const persisted = persistVerdict(row)
  const trust = assessOpportunityTrust(persisted)
  assert.equal(trust.display, true, 'persisted allowed must surface to display')
  assert.equal(trust.persistedRealityStatus, reality.downgrade ? 'downgraded' : 'allowed')
})

test('drift: insert-side rejects loan -> display-side hides by default, but allowLoans=true rescues', () => {
  const row = {
    title: 'Federal Direct PLUS Loan',
    sponsor: 'US Dept of Education',
    application_url: 'https://studentaid.gov/understand-aid/types/loans',
    source: 'studentaid_gov',
    record_origin: 'verified_real',
    type: 'OPPORTUNITY',
    is_loan: true,
  }
  const reality = assessReality(row)
  assert.equal(reality.allowed, false)
  assert.ok(reality.reasons.includes('loan_like'))
  const persisted = persistVerdict(row)

  const defaultTrust = assessOpportunityTrust(persisted)
  assert.equal(defaultTrust.display, false, 'persisted rejection must hide by default')
  assert.ok(defaultTrust.reasons.includes('persisted_reality_rejected'))

  const rescuedTrust = assessOpportunityTrust(persisted, { allowLoans: true })
  // The user explicitly opted into loans, so the persisted rejection must
  // not block display anymore (the consumer-side derivation will still flag
  // loan but keep display=true).
  assert.equal(rescuedTrust.display, true, 'allowLoans=true must rescue loan rejection')
})

test('drift: persisted reality_reasons survives JSON round-trip (string column on SQLite)', () => {
  const row = {
    title: 'Test',
    application_url: 'https://example.org/grant',
    source: 'live',
    record_origin: 'live_crawl',
  }
  const persisted = persistVerdict(row)
  // reality_reasons is stored as a JSON string (TEXT in SQLite, JSONB-as-text
  // when read back from PG). The display reader must accept that shape.
  assert.equal(typeof persisted.reality_reasons, 'string')
  const trust = assessOpportunityTrust(persisted)
  assert.ok(Array.isArray(trust.persistedRealityReasons))
})

test('drift: legacy row without reality_status falls through to consumer-side derivation', () => {
  const row = {
    title: 'Legacy Row',
    application_url: 'https://example.org/grant',
    source: 'live',
    record_origin: 'live_crawl',
    // intentionally no reality_status / reality_reasons / final_url
  }
  const trust = assessOpportunityTrust(row)
  assert.equal(trust.persistedRealityStatus, null)
  // Display decision still happens on legacy rows; this just proves we
  // didn't accidentally hard-block them when reality_status is null.
  assert.equal(typeof trust.display, 'boolean')
})

test('drift: persisted=allowed flows through to display when row is otherwise OK', () => {
  // Insert path explicitly accepted this row at ingest time (via
  // assessReality). The display reader must not undo that decision when
  // there is no hard data-quality failure (placeholder/no_real_url).
  const row = {
    title: 'USDA Rural Development Single Family Housing Repair Grants',
    sponsor: 'US Department of Agriculture',
    application_url: 'https://www.rd.usda.gov/programs-services/single-family-housing-repair-loans-grants',
    source: 'verified_real',
    record_origin: 'verified_real',
    type: 'OPPORTUNITY',
    link_status: 'unverified',
    reality_status: 'allowed',
    reality_reasons: '[]',
    final_url: 'https://www.rd.usda.gov/programs-services/single-family-housing-repair-loans-grants',
  }
  const trust = assessOpportunityTrust(row)
  assert.equal(trust.persistedRealityStatus, 'allowed')
  assert.equal(trust.display, true, 'persisted allowed must surface to display when row passes hard gates')
})
