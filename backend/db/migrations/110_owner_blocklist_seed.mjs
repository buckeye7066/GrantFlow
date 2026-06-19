/**
 * Seed the owner blocklist with the always-on entries (surname + organizations).
 * Runs after 109_owner_blocklist.sql. Idempotent: ensureSeedEntries() uses
 * SELECT-then-INSERT, so re-running (or a fresh DB) never duplicates and never
 * poisons the surrounding transaction.
 */
import { ensureSeedEntries } from '../../services/blocklist/ownerBlocklistService.js'

export default async function up(db) {
  await ensureSeedEntries(db)
}
