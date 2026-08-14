/**
 * cleanup-all-profiles-pipeline.mjs
 *
 * Comprehensive audit of ALL profile pipelines. Removes:
 * 1. Grants that fail hard relevance filter (veteran, business, nonprofit, university, etc.)
 * 2. Wrong-state grants (title says "near [City], [StateAbbr]" but profile is in different state)
 * 3. Duplicate grants (same title for same profile — keeps first, removes rest)
 * 4. Federal/institutional grants that are not for individuals
 *
 * Usage:  node scripts/cleanup-all-profiles-pipeline.mjs
 * Dry-run: DRY_RUN=1 node scripts/cleanup-all-profiles-pipeline.mjs
 */

import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'
import { applyRelevanceFilter } from '../backend/services/relevanceFilter.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.resolve(__dirname, '..', 'backend', 'data', 'grantflow.db')
const DRY_RUN = process.env.DRY_RUN === '1'

const db = new Database(DB_PATH)

const STATE_ABBRS = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
])

function extractStateFromTitle(title) {
  const match = title.match(/near\s+[\w\s]+,\s*([A-Z]{2})\b/)
  if (match && STATE_ABBRS.has(match[1])) return match[1]
  return null
}

const STATE_NAME_TO_ABBR_ENTRIES = [
  ['alabama', 'AL'], ['alaska', 'AK'], ['arizona', 'AZ'], ['arkansas', 'AR'],
  ['california', 'CA'], ['colorado', 'CO'], ['connecticut', 'CT'], ['delaware', 'DE'],
  ['florida', 'FL'], ['georgia', 'GA'], ['hawaii', 'HI'], ['idaho', 'ID'],
  ['illinois', 'IL'], ['indiana', 'IN'], ['iowa', 'IA'], ['kansas', 'KS'],
  ['kentucky', 'KY'], ['louisiana', 'LA'], ['maine', 'ME'], ['maryland', 'MD'],
  ['massachusetts', 'MA'], ['michigan', 'MI'], ['minnesota', 'MN'], ['mississippi', 'MS'],
  ['missouri', 'MO'], ['montana', 'MT'], ['nebraska', 'NE'], ['nevada', 'NV'],
  ['new hampshire', 'NH'], ['new jersey', 'NJ'], ['new mexico', 'NM'], ['new york', 'NY'],
  ['north carolina', 'NC'], ['north dakota', 'ND'], ['ohio', 'OH'], ['oklahoma', 'OK'],
  ['oregon', 'OR'], ['pennsylvania', 'PA'], ['rhode island', 'RI'], ['south carolina', 'SC'],
  ['south dakota', 'SD'], ['tennessee', 'TN'], ['texas', 'TX'], ['utah', 'UT'],
  ['vermont', 'VT'], ['virginia', 'VA'], ['washington', 'WA'], ['west virginia', 'WV'],
  ['wisconsin', 'WI'], ['wyoming', 'WY'],
].sort((a, b) => b[0].length - a[0].length)

// A state NAME used as the name of a COUNTY/CITY/PARISH is a place inside
// some OTHER state, not a claim about this one ("Delaware County, OH",
// "Washington County, PA", "Indiana County, PA" are all real places a bare
// substring test resolved to DE/WA/IN). Mirrors the fix already applied in
// backend/services/relevanceFilterRules.js's _extractStateNameFromTitle --
// this script forked from the same original bare-substring implementation.
const PLACE_QUALIFIER_AFTER_STATE_NAME =
  /^\s*(county|counties|parish|borough|municipio|city|township|village|town|district)\b/i

function extractStateNameFromTitle(title) {
  const raw = String(title || '')
  const lower = raw.toLowerCase()
  for (const [name, abbr] of STATE_NAME_TO_ABBR_ENTRIES) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(name, from)
      if (at === -1) break
      const before = at === 0 ? '' : lower[at - 1]
      const after = lower.slice(at + name.length)
      const boundedLeft = at === 0 || !/[a-z0-9]/.test(before)
      const boundedRight = after === '' || !/^[a-z0-9]/.test(after)
      if (boundedLeft && boundedRight && !PLACE_QUALIFIER_AFTER_STATE_NAME.test(after)) return abbr
      from = at + 1
    }
  }
  return null
}

