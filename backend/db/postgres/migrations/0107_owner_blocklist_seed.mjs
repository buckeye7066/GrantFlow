/**
 * Postgres variant of sqlite 110_owner_blocklist_seed.mjs.
 * Seeds the always-on owner blocklist entries via the shared, dialect-safe
 * ensureSeedEntries() (SELECT-then-INSERT keeps the transaction healthy).
 */
import { ensureSeedEntries } from '../../../services/blocklist/ownerBlocklistService.js'

export default async function up(db) {
  await ensureSeedEntries(db)
}
