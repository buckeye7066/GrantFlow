#!/usr/bin/env node
/**
 * rekey-dedup-catalog.mjs — one-time catalog re-key + near-duplicate merge.
 *
 * WHY: canonical_opportunity_key was URL-based, so the SAME program extracted
 * by the web-LLM lane from different pages (with paraphrased punctuation/word
 * order) produced up to 7 catalog copies (the NAEMT scholarship class), each
 * matching profiles independently. contract.canonicalOpportunityKey is now
 * title-identity based (token-sorted title+sponsor); this script re-keys every
 * existing row under the new scheme and MERGES collisions:
 *
 *   winner  = most referenced (matches+grants), tie → oldest discovered_at
 *   losers  → profile_opportunity_matches / grants.funding_opportunity_id /
 *             opportunity_sources repointed to the winner (dupes deleted),
 *             then the loser catalog rows are deleted.
 *
 * Usage (inside the Railway container so DATABASE_URL resolves):
 *   node backend/scripts/rekey-dedup-catalog.mjs            # dry-run (default)
 *   node backend/scripts/rekey-dedup-catalog.mjs --apply    # write
 */
import pg from 'pg'
import { canonicalOpportunityKey } from '../crawler-os/contract.js'

const APPLY = process.argv.includes('--apply')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const { rows } = await client.query(`
  SELECT o.id, o.title, o.sponsor, o.application_url, o.source_url,
         o.canonical_opportunity_key AS old_key, o.discovered_at,
         (SELECT COUNT(*) FROM profile_opportunity_matches m WHERE m.opportunity_id = o.id)::int AS match_refs,
         (SELECT COUNT(*) FROM grants g WHERE g.funding_opportunity_id = o.id)::int AS grant_refs
  FROM funding_opportunities o
`)
console.log(`catalog rows: ${rows.length}`)

const groups = new Map()
for (const r of rows) {
  const key = canonicalOpportunityKey({
    title: r.title,
    sponsor: r.sponsor,
    apply_url: r.application_url,
    info_url: r.source_url,
    external_id: null, // external_id column not read here: title identity governs the merge
  })
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(r)
}

const dupeGroups = [...groups.entries()].filter(([, g]) => g.length > 1)
console.log(`distinct keys: ${groups.size}; duplicate groups: ${dupeGroups.length}; rows to merge away: ${dupeGroups.reduce((s, [, g]) => s + g.length - 1, 0)}`)

let merged = 0
let repointedMatches = 0
let repointedGrants = 0

for (const [key, group] of dupeGroups) {
  group.sort((a, b) =>
    (b.match_refs + b.grant_refs) - (a.match_refs + a.grant_refs) ||
    new Date(a.discovered_at ?? '2100-01-01') - new Date(b.discovered_at ?? '2100-01-01'))
  const winner = group[0]
  const losers = group.slice(1)
  if (!APPLY) {
    if (merged < 15) console.log(`[dry] merge ${losers.length} → "${String(winner.title).slice(0, 60)}" (key ${key.slice(0, 60)})`)
    merged += losers.length
    continue
  }
  await client.query('BEGIN')
  try {
    for (const loser of losers) {
      // Repoint matches; a (profile, winner) match that already exists wins — drop the dupe.
      const del = await client.query(
        `DELETE FROM profile_opportunity_matches m
          WHERE m.opportunity_id = $1
            AND EXISTS (SELECT 1 FROM profile_opportunity_matches w
                         WHERE w.profile_id = m.profile_id AND w.opportunity_id = $2)`,
        [loser.id, winner.id])
      const upd = await client.query(
        `UPDATE profile_opportunity_matches SET opportunity_id = $2 WHERE opportunity_id = $1`,
        [loser.id, winner.id])
      repointedMatches += upd.rowCount + del.rowCount
      const g = await client.query(
        `UPDATE grants SET funding_opportunity_id = $2 WHERE funding_opportunity_id = $1`,
        [loser.id, winner.id])
      repointedGrants += g.rowCount
      await client.query(
        `DELETE FROM opportunity_sources s
          WHERE s.opportunity_id = $1
            AND EXISTS (SELECT 1 FROM opportunity_sources w
                         WHERE w.opportunity_id = $2 AND w.source_id = s.source_id)`,
        [loser.id, winner.id])
      await client.query(
        `UPDATE opportunity_sources SET opportunity_id = $2 WHERE opportunity_id = $1`,
        [loser.id, winner.id])
      await client.query(`DELETE FROM funding_opportunities WHERE id = $1`, [loser.id])
      merged++
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(`merge failed for key ${key}:`, err.message)
  }
}

// Re-key every surviving row whose stored key differs from the new scheme.
let rekeyed = 0
if (APPLY) {
  for (const [key, group] of groups.entries()) {
    const survivor = group.length > 1
      ? group.slice().sort((a, b) =>
          (b.match_refs + b.grant_refs) - (a.match_refs + a.grant_refs) ||
          new Date(a.discovered_at ?? '2100-01-01') - new Date(b.discovered_at ?? '2100-01-01'))[0]
      : group[0]
    if (survivor.old_key === key) continue
    try {
      await client.query(
        `UPDATE funding_opportunities SET canonical_opportunity_key = $2 WHERE id = $1`,
        [survivor.id, key])
      rekeyed++
    } catch (err) {
      console.error(`rekey failed for ${survivor.id}:`, err.message)
    }
  }
}

console.log(JSON.stringify({ apply: APPLY, merged, repointedMatches, repointedGrants, rekeyed }))
await client.end()
