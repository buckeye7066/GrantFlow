#!/usr/bin/env node
/**
 * score-distribution.mjs — READ-ONLY empirical calibration for the
 * DATA-POINT scoring model (owner directive 2026-07-06 evening).
 *
 * The data-point scale divides by the profile's ENTIRE data-point inventory
 * (typically 30–150 points) instead of min(needs, 4), so absolute scores run
 * far lower than the need-anchored scale. Reusing the old bars (25 pipeline
 * bar, 12 relevance floor) would empty every pipeline overnight on deploy.
 *
 * This script re-scores every stored match under the NEW model (dry — writes
 * nothing) and reports:
 *   1. the global new-score distribution (percentiles),
 *   2. for each OLD bar (25/50/75, floor 12), the NEW value that keeps the
 *      same share of matches above it (population-preserving mapping),
 *   3. per-profile sanity previews (top rows old vs new ordering).
 *
 * Usage (inside the Railway container, or any env with DATABASE_URL):
 *   GRANTFLOW_SCORING_MODEL=data_point node backend/scripts/score-distribution.mjs
 */
import pg from 'pg'
import { computeMatchDecision } from '../services/matchEngine.js'
import { SCORING_MODEL } from '../config/matchThresholds.js'

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
const db = {
  async all(sql, params = []) { return (await client.query(sql, params)).rows },
}

console.log(`scoring model in effect: ${SCORING_MODEL}`)

const profiles = await db.all(`
  SELECT id, display_name FROM profiles
  WHERE deleted_at IS NULL
    AND (status IS NULL OR LOWER(status) NOT IN ('deleted','archived','merged','inactive'))`)
console.log(`active profiles: ${profiles.length}`)

const oldScores = []
const newScores = []
const pairs = []
const perProfile = new Map()

for (const { id: profileId, display_name } of profiles) {
  const profile = (await db.all(`SELECT * FROM profiles WHERE id = $1`, [profileId]))[0]
  if (!profile) continue
  const sections = {}
  for (const row of await db.all(`SELECT section_key, data FROM profile_sections WHERE profile_id = $1`, [profileId])) {
    try { sections[row.section_key] = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : (row.data || {}) } catch { sections[row.section_key] = {} }
  }
  const matches = await db.all(`
    SELECT m.id AS match_id, m.match_score AS old_score, o.*
    FROM profile_opportunity_matches m
    JOIN funding_opportunities o ON o.id = m.opportunity_id
    WHERE m.profile_id = $1`, [profileId])
  const rows = []
  for (const m of matches) {
    try {
      const d = computeMatchDecision(profile, m, { profileSections: sections })
      const ns = Math.round(Number(d?.score) || 0)
      const os = Number(m.old_score)
      newScores.push(ns)
      if (Number.isFinite(os)) { oldScores.push(os); pairs.push([os, ns]) }
      rows.push({ title: String(m.title || '').slice(0, 60), os, ns })
      const bd = d?.match_explain?.scoreBreakdown
      if (bd && !perProfile.has(profileId)) {
        perProfile.set(profileId, { name: display_name, total: bd.data_point_total })
      }
    } catch { /* count-only script; individual failures don't matter */ }
  }
  const pp = perProfile.get(profileId) || { name: display_name }
  pp.matches = rows.length
  pp.top = rows.sort((a, b) => b.ns - a.ns).slice(0, 3)
  perProfile.set(profileId, pp)
}

function pct(sorted, p) {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}
const sortedNew = [...newScores].sort((a, b) => a - b)
const sortedOld = [...oldScores].sort((a, b) => a - b)

console.log('\n── NEW-scale global distribution ──')
for (const p of [10, 25, 50, 75, 90, 95, 99]) console.log(`p${p}: ${pct(sortedNew, p)}`)
console.log(`max: ${sortedNew[sortedNew.length - 1]}  n=${sortedNew.length}`)

console.log('\n── Population-preserving bar mapping (old bar → new bar) ──')
for (const oldBar of [12, 15, 25, 50, 75]) {
  const share = oldScores.filter((s) => s >= oldBar).length / Math.max(1, oldScores.length)
  // new bar = the new score at the same upper-tail share
  const idx = Math.max(0, Math.floor((1 - share) * sortedNew.length))
  console.log(`old ≥${oldBar} keeps ${(share * 100).toFixed(1)}% of matches → new bar ≈ ${sortedNew[Math.min(idx, sortedNew.length - 1)]}`)
}

console.log('\n── Rank agreement (does the new model reorder?) ──')
let agree = 0
let comparisons = 0
for (let i = 0; i < Math.min(pairs.length, 5000); i++) {
  const j = (i * 7919) % pairs.length
  if (j === i) continue
  const [ao, an] = pairs[i]; const [bo, bn] = pairs[j]
  if (ao === bo || an === bn) continue
  comparisons++
  if (Math.sign(ao - bo) === Math.sign(an - bn)) agree++
}
console.log(`pairwise order agreement: ${comparisons ? ((agree / comparisons) * 100).toFixed(1) : 'n/a'}% (${comparisons} sampled pairs)`)

console.log('\n── Per-profile sanity preview (first 12) ──')
for (const [pid, pp] of [...perProfile.entries()].slice(0, 12)) {
  console.log(`\n${pp.name || pid} — inventory=${pp.total ?? '?'} matches=${pp.matches}`)
  for (const r of pp.top || []) console.log(`  old=${String(r.os).padStart(3)} new=${String(r.ns).padStart(3)}  ${r.title}`)
}

await client.end()
