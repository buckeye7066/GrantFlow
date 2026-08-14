/**
 * run-pipeline-cleanup-now.mjs
 *
 * ONE-TIME manual cleanup script. Run once to purge all irrelevant grants from
 * every profile pipeline using the canonical applyRelevanceFilter() from
 * backend/services/relevanceFilter.js.
 *
 * What gets removed:
 *   1. Grants that fail the hard relevance filter (wrong audience, entity type,
 *      veteran-only, business-only, nonprofit-only, university-only, FEMA/disaster,
 *      wrong-state geography, etc.)
 *   2. Wrong-state grants (title contains "near [City], [StateAbbr]" mismatching profile)
 *   3. Duplicate grants for the same profile (keeps first insertion, removes rest)
 *
 * Usage:
 *   node scripts/run-pipeline-cleanup-now.mjs
 *
 * Dry-run (no deletes, just logs what would be removed):
 *   DRY_RUN=1 node scripts/run-pipeline-cleanup-now.mjs
 *
 * DO NOT wire this to server startup or seedOnStartup. It is a one-time tool.
 */

import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'
import { applyRelevanceFilter } from '../backend/services/relevanceFilter.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.resolve(__dirname, '..', 'backend', 'data', 'grantflow.db')
const DRY_RUN = process.env.DRY_RUN === '1'

const db = new Database(DB_PATH)

// ─── State abbreviation helpers ──────────────────────────────────────────────

const STATE_ABBRS = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
])

function extractStateFromTitle(title) {
  const match = (title || '').match(/near\s+[\w\s]+,\s*([A-Z]{2})\b/)
  if (match && STATE_ABBRS.has(match[1])) return match[1]
  return null
}

// Map of state names in grant titles to their 2-letter abbreviation.
// Sorted by name length descending so multi-word names ("new york") match before
// single-word names ("new") — sorting once at module load avoids per-call sort.
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

/**
 * Detect a state name embedded in a program title.
 * "Ohio Family and Children First" → "OH"
 * "New York Tuition Assistance Program" → "NY"
 * "Texas Public Educational Grant" → "TX"
 */
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
  const comp = sections.comprehensive_application || {}

  const tryAddr = (addr) => {
    if (!addr) return null
    if (typeof addr === 'string') return (addr.match(/\b([A-Z]{2})\s*,?\s*\d{5}/) || [])[1] || null
    if (typeof addr === 'object') return addr.state || null
    return null
  }

  return (
    profile.state ||
    basic.state ||
    locFocus.state ||
    tryAddr(basic.address) ||
    tryAddr(comp.address) ||
    null
  )
}

function parseTags(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return [] }
  }
  return []
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log(`\n=== run-pipeline-cleanup-now.mjs (${DRY_RUN ? 'DRY RUN — no deletes' : 'LIVE — will delete'}) ===\n`)

const profiles = db.prepare('SELECT id, display_name, primary_type, tags FROM profiles').all()
console.log(`Found ${profiles.length} profiles.\n`)

const deleteStmt = db.prepare('DELETE FROM grants WHERE id = ?')
let totalAudited = 0
let totalRemoved = 0
const removalsByCategory = {}

function track(category) {
  removalsByCategory[category] = (removalsByCategory[category] || 0) + 1
}

