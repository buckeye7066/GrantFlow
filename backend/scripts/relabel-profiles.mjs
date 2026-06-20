#!/usr/bin/env node
/**
 * relabel-profiles.mjs
 *
 * Audit EVERY profile and set the correct canonical `primary_type` from its own
 * data. This is the one-time data-quality sweep that backs the owner's decision
 * that the billed tier (and section applicability, crawler planning,
 * eligibility) follows a profile's TYPE — so the types must actually be right.
 *
 * It is CONSERVATIVE: it proposes a change only from (a) owner-specified known
 * fixes and (b) high-signal display-NAME keywords. It deliberately does NOT
 * infer "student" from the education section, because that section is polluted
 * with boilerplate defaults (valedictorian / pell_grant_eligible /
 * fafsa_completed) on plainly non-student profiles — an unreliable signal that
 * mis-tagged a PT business, the admin vault, and a fire department as students
 * in the first dry run. It never invents a type that is not a canonical id in
 * shared/profileTypeOptions.js / backend/services/profileTypeRegistry.js.
 *
 * Usage (run IN-CONTAINER on prod so DATABASE_URL points at Postgres):
 *   node backend/scripts/relabel-profiles.mjs            # DRY RUN (default, safe)
 *   node backend/scripts/relabel-profiles.mjs --apply    # actually UPDATE rows
 *
 * The script always uses the canonical backend/db/index.js, so it behaves the
 * same locally (SQLite) and in production (Postgres).
 */
import { db } from '../db/index.js'
import { resolveProfileType } from '../services/profileTypeRegistry.js'

const APPLY = process.argv.includes('--apply')

// ── Known, owner-specified fixes keyed by profile id ────────────────────────
// These override the heuristics (owner judgment already made).
const KNOWN_FIXES = Object.freeze({
  // Anastasia — currently 'caregiver', is actually a student.
  'c4a92724-9cee-416f-ba30-e91b9b5cd885': 'student',
})

// ── Name-keyword heuristics → canonical primary_type ────────────────────────
// Ordered: the FIRST rule that matches the (lowercased) display name wins.
// Keep these conservative — only high-signal keywords on the ORGANIZATION/NAME
// axis. We deliberately do NOT infer "student" from profile sections: the
// education section is polluted with boilerplate defaults (valedictorian,
// pell_grant_eligible, fafsa_completed) on non-student profiles, so it is not a
// trustworthy signal. Student relabels come from the owner-specified KNOWN_FIXES
// only.
const NAME_RULES = [
  // Booster / parent / band / foundation groups attached to a school are
  // nonprofits, NOT the school itself — must run BEFORE the school rule.
  { type: 'nonprofit', re: /\b(band|booster(s)?|pta|pto|parent[- ]teacher|alumni|foundation|club|society|guild)\b/ },
  // Faith / nonprofit
  { type: 'nonprofit', re: /\b(church|ministry|ministries|cogop|cog op|c\.o\.g|assembly|tabernacle|chapel|congregation|parish|fellowship|charit(y|ies)|nonprofit|non-profit|501c3|outreach|mission(s)?)\b/ },
  // Government / civic — flagged for owner (could be a more specific public type)
  { type: 'organization', re: /\b(fire department|police department|sheriff|department|district|municipal(ity)?|city of|town of|township|borough|authority|commission|board of|bureau)\b/, flag: 'government/civic — owner may pick a more specific public type (e.g. volunteer_fire_department, municipality)' },
  // Schools (actual school sites — boosters/bands already handled above)
  { type: 'school', re: /\b(high school|elementary school|middle school|academy|isd|usd)\b/ },
  // Obvious businesses
  { type: 'organization', re: /\b(llc|inc\.?|incorporated|corp\.?|corporation|company|enterprises?|holdings|ventures|consulting|industries)\b/, flag: 'looks like a business — verify organization/business' },
]

function lc(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * A name with two or three capitalized words and no org keyword looks like a
 * person. (Conservative — used only to KEEP individuals as individual, never to
 * downgrade an org.)
 */
function looksLikePersonName(name) {
  const n = String(name ?? '').trim()
  if (!n) return false
  if (/[,&/]|llc|inc|corp|dept|department|school|church|ministr/i.test(n)) return false
  const words = n.split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.length > 4) return false
  return words.every((w) => /^[A-Z][A-Za-z'.-]*$/.test(w))
}

/**
 * Decide the canonical primary_type for a profile from its data. Returns
 * { proposed, reason, flag } or null when no confident change is warranted.
 */
function decideType(profile) {
  const current = profile.primary_type || ''
  const currentCanonical = resolveProfileType(current) || current
  const name = lc(profile.display_name)

  // 1. Owner-specified known fix (highest priority).
  if (KNOWN_FIXES[profile.id]) {
    return { proposed: KNOWN_FIXES[profile.id], reason: 'owner-specified known fix' }
  }

  // 2. Name keyword rules (high-signal organization/name axis only).
  for (const rule of NAME_RULES) {
    if (rule.re.test(name)) {
      if (currentCanonical === rule.type) return null // already correct
      return { proposed: rule.type, reason: `name matches ${rule.type} keyword`, flag: rule.flag }
    }
  }

  // 3. Person-named profile with a non-canonical / legacy individual-ish type →
  //    individual (keep them, don't lose them; mission rule).
  const LEGACY_INDIVIDUALISH = new Set(['caregiver', 'senior', 'individual_need', 'person', 'adult'])
  if (looksLikePersonName(profile.display_name) && LEGACY_INDIVIDUALISH.has(lc(current))) {
    return { proposed: 'individual', reason: 'legacy individual-ish type on a person name' }
  }

  return null
}

async function main() {
  console.log(`[relabel-profiles] mode=${APPLY ? 'APPLY' : 'DRY RUN'} dialect=${db.dialect}`)
  console.log('')

  const profiles = await db
    .prepare('SELECT id, display_name, primary_type, organization_id FROM profiles ORDER BY display_name ASC')
    .all()

  const changes = []
  for (const p of profiles) {
    const decision = decideType(p)
    if (!decision) continue
    const oldType = p.primary_type || '(none)'
    if (lc(oldType) === lc(decision.proposed)) continue
    changes.push({ id: p.id, name: p.display_name, old: oldType, new: decision.proposed, reason: decision.reason, flag: decision.flag })
  }

  console.log(`Total profiles: ${profiles.length}`)
  console.log(`Proposed changes: ${changes.length}`)
  console.log('')

  for (const c of changes) {
    const flag = c.flag ? `  ⚑ ${c.flag}` : ''
    console.log(`  ${c.id}  "${c.name}"`)
    console.log(`     ${c.old} → ${c.new}   (${c.reason})${flag}`)
  }
  console.log('')

  if (!APPLY) {
    console.log('DRY RUN — no rows changed. Re-run with --apply to execute.')
    return
  }

  let applied = 0
  for (const c of changes) {
    await db
      .prepare('UPDATE profiles SET primary_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(c.new, c.id)
    applied += 1
  }
  console.log(`APPLIED ${applied} profile type updates.`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[relabel-profiles] FAILED:', err?.stack || err?.message || err)
    process.exit(1)
  })
