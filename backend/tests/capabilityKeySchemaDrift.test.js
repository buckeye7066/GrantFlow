/**
 * The capability vocabulary is duplicated in SQL — so pin it (2026-09-15).
 *
 * `billing_addon_entitlements.capability_key` and
 * `billing_entitlement_events.capability_key` each carry a CHECK constraint
 * enumerating the valid capabilities. That list is a COPY of
 * `shared/tierCatalog.js CAPABILITY_KEYS`, and it rotted: the vocabulary grew
 * from three flags to ten while the constraints kept the original three, so
 * `ADDON_CATALOG` advertised ten purchasable capabilities and the database
 * rejected seven of them —
 *   CHECK constraint failed: capability_key IN ('enable_document_ai', ...)
 * A paid upsell that cannot be sold, and nothing failed until someone tried.
 *
 * The authority is the registry; `assertCapabilityKey` already refuses an
 * unknown key at the application edge. The SQL enumeration is kept as
 * defense-in-depth, which is only defensible if it cannot drift — hence this
 * test. It is the guard the first version of the constraint lacked.
 *
 * Precedent in this repo: `funderFieldDrift.test.js` pins the sponsor/funder
 * naming the same way, after the same class of silent divergence.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CAPABILITY_KEYS } from '../../shared/tierCatalog.js'

const MIGRATIONS = [
  '../db/migrations/1007_widen_capability_key_check.sql',
  '../db/postgres/migrations/1007_widen_capability_key_check.sql',
]

/* Both tables must be covered in each dialect: a constraint widened on the
   entitlements table while the events table kept the old list still fails the
   moment an event row is written for a new capability. */
const COVERED_TABLES = ['billing_addon_entitlements', 'billing_entitlement_events']

function readMigration(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/* Every capability_key literal the migration enumerates, deduped. Reading the
   literals rather than parsing SQL keeps this honest about what the database
   will actually accept. */
function enumeratedKeys(sql) {
  const found = new Set()
  for (const match of sql.matchAll(/'(enable_[a-z_]+)'/g)) found.add(match[1])
  return [...found].sort()
}

describe('the SQL capability enumeration matches the registry', () => {
  const expected = Object.values(CAPABILITY_KEYS).sort()

  it.each(MIGRATIONS)('%s enumerates exactly the registry keys', (relative) => {
    const sql = readMigration(relative)
    expect(enumeratedKeys(sql)).toEqual(expected)
  })

  it.each(MIGRATIONS)('%s covers both capability-bearing tables', (relative) => {
    const sql = readMigration(relative)
    for (const table of COVERED_TABLES) {
      expect(sql).toContain(table)
    }
  })

  /* A capability the registry declares but SQL rejects is unsellable; a
     capability SQL accepts but the registry does not know is unenforceable.
     Both directions are failures, so the comparison above is an equality and
     this test states why it must stay one. */
  it('the registry itself is non-empty and every key is an enable_ flag', () => {
    expect(expected.length).toBeGreaterThanOrEqual(10)
    for (const key of expected) expect(key).toMatch(/^enable_[a-z_]+$/)
  })
})