for (const profile of profiles) {
  // Load all grants for this profile (by profile_id or via the organization it belongs to)
  const grants = db.prepare(`
    SELECT id, title, funder, notes, created_at
    FROM grants
    WHERE profile_id = ?
       OR organization_id IN (
         SELECT organization_id FROM profiles WHERE id = ? AND organization_id IS NOT NULL
       )
    ORDER BY created_at ASC
  `).all(profile.id, profile.id)

  if (grants.length === 0) continue

  const beforeCount = grants.length

  // Load profile sections
  const sections = {}
  const sectionRows = db.prepare(
    'SELECT section_key, data FROM profile_sections WHERE profile_id = ?'
  ).all(profile.id)
  for (const row of sectionRows) {
    try { sections[row.section_key] = JSON.parse(row.data) } catch { sections[row.section_key] = {} }
  }

  const basic = sections.basic_information || {}
  const demographics = sections.demographics || {}
  const military = sections.military_service || {}
  const health = sections.health_medical || {}
  const family = sections.family_life || {}

  const profileState = extractProfileState(profile, sections)

  // Normalize veteran_status: the seed stores "Veteran" (string); the filter needs a boolean
  const rawVeteran = demographics.veteran_status || military.veteran || null
  const veteranStatus = (rawVeteran === true || /^veteran/i.test(String(rawVeteran || ''))) ? true : null

  // Build the profileData object expected by applyRelevanceFilter()
  const profileData = {
    primary_type: profile.primary_type || null,
    veteran_status: veteranStatus,
    immigrant_status: demographics.immigrant_status || null,
    disability_status: demographics.disability_status || health.disability_type || null,
    foster_youth: family.foster_youth || null,
    first_responder: null, // no dedicated profile section for first responders yet
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

    // 1. Duplicate check — keep first occurrence per profile, remove rest
    if (seenTitles.has(titleNorm)) {
      toDelete.push({ id: grant.id, title: grant.title, reason: 'duplicate title' })
      track('duplicate')
      continue
    }
    seenTitles.add(titleNorm)

    // 2. Wrong-state check:
    //    a) "near [City], [StateAbbr]" pattern in title
    //    b) State name embedded in program title (e.g. "Ohio Family and Children First")
    if (profileState) {
      const grantState =
        extractStateFromTitle(grant.title || '') ||
        extractStateNameFromTitle(grant.title || '')
      if (grantState && grantState !== profileState) {
        toDelete.push({
          id: grant.id,
          title: grant.title,
          reason: `wrong state: grant is ${grantState}, profile is ${profileState}`,
        })
        track('wrong_state')
        continue
      }
    }

    // 3. Full canonical relevance filter
    // Build an opportunity object so the filter can inspect all fields.
    const opportunity = {
      title: grant.title || '',
      description: grant.notes || '',
      sponsor: grant.funder || '',
      keywords: [],
      categories: [],
      eligibility_bullets: [],
      state: null, // title-based state check already handled above
      is_national: true, // treat as national so geo check in filter is skipped (done above)
    }

    const result = applyRelevanceFilter(opportunity, profileData)
    if (!result.pass) {
      toDelete.push({ id: grant.id, title: grant.title, reason: result.reason })
      track('relevance_filter')
      continue
    }
  }

  if (toDelete.length > 0) {
    const afterCount = beforeCount - toDelete.length
    console.log(
      `── ${profile.display_name || profile.id} ` +
      `(type=${profile.primary_type || '?'}, state=${profileState || '?'}) ` +
      `— before: ${beforeCount}, removing: ${toDelete.length}, after: ${afterCount}`,
    )
    for (const g of toDelete) {
      console.log(`   ✕ "${g.title}" — ${g.reason}`)
      if (!DRY_RUN) deleteStmt.run(g.id)
    }
    totalRemoved += toDelete.length
    console.log('')
  }
}

console.log(`\n=== Summary ===`)
console.log(`Mode:             ${DRY_RUN ? 'DRY RUN (no changes made)' : 'LIVE (deletions applied)'}`)
console.log(`Profiles audited: ${profiles.length}`)
console.log(`Grants audited:   ${totalAudited}`)
console.log(`Grants ${DRY_RUN ? 'flagged' : 'removed'}:  ${totalRemoved}`)
console.log(`Breakdown:`)
for (const [cat, count] of Object.entries(removalsByCategory)) {
  console.log(`  ${cat}: ${count}`)
}
if (DRY_RUN) {
  console.log(`\nRe-run without DRY_RUN=1 to actually delete these grants.`)
}

db.close()
