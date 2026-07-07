/**
 * Migrate free-text needs/interests/focus_areas → controlled tags (NON-DESTRUCTIVE).
 *
 * Owner directive 2026-07-07 (profile schema redesign): funding-needs, interests,
 * and programs_services.focus_areas are now controlled TAG fields whose values are
 * sourced from the matcher's own vocabulary (backend/config/profileVocabulary.js).
 * This script maps each existing free-text value to its nearest canonical tag
 * where confident, and KEEPS any value it cannot confidently map as a custom tag.
 * No value is ever dropped.
 *
 * Fields migrated:
 *   - financial_information.funding_needs  (string OR array) → needs tags
 *   - programs_services.focus_areas        (array)           → focus tags
 *   - programs_services.interests          (array)           → focus tags
 *
 * DRY-RUN by default (prints a plan, mutates nothing). Pass --apply to write.
 *
 *   node backend/scripts/migrate-freetext-to-tags.mjs            # dry-run
 *   node backend/scripts/migrate-freetext-to-tags.mjs --apply    # write
 *   railway ssh "node backend/scripts/migrate-freetext-to-tags.mjs --apply"
 */

import { db } from '../db/index.js'
import { mapFreeTextToNeedTag, mapFreeTextToFocusTag } from '../config/profileVocabulary.js'

const APPLY = process.argv.includes('--apply')

function safeParse(raw) {
  try {
    return typeof raw === 'object' && raw ? raw : JSON.parse(raw || '{}')
  } catch {
    return null
  }
}

/** Split a free-text field into candidate tokens (comma/semicolon/newline). */
function toTokens(value) {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

/**
 * Map a list of free-text tokens to canonical tags, keeping unmatched tokens as
 * custom tags. Returns { tags, mapped, kept } where mapped/kept are for reporting.
 * Never drops a value.
 */
function migrateTokens(tokens, mapper) {
  const out = []
  const seen = new Set()
  const mapped = []
  const kept = []
  for (const token of tokens) {
    const canonical = mapper(token)
    const value = canonical || token
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (canonical) mapped.push({ from: token, to: canonical })
    else kept.push(token)
  }
  return { tags: out, mapped, kept }
}

function sameArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

async function main() {
  const rows = await db
    .prepare(
      `SELECT profile_id, section_key, data FROM profile_sections
       WHERE section_key IN ('financial_information', 'programs_services')`,
    )
    .all()

  const plans = []
  for (const row of rows) {
    const data = safeParse(row.data)
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const next = { ...data }
    let changed = false
    const changes = []

    if (row.section_key === 'financial_information' && data.funding_needs != null) {
      const tokens = toTokens(data.funding_needs)
      if (tokens.length) {
        const { tags, mapped, kept } = migrateTokens(tokens, mapFreeTextToNeedTag)
        // Change if it wasn't already an equal array of these tags.
        if (!sameArray(data.funding_needs, tags)) {
          next.funding_needs = tags
          changed = true
          changes.push({ field: 'funding_needs', from: data.funding_needs, to: tags, mapped, kept })
        }
      }
    }

    if (row.section_key === 'programs_services') {
      for (const field of ['focus_areas', 'interests']) {
        if (data[field] == null) continue
        const tokens = toTokens(data[field])
        if (!tokens.length) continue
        const { tags, mapped, kept } = migrateTokens(tokens, mapFreeTextToFocusTag)
        if (!sameArray(data[field], tags)) {
          next[field] = tags
          changed = true
          changes.push({ field, from: data[field], to: tags, mapped, kept })
        }
      }
    }

    if (changed) plans.push({ profile_id: row.profile_id, section_key: row.section_key, next, changes })
  }

  if (APPLY) {
    let updated = 0
    for (const plan of plans) {
      db.prepare('UPDATE profile_sections SET data = ? WHERE profile_id = ? AND section_key = ?').run(
        JSON.stringify(plan.next),
        plan.profile_id,
        plan.section_key,
      )
      updated += 1
    }
    console.log(
      JSON.stringify(
        { mode: 'apply', sections_scanned: rows.length, sections_updated: updated, plans },
        null,
        2,
      ),
    )
  } else {
    console.log(
      JSON.stringify(
        {
          mode: 'dry-run',
          note: 'No changes written. Re-run with --apply to persist. No value is ever dropped; unmatched free text is kept as a custom tag.',
          sections_scanned: rows.length,
          sections_to_update: plans.length,
          plans,
        },
        null,
        2,
      ),
    )
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('migration failed:', err?.message || err)
    process.exit(1)
  })
