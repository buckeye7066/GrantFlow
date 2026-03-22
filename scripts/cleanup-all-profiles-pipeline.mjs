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

// ─── Relevance filter (same rules as backend/services/relevanceFilter.js) ───

function applyRelevanceFilter(oppText, profileData) {
  const profileType = (profileData.primary_type || '').toLowerCase()

  // Entity type: individual-only for orgs
  if (profileType === 'organization') {
    if (/\b(snap|food stamps|tanf|wic|ssdi|ssi\b|medicaid enrollment|section 8|housing voucher)\b/i.test(oppText)) {
      return { pass: false, reason: 'individual-only program for organization' }
    }
  }

  // Veteran-focused
  const isVet = profileData.veteran_status === true || profileData.veteran_status === 'yes' || profileData.veteran_status === 'true'
  if (/\b(ssvf|supportive services for veteran|veterans? only|must be a veteran|boots to business|veteran entrepreneurship|veterans? (assistance|support|services|program|families))\b/i.test(oppText) && !isVet) {
    return { pass: false, reason: 'veteran-focused, profile is not a veteran' }
  }

  // Refugee/resettlement
  if (/\b(refugee resettlement|for refugees only|office of refugee|refugee assistance|irc.{0,5}resettlement)\b/i.test(oppText)) {
    const hasImmigrant = profileData.immigrant_status && profileData.immigrant_status !== 'no' && profileData.immigrant_status !== 'false'
    if (!hasImmigrant) return { pass: false, reason: 'refugee-specific, no immigrant indicator' }
  }

  // Business/SBA for non-business
  const isBiz = ['small_business', 'organization', 'nonprofit'].includes(profileType)
  if (/\b(sba\b|small business (administration|development|innovation|grants?|resources?|funding)|sbir\b|sttr\b|entrepreneur(ship)?( training| center| program)?|minority business development|business development grant|usda (rural )?business|community advantage program|8\(a\) business|women.owned small business|wosb\b|liftfund|nase growth grant|kiva u\.?s\.?|crowdfunded business|value.added producer grant|vapg\b|native cdfi|indigenous business|self.employment assistance)\b/i.test(oppText) && !isBiz) {
    return { pass: false, reason: 'business/SBA program for non-business profile' }
  }

  // Nonprofit-only
  const isNP = ['organization', 'nonprofit'].includes(profileType)
  if (/\b(for nonprofits|philanthropy for nonprofits|grants? for nonprofits|nonprofit.only)\b/i.test(oppText) && !isNP) {
    return { pass: false, reason: 'nonprofit-specific for non-nonprofit profile' }
  }

  // University/college for non-students
  const isStudent = ['student', 'high_school_student', 'college_student'].includes(profileType)
  if (/\b(university\s*[—–-]\s*|college\s*[—–-]\s*|institutional scholarship|college.{0,20}financial aid|university.{0,20}financial aid|college.{0,20}housing|university.{0,20}housing|off.campus resources?|community college.{0,30}(aid|grant|scholarship|resource))\b/i.test(oppText) && !isStudent) {
    return { pass: false, reason: 'university/college program for non-student' }
  }

  // FEMA/disaster for non-disaster profiles
  if (/\b(fema individual assistance|fema disaster (relief|assistance|grant)|disaster (relief|assistance) grant|individual.*assistance.*disaster|ihp\b|individuals and households program)\b/i.test(oppText)) {
    const hasFEMA = (Array.isArray(profileData.tags) && profileData.tags.some(t => /disaster|fema|emergency|flood|fire|tornado|hurricane|storm/i.test(String(t)))) ||
      (profileData.primary_type || '').toLowerCase() === 'disaster_survivor'
    if (!hasFEMA) return { pass: false, reason: 'FEMA/disaster program, no disaster indicator' }
  }

  // Foster care youth
  if (/\b(foster.?club|youth aging out|foster care youth|aging out of foster)\b/i.test(oppText)) {
    const hasFoster = Array.isArray(profileData.tags) && profileData.tags.some(t => /foster/i.test(String(t)))
    if (!hasFoster) return { pass: false, reason: 'foster youth program, no foster indicator' }
  }

  // First responder
  if (/\b(first responder(s)?( children)?( foundation)?)\b/i.test(oppText)) {
    const hasFR = Array.isArray(profileData.tags) && profileData.tags.some(t => /first.?respond|firefight|emt|paramedic/i.test(String(t)))
    if (!hasFR) return { pass: false, reason: 'first responder program, no indicator' }
  }

  // Blind-specific
  if (/\b(for the blind|national federation of the blind|american foundation for the blind|visual impairment support)\b/i.test(oppText)) {
    const hasVisual = (Array.isArray(profileData.tags) && profileData.tags.some(t => /blind|visual/i.test(String(t)))) ||
      (profileData.disability_status && JSON.stringify(profileData.disability_status).toLowerCase().includes('visual'))
    if (!hasVisual) return { pass: false, reason: 'blindness-specific, no visual impairment' }
  }

  // Federal institutional grants not for individuals
  const isIndividual = ['individual', 'individual_need', 'family', 'medical_assistance'].includes(profileType)
  if (isIndividual) {
    const fedInstitutionalPattern = /\b(slip.on tanker|border security|counternarcotics|counterterrorism|logistical support for inl|scientific.*coordination center|clinical trial optional|screwworm.*challenge|wildland fire|department of the interior.*ofw|travel.*training.*logistics for (costa rica|el salvador|colombia|peru))\b/i
    if (fedInstitutionalPattern.test(oppText)) {
      return { pass: false, reason: 'federal institutional grant, not for individuals' }
    }
  }

  return { pass: true }
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
  const profileData = {
    primary_type: profile.primary_type || null,
    veteran_status: demographics.veteran_status || military.veteran || null,
    immigrant_status: demographics.immigrant_status || null,
    disability_status: demographics.disability_status || health.disability_type || null,
    tags: parseTags(profile.tags),
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

    // 2. Wrong-state check
    if (profileState) {
      const grantState = extractStateFromTitle(grant.title || '')
      if (grantState && grantState !== profileState) {
        toDelete.push({ id: grant.id, title: grant.title, reason: `wrong state: grant is ${grantState}, profile is ${profileState}` })
        track('wrong_state')
        continue
      }
    }

    // 3. Relevance filter
    const oppText = `${grant.title || ''} ${grant.funder || ''}`.toLowerCase()
    const result = applyRelevanceFilter(oppText, profileData)
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
