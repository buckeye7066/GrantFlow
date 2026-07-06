#!/usr/bin/env node
/**
 * rescore-all-matches.mjs — one-time global re-score onto the NEED-ANCHORED
 * scale (owner directive 2026-07-06).
 *
 * Stored scores in profile_opportunity_matches and grants.match_score were
 * produced by the retired additive model (~45 baseline points). This script
 * re-runs the canonical engine for every active profile's stored matches and
 * scored pipeline rows so every persisted number means the same thing:
 * "% of this profile's main needs covered, after eligibility/geo gates".
 *
 * Protected pipeline rows are re-scored but NEVER deleted here — purging
 * stays the boot invariants' job with all their status/name/origin guards.
 *
 * Usage (inside the Railway container):
 *   node backend/scripts/rescore-all-matches.mjs            # dry-run
 *   node backend/scripts/rescore-all-matches.mjs --apply
 */
import pg from 'pg'
import { computeMatchDecision } from '../services/matchEngine.js'

const APPLY = process.argv.includes('--apply')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const db = {
  async all(sql, params = []) { return (await client.query(sql, params)).rows },
  async run(sql, params = []) { return client.query(sql, params) },
}

const profiles = await db.all(`
  SELECT id FROM profiles
  WHERE deleted_at IS NULL
    AND (status IS NULL OR LOWER(status) NOT IN ('deleted','archived','merged','inactive'))`)
console.log(`active profiles: ${profiles.length}`)

let matchUpdates = 0
let grantUpdates = 0
let decisionsChanged = 0

for (const { id: profileId } of profiles) {
  const profile = (await db.all(`SELECT * FROM profiles WHERE id = $1`, [profileId]))[0]
  if (!profile) continue
  const sections = {}
  for (const row of await db.all(`SELECT section_key, data FROM profile_sections WHERE profile_id = $1`, [profileId])) {
    try { sections[row.section_key] = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : (row.data || {}) } catch { sections[row.section_key] = {} }
  }

  // 1. Stored surface matches
  const matches = await db.all(`
    SELECT m.id AS match_id, m.match_score AS old_score, o.*
    FROM profile_opportunity_matches m
    JOIN funding_opportunities o ON o.id = m.opportunity_id
    WHERE m.profile_id = $1`, [profileId])
  for (const m of matches) {
    try {
      const d = computeMatchDecision(profile, m, { profileSections: sections })
      const score = Math.round(Number(d?.score) || 0)
      const decision = String(d?.decision ?? 'REVIEW').toLowerCase()
      if (score !== Number(m.old_score)) {
        matchUpdates++
        if (APPLY) {
          await db.run(
            `UPDATE profile_opportunity_matches SET match_score = $1, match_decision = $2 WHERE id = $3`,
            [score, decision, m.match_id])
        }
      }
    } catch (err) {
      console.error(`match rescore failed p=${profileId} m=${m.match_id}: ${err.message}`)
    }
  }

  // 2. Scored pipeline rows (NULL rows are the boot backfill's job)
  const grants = await db.all(`
    SELECT g.id AS grant_id, g.match_score AS old_score, g.title AS g_title,
           g.funder AS g_funder,
           g.amount_min AS g_amount_min, g.amount_max AS g_amount_max, o.*
    FROM grants g
    LEFT JOIN funding_opportunities o ON o.id = g.funding_opportunity_id
    WHERE g.profile_id = $1 AND g.match_score IS NOT NULL`, [profileId])
  for (const g of grants) {
    try {
      const target = g.id
        ? g
        : { title: g.g_title, sponsor: g.g_funder, amount_min: g.g_amount_min, amount_max: g.g_amount_max }
      const d = computeMatchDecision(profile, target, { profileSections: sections })
      const score = Math.round(Number(d?.score) || 0)
      if (score !== Number(g.old_score)) {
        grantUpdates++
        if (String(d?.decision ?? '') !== '') decisionsChanged++
        if (APPLY) {
          await db.run(`UPDATE grants SET match_score = $1 WHERE id = $2`, [score, g.grant_id])
        }
      }
    } catch (err) {
      console.error(`grant rescore failed p=${profileId} g=${g.grant_id}: ${err.message}`)
    }
  }
}

console.log(JSON.stringify({ apply: APPLY, matchUpdates, grantUpdates }))
await client.end()
