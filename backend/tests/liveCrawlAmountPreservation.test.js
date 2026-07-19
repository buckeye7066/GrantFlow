/**
 * liveCrawlAmountPreservation.test.js
 *
 * THE DEFECT (measured in prod 2026-07-16): a re-crawl silently WIPED award
 * amounts the grants.gov API adapter had just acquired.
 *
 * `upsertFundingOpportunity` clears nullable fields on a `live_crawl` re-ingest
 * "when source no longer has them (avoids stale data)". Sound in general — but it
 * treats an ingest carrying NO amount as the source ASSERTING it has none. For a
 * listing endpoint that is simply false: grants.gov `search2`, which every
 * grants.gov crawl uses, returns no award fields at all, ever. So every re-crawl
 * wiped rows whose amounts the API had just provided, and because
 * `amount_enrich_attempted_at` survives the wipe, the row was BURNED — never
 * re-enriched, permanently blank.
 *
 * Prod fingerprint: FY26 Pathways enriched to $5M–$10M at 14:51, re-crawled at
 * 23:28, wiped. The one row NOT re-crawled kept its $9M. Fleet-wide, `live_crawl`
 * rows carried an amount 13/538 (2.4%) vs `funding_api` 147/866 (17%). Coverage
 * decayed 21% → 15% in seven hours.
 *
 * Runs against the REAL production schema so the gates + dedupe run for real.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { upsertFundingOpportunity } from '../services/opportunityInserter.js'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

let db
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
})

/** A grants.gov row as the ADAPTER leaves it: real award figures from the API. */
const enriched = {
  title: 'FY26 Pathways to Removing Obstacles to Housing',
  sponsor: 'HUD',
  description: 'A real federal opportunity with award figures from the grants.gov API.',
  source: 'grants.gov',
  source_url: 'https://www.grants.gov/search-results-detail/362005',
  application_url: 'https://www.grants.gov/search-results-detail/362005',
  record_origin: 'live_crawl',
  amount_min: 5_000_000,
  amount_max: 10_000_000,
}

/**
 * The SAME row as a re-crawl sees it through `search2` — which carries no award
 * fields whatsoever. This is not "the funder removed the amount"; it is a
 * listing endpoint that never had one to give.
 */
const silentRecrawl = {
  title: 'FY26 Pathways to Removing Obstacles to Housing',
  sponsor: 'HUD',
  description: 'A real federal opportunity with award figures from the grants.gov API.',
  source: 'grants.gov',
  source_url: 'https://www.grants.gov/search-results-detail/362005',
  application_url: 'https://www.grants.gov/search-results-detail/362005',
  record_origin: 'live_crawl',
  // no amount_min / amount_max / amount_text — SILENT
}

const readAmounts = (id) =>
  db.prepare('SELECT amount_min, amount_max, amount_text, amount_status FROM funding_opportunities WHERE id = ?').get(id)

describe('live_crawl re-ingest must not wipe an amount it knows nothing about', () => {
  it('PRESERVES the amount when the re-crawl carries no amount signal', async () => {
    // THE REGRESSION. On the old code the second upsert nulled amount_min/max,
    // destroying what the API adapter had just acquired.
    const first = await upsertFundingOpportunity(db, enriched, { verifyUrl: false })
    expect(first.skipped, `seed upsert was gated: ${first.reason}`).toBeFalsy()
    expect(readAmounts(first.id).amount_max).toBe(10_000_000)

    const again = await upsertFundingOpportunity(db, silentRecrawl, { verifyUrl: false })
    const after = readAmounts(again.id ?? first.id)
    expect(after.amount_min, 'a silent re-crawl must not wipe a known amount').toBe(5_000_000)
    expect(after.amount_max).toBe(10_000_000)
  })

  it('STILL overwrites when the re-crawl actually asserts an amount', async () => {
    // The "avoid stale data" intent is preserved: an ingest that says something
    // about amounts is authoritative, including a correction downward.
    const first = await upsertFundingOpportunity(db, enriched, { verifyUrl: false })
    const updated = await upsertFundingOpportunity(
      db,
      { ...enriched, amount_min: 1_000, amount_max: 25_000 },
      { verifyUrl: false },
    )
    const after = readAmounts(updated.id ?? first.id)
    expect(after.amount_max).toBe(25_000)
    expect(after.amount_min).toBe(1_000)
  })

  it('a re-crawl asserting only TEXT still clears stale numerics', async () => {
    // amount_text is an assertion too — "Varies" genuinely supersedes an old range.
    const first = await upsertFundingOpportunity(db, enriched, { verifyUrl: false })
    const updated = await upsertFundingOpportunity(
      db,
      { ...enriched, amount_min: null, amount_max: null, amount_description: 'Varies by project' },
      { verifyUrl: false },
    )
    const after = readAmounts(updated.id ?? first.id)
    expect(after.amount_max).toBeNull()
    expect(after.amount_text).toBeTruthy()
  })

  it('a silent re-crawl still refreshes the NON-amount fields it does carry', async () => {
    // The fix must be surgical — it protects amounts, not everything.
    const first = await upsertFundingOpportunity(db, enriched, { verifyUrl: false })
    const updated = await upsertFundingOpportunity(
      db,
      { ...silentRecrawl, description: 'Updated description from the re-crawl.' },
      { verifyUrl: false },
    )
    const row = db.prepare('SELECT description, amount_max FROM funding_opportunities WHERE id = ?').get(updated.id ?? first.id)
    expect(row.description).toBe('Updated description from the re-crawl.')
    expect(row.amount_max, 'amounts still preserved').toBe(10_000_000)
  })
})
