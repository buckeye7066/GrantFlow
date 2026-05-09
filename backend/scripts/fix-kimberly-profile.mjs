#!/usr/bin/env node
/**
 * fix-kimberly-profile.mjs
 *
 * One-time data correction so Kimberly Botts's profile globally
 * reflects reality (Goal 2 — match actual needs, Goal 3 — use the full
 * profile, Goal 9 — explainable). Earlier seeds carried a fictional
 * "small business owner / nonprofit founder / entrepreneur" persona
 * which caused the matcher to chase entrepreneurship grants for an
 * adult enrolled in TN's ECF CHOICES Medicaid HCBS waiver who is
 * unable to work. The user reported they could not delete the
 * "nonprofit employee and small business owner" prose from her
 * Occupational notes.
 *
 * The shared code path that prevented manual deletes was fixed in
 * `shared/profileSuggestionGuards.js` (dedupeLongText now honours an
 * explicit user clear). This script applies the corresponding data
 * correction so the live profile matches the seed truth on every
 * deployment that already has the stale data.
 *
 * Idempotent — safe to run multiple times. Targets only the sections
 * the user explicitly identified as wrong:
 *   - profiles.tags                 → drop 'entrepreneur', add disability flags
 *   - profile_sections.occupation   → REPLACE with truth (all flags FALSE,
 *                                     accurate notes)
 *   - profile_sections.narrative    → REPLACE with truth (HCBS waiver,
 *                                     ECF CHOICES focus)
 *   - profile_sections.employment   → REPLACE / INSERT current_status =
 *                                     'unable_to_work'
 *   - profile_sections.demographics → MERGE in disability_status:true
 *   - profile_sections.government_assistance → MERGE in ssi_recipient_self:
 *                                     true
 *
 * Other sections are left alone so any user edits already in place
 * survive.
 *
 * Usage:
 *   node backend/scripts/fix-kimberly-profile.mjs           # dry-run
 *   node backend/scripts/fix-kimberly-profile.mjs --apply   # write
 */
import { db } from '../db/index.js'
import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'

const KIMBERLY_ID = 'profile-kimberly-botts'
const apply = process.argv.includes('--apply')

function findSeed() {
  return DESIGNATED_PROFILES.find((p) => p.id === KIMBERLY_ID) ?? null
}

function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value)) ?? fallback
  } catch {
    return fallback
  }
}

async function getExistingSection(profileId, sectionKey) {
  const row = await db
    .prepare(
      'SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?',
    )
    .get(profileId, sectionKey)
  return row ? safeJson(row.data, {}) : null
}

async function upsertSection(profileId, sectionKey, data) {
  const existing = await db
    .prepare(
      'SELECT id FROM profile_sections WHERE profile_id = ? AND section_key = ?',
    )
    .get(profileId, sectionKey)
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE profile_sections
            SET data = ?, updated_by = 'fix-kimberly-script', updated_at = CURRENT_TIMESTAMP
          WHERE profile_id = ? AND section_key = ?`,
      )
      .run(JSON.stringify(data), profileId, sectionKey)
    return 'updated'
  }
  // INSERT — generate an id (UUID-ish; better-sqlite3 has no native UUID)
  const id = (await import('crypto')).randomUUID()
  await db
    .prepare(
      `INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by, updated_at)
       VALUES (?, ?, ?, ?, 'fix-kimberly-script', CURRENT_TIMESTAMP)`,
    )
    .run(id, profileId, sectionKey, JSON.stringify(data))
  return 'inserted'
}

async function main() {
  console.log(`[fix-kimberly] mode=${apply ? 'APPLY' : 'DRY RUN'}`)
  const seed = findSeed()
  if (!seed) {
    console.error('[fix-kimberly] FATAL: Kimberly seed not found in DESIGNATED_PROFILES — aborting.')
    process.exit(1)
  }

  const profile = await db
    .prepare('SELECT id, display_name, tags FROM profiles WHERE id = ?')
    .get(KIMBERLY_ID)
  if (!profile) {
    console.error(`[fix-kimberly] No profile row found with id="${KIMBERLY_ID}". Run designated-profile seed first.`)
    process.exit(1)
  }

  const currentTags = safeJson(profile.tags, [])
  const desiredTags = Array.isArray(seed.tags) ? seed.tags : []
  const tagsChanged = JSON.stringify(currentTags) !== JSON.stringify(desiredTags)

  // REPLACE-style sections: occupation, narrative, employment.
  // These contained the fictional entrepreneur persona that the user
  // explicitly rejected — the seed is the new ground truth.
  const REPLACE_SECTIONS = ['occupation', 'narrative', 'employment']

  // MERGE-style sections: demographics, government_assistance,
  // family_life. We add the disability / SSI signals without
  // wiping any other field the user may have already corrected.
  const MERGE_SECTIONS = ['demographics', 'government_assistance', 'family_life']

  const plan = []

  for (const sectionKey of REPLACE_SECTIONS) {
    const seedData = seed.sections?.[sectionKey]
    if (!seedData) continue
    const existing = await getExistingSection(profile.id, sectionKey)
    const sameAsSeed = existing && JSON.stringify(existing) === JSON.stringify(seedData)
    plan.push({
      sectionKey,
      mode: 'replace',
      existing,
      next: seedData,
      changed: !sameAsSeed,
    })
  }

  for (const sectionKey of MERGE_SECTIONS) {
    const seedData = seed.sections?.[sectionKey]
    if (!seedData) continue
    const existing = (await getExistingSection(profile.id, sectionKey)) ?? {}
    const merged = { ...existing, ...seedData }
    const changed = JSON.stringify(existing) !== JSON.stringify(merged)
    plan.push({ sectionKey, mode: 'merge', existing, next: merged, changed })
  }

  console.log(
    `[fix-kimberly] Tags: current=${JSON.stringify(currentTags)}, desired=${JSON.stringify(desiredTags)}, changed=${tagsChanged}`,
  )
  for (const step of plan) {
    console.log(`[fix-kimberly] ${step.sectionKey} (${step.mode}): changed=${step.changed}`)
    if (step.changed) {
      console.log(`    BEFORE: ${JSON.stringify(step.existing)}`)
      console.log(`    AFTER:  ${JSON.stringify(step.next)}`)
    }
  }

  if (!apply) {
    console.log('[fix-kimberly] DRY RUN — re-run with --apply to write changes.')
    return
  }

  if (tagsChanged) {
    await db
      .prepare(`UPDATE profiles SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(JSON.stringify(desiredTags), profile.id)
  }
  for (const step of plan) {
    if (!step.changed) continue
    const action = await upsertSection(profile.id, step.sectionKey, step.next)
    console.log(`[fix-kimberly] ${step.sectionKey} → ${action}`)
  }

  console.log('[fix-kimberly] Done.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[fix-kimberly] FATAL:', err)
    process.exit(1)
  })
