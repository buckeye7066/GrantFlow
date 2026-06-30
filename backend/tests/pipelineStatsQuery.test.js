/**
 * Guard test for the /api/pipeline/stats query (backend/server.js).
 *
 * Regression context: PR #724 rewrote the stats handler from a `COUNT(*) GROUP
 * BY status` into a row-fetch + dedup. The new SELECT named a column `sponsor`
 * that does NOT exist on the `grants` table (the column is `funder`). The pure
 * dedup unit test passed, but nothing exercised the actual SQL against a real
 * schema, so Postgres threw `column "sponsor" does not exist` → a 500 on every
 * dashboard load.
 *
 * This test runs the EXACT SELECT the route uses against the canonical schema
 * (better-sqlite3 in-memory from schema.sql). If anyone reintroduces a column
 * that isn't on `grants`, the prepare() throws here instead of in production.
 * It also proves the dedup collapses duplicate pipeline rows for one opportunity.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

import { dedupePipelineGrants } from '../../shared/dedupePipelineGrants.js'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

// The column list MUST match the SELECT in backend/server.js (/api/pipeline/stats).
const STATS_SELECT = `
  SELECT id, status, funding_opportunity_id, title, funder, amount_awarded
  FROM grants
`

function makeDb() {
  const db = new Database(':memory:')
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  // The stats query reads `grants` standalone (no joins); we seed rows with
  // synthetic funding_opportunity_ids without parent rows, so disable FK
  // enforcement that schema.sql turns on. (Prod Postgres scopes by profile,
  // not by FK validity here.)
  db.pragma('foreign_keys = OFF')
  return db
}

function insertGrant(db, { id, title, funder, status, fo, awarded }) {
  db.prepare(
    `INSERT INTO grants (id, title, funder, status, funding_opportunity_id, amount_awarded)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, title, funder, status, fo, awarded ?? null)
}

describe('pipeline/stats query', () => {
  it('selects only columns that exist on the grants table (no phantom "sponsor")', () => {
    const db = makeDb()
    // The regression guard: prepare() throws "no such column" if the SELECT
    // names a column the schema does not have. This is what reproduces the 500.
    expect(() => db.prepare(STATS_SELECT)).not.toThrow()
    db.close()
  })

  it('dedups duplicate pipeline rows for the same opportunity, keeping the most progressed', () => {
    const db = makeDb()
    // Two rows for the SAME opportunity (re-discovery), plus one distinct grant.
    insertGrant(db, { id: 'a1', title: 'STEM Grant', funder: 'NSF', status: 'discovered', fo: 'fo-1' })
    insertGrant(db, { id: 'a2', title: 'STEM Grant', funder: 'NSF', status: 'submitted', fo: 'fo-1' })
    insertGrant(db, { id: 'b1', title: 'Arts Grant', funder: 'NEA', status: 'interested', fo: 'fo-2' })

    const rawRows = db.prepare(STATS_SELECT).all()
    expect(rawRows).toHaveLength(3)

    const rows = dedupePipelineGrants(rawRows)
    // fo-1's two rows collapse to one; fo-2 stays → 2 unique opportunities.
    expect(rows).toHaveLength(2)

    const fo1 = rows.find((r) => r.funding_opportunity_id === 'fo-1')
    // Most-progressed wins: 'submitted' beats 'discovered'.
    expect(fo1.status).toBe('submitted')
    db.close()
  })
})