function extractProfileState(profile, sections) {
  const basic = sections.basic_information || {}
  const locFocus = sections.location_focus || {}
  const addr = basic.address
  let stateFromAddr = null
  if (typeof addr === 'string') {
    stateFromAddr = (addr.match(/\b([A-Z]{2})\s*,?\s*\d{5}/) || [])[1] || null
  } else if (addr && typeof addr === 'object') {
    stateFromAddr = addr.state || null
  }
  const comp = sections.comprehensive_application || {}
  const compAddr = comp.address
  let stateFromComp = null
  if (typeof compAddr === 'string') {
    stateFromComp = (compAddr.match(/\b([A-Z]{2})\s*,?\s*\d{5}/) || [])[1] || null
  } else if (compAddr && typeof compAddr === 'object') {
    stateFromComp = compAddr.state || null
  }
  return profile.state || basic.state || locFocus.state || stateFromAddr || stateFromComp || null
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log(`\n=== Pipeline Audit & Cleanup (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`)

const profiles = db.prepare('SELECT id, display_name, primary_type, tags FROM profiles').all()
console.log(`Found ${profiles.length} profiles.\n`)

function parseTags(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return [] }
  }
  return []
}

const deleteStmt = db.prepare('DELETE FROM grants WHERE id = ?')
let totalRemoved = 0
let totalAudited = 0
const removalsByCategory = {}

function track(category) {
  removalsByCategory[category] = (removalsByCategory[category] || 0) + 1
}

for (const profile of profiles) {
  const grants = db.prepare(`
    SELECT id, title, funder, created_at FROM grants 
    WHERE profile_id = ? OR organization_id IN (
      SELECT organization_id FROM profiles WHERE id = ? AND organization_id IS NOT NULL
    )
    ORDER BY created_at ASC
  `).all(profile.id, profile.id)
  if (grants.length === 0) continue

  const sections = {}
  const sectionRows = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id)
  for (const row of sectionRows) {
    try { sections[row.section_key] = JSON.parse(row.data) } catch { sections[row.section_key] = {} }
  }

  const basic = sections.basic_information || {}
  const demographics = sections.demographics || {}
  const military = sections.military_service || {}
  const health = sections.health_medical || {}
  const family = sections.family_life || {}

  const profileState = extractProfileState({ state: null }, sections)
  const rawVeteran = demographics.veteran_status || military.veteran || null
  const veteranStatus = (rawVeteran === true || /^veteran/i.test(String(rawVeteran || ''))) ? true : null
  const profileData = {
    primary_type: profile.primary_type || null,
    veteran_status: veteranStatus,
    immigrant_status: demographics.immigrant_status || null,
    disability_status: demographics.disability_status || health.disability_type || null,
    foster_youth: family.foster_youth || null,
    first_responder: null,
    gender: basic.gender || demographics.gender || null,
    age: basic.age || demographics.age || null,
    state: profileState,
    tags: parseTags(profile.tags),
    employment: sections.employment || {},
    education: sections.education || {},
  }

  const toDelete = []
  const seenTitles = new Set()

  for (const grant of grants) {
    totalAudited++
    const titleNorm = (grant.title || '').trim()

    // 1. Duplicate check (keep first occurrence)
    if (seenTitles.has(titleNorm)) {
      toDelete.push({ id: grant.id, title: grant.title, reason: 'duplicate title' })
      track('duplicate')
      continue
    }
    seenTitles.add(titleNorm)

    // 2. Wrong-state check (both "near [City], ST" pattern and state-name-in-title)
    if (profileState) {
      const grantState =
        extractStateFromTitle(grant.title || '') ||
        extractStateNameFromTitle(grant.title || '')
      if (grantState && grantState !== profileState) {
        toDelete.push({ id: grant.id, title: grant.title, reason: `wrong state: grant is ${grantState}, profile is ${profileState}` })
        track('wrong_state')
        continue
      }
    }

    // 3. Canonical relevance filter — build an opportunity object so all rules run correctly
    const opportunity = {
      title: grant.title || '',
      description: grant.funder || '',
      sponsor: grant.funder || '',
      keywords: [],
      categories: [],
      eligibility_bullets: [],
      state: null,
      is_national: true, // geo check already handled above via state-name-in-title
    }
    const result = applyRelevanceFilter(opportunity, profileData)
    if (!result.pass) {
      toDelete.push({ id: grant.id, title: grant.title, reason: result.reason })
      track('relevance_filter')
      continue
    }
  }

  if (toDelete.length > 0) {
    console.log(`── ${profile.display_name || profile.id} (${profile.primary_type || '?'}, ${profileState || '?'}) — ${grants.length} grants, ${toDelete.length} to remove:`)
    for (const g of toDelete) {
      console.log(`   ✕ "${g.title}" — ${g.reason}`)
      if (!DRY_RUN) deleteStmt.run(g.id)
    }
    totalRemoved += toDelete.length
    console.log('')
  }
}

console.log(`\n=== Summary ===`)
console.log(`Profiles audited: ${profiles.length}`)
console.log(`Grants audited: ${totalAudited}`)
console.log(`Grants ${DRY_RUN ? 'flagged' : 'removed'}: ${totalRemoved}`)
console.log(`Breakdown:`, JSON.stringify(removalsByCategory, null, 2))
if (DRY_RUN) console.log(`\nRe-run without DRY_RUN=1 to actually delete.`)

db.close()
