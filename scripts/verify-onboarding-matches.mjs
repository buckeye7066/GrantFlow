#!/usr/bin/env node
/**
 * Final assertion for the onboarding live verification: prove the matcher
 * surfaces real funding for the profile created by Anya's quiz.
 *
 * Mission goals 1, 8: real funding only, never zero results.
 */
import { getDb } from '../backend/db/index.js'
import { matchOpportunities, computeMatchDecision } from '../backend/services/matchEngine.js'

const PROFILE_ID = process.argv[2]

const db = await getDb()

const profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(PROFILE_ID)
if (!profile) { console.error('no profile'); process.exit(2) }

const sections = await db
  .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
  .all(profile.id)

const sectionMap = {}
for (const s of sections) {
  try { sectionMap[s.section_key] = JSON.parse(s.data) } catch { /* ignore */ }
}

const fullProfile = {
  ...profile,
  tags: profile.tags ? JSON.parse(profile.tags) : [],
  sections: sectionMap,
}

const opps = await db.prepare('SELECT * FROM funding_opportunities WHERE COALESCE(status, \'active\') = \'active\' LIMIT 200').all()

console.log(`[matches] running matchOpportunities against profile=${profile.id} primary_type=${profile.primary_type} opps=${opps.length}`)

const result = matchOpportunities(fullProfile, opps)

const list = Array.isArray(result) ? result : (result?.matches || result?.opportunities || [])
console.log(`[matches] returned ${list.length} scored opportunities`)

const included = list.filter(m => (m?.score ?? 0) > 0)
console.log(`[matches] ${included.length} included (score > 0)`)

const top = included.slice(0, 5)
for (const m of top) {
  console.log(`  - score=${m.score?.toFixed?.(2) ?? m.score} title=${m.title || m.name} reasons=${(m.reasons || []).slice(0, 3).join(', ')}`)
}

if (included.length === 0) {
  console.error('[matches] FAIL: zero included matches for newly onboarded profile')
  process.exit(3)
}

console.log(`[matches] OK: ${included.length} included matches surfaced for /start funnel profile`)
process.exit(0)
