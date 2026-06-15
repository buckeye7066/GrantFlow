#!/usr/bin/env node
/**
 * verify-onboarding-db-check.mjs
 *
 * After verify-onboarding-live.mjs runs, dig into the SQLite db and prove the
 * profile + sections + tags actually persisted. We separately verify matching
 * via crawler:doctor + opps:check; this script is the end-of-funnel proof.
 */

import { getDb } from '../backend/db/index.js'

const PROFILE_ID = process.argv[2]

async function main() {
  const db = await getDb()

  let profile
  if (PROFILE_ID) {
    profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(PROFILE_ID)
  } else {
    profile = await db
      .prepare(
        `SELECT * FROM profiles
           WHERE created_by = 'anya-onboarding'
           ORDER BY created_at DESC LIMIT 1`,
      )
      .get()
  }

  if (!profile) {
    console.error('[db-check] FAIL: no anya-onboarding profile found')
    process.exit(2)
  }

  const tags = profile.tags ? JSON.parse(profile.tags) : []
  console.log('[db-check] profile:', {
    id: profile.id,
    display_name: profile.display_name,
    primary_type: profile.primary_type,
    created_by: profile.created_by,
    status: profile.status,
    tag_count: tags.length,
    tags,
  })

  const user = await db.prepare('SELECT id, primary_email, has_completed_onboarding FROM users WHERE id = ?').get(profile.user_id)
  console.log('[db-check] user:', user)

  const sections = await db
    .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
    .all(profile.id)

  console.log(`[db-check] ${sections.length} sections:`)
  let totalKeys = 0
  for (const row of sections) {
    let parsed = {}
    try { parsed = JSON.parse(row.data) } catch { /* ignore */ }
    const keys = Object.keys(parsed)
    totalKeys += keys.length
    if (keys.length > 0) {
      console.log(`  ${row.section_key}: ${JSON.stringify(parsed)}`)
    }
  }

  // Hard contract: an Anya-onboarded profile MUST have:
  //  - a primary_type
  //  - tags
  //  - basic_information with zip + state
  //  - location_focus with focus_state
  const fail = []
  if (!profile.primary_type) fail.push('primary_type missing')
  if (!profile.display_name) fail.push('display_name missing')
  if (tags.length === 0) fail.push('tags empty')
  if (!user) fail.push('user row missing')

  const basicSection = sections.find((s) => s.section_key === 'basic_information')
  const basic = basicSection ? JSON.parse(basicSection.data) : {}
  if (!basic.zip_code) fail.push('basic_information.zip_code missing')
  if (!basic.state) fail.push('basic_information.state missing')
  if (!basic.email) fail.push('basic_information.email missing')

  const locationSection = sections.find((s) => s.section_key === 'location_focus')
  const location = locationSection ? JSON.parse(locationSection.data) : {}
  if (!location.focus_state) fail.push('location_focus.focus_state missing')

  if (fail.length > 0) {
    console.error('[db-check] FAIL:', fail.join('; '))
    process.exit(3)
  }

  console.log(`\n[db-check] OK: profile=${profile.id} sections=${sections.length} keys=${totalKeys} tags=${tags.length}`)
}

main().catch((err) => {
  console.error('[db-check] FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
