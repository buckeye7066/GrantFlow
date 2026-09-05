import zipcodes from 'zipcodes'
import { sanitizeLogValue } from '../utils/logger.js'
import { resolveCountyForZip } from './geo/zipCountyResolver.js'
import crypto from 'crypto'
import { inferUsStateZipFromText, collectAddressTextForInference } from '../utils/inferLocationFromAddress.js'
import { isFabricatedGeoSource } from '../config/placeholderProfileSignals.js'
import { NON_EVIDENTIARY_KEYWORDS } from '../config/nonEvidentiaryKeywords.js'
import { normalizeState, normalizeStateFromText } from '../utils/stateNormalization.js'
import { createLogger } from '../utils/logger.js'
import { getProfileType, resolveProfileType } from './profileTypeRegistry.js'
import { resolveStudentFundingLocation } from './college/committedCollege.js'
import { buildProfileFacets } from './profile/profileTaxonomy.js'
import { normalizeProfile, normalizeNeedCategory } from './profileNormalizer.js'
import { containsTermWholeWord, containsAffirmedTermWholeWord, stripNegatedClauses } from './shared/textMatch.js'

// Field NAMES that are drafting-only prose / unscored across the whole schema
// (mission, narrative.*, every *.notes, essays, deprecated fields). The keyword
// miner MUST NOT feed these into the scoring keyword inventory — owner directive
// 2026-07-07: free-text prose is drafting-only and never floods scoring. Computed
// once from PROFILE_SCHEMA so a new scored:false field is auto-excluded.
const log = createLogger('profileHelpers')

// Full state name → 2-letter abbreviation for extractStateFromContext fallback
const STATE_NAME_TO_ABBR = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
  'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'florida': 'FL', 'georgia': 'GA',
  'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
  'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO',
  'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH',
  'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT',
  'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
  'district of columbia': 'DC', 'puerto rico': 'PR', 'guam': 'GU', 'us virgin islands': 'VI',
}

/**
 * Resolve the canonical applicant type from a profile object.
 *
 * The database column is `primary_type` but the frontend and some services
 * use `applicant_type`.  profileTaxonomy uses `primary_profile_type` inside
 * its facets object.  This helper normalises all three so callers never need
 * to remember the precedence chain.
 *
 * @param {Object} profile - A profile row or profileContext.profile
 * @returns {string|null}
 */
export function resolveApplicantType(profile) {
  if (!profile || typeof profile !== 'object') return null
  return (
    profile.applicant_type ??
    profile.primary_type ??
    profile.primary_profile_type ??
    null
  )
}

const GENERIC_PROFILE_TYPES = new Set([
  '',
  'individual',
  'individual_need',
  'family',
  'other',
])

function normalizeProfileTypeCandidate(value) {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed || null
}

function isGenericProfileType(value) {
  const normalized = normalizeProfileTypeCandidate(value)
  if (!normalized) return true
  return GENERIC_PROFILE_TYPES.has(normalized.toLowerCase())
}

/**
 * Infer a more specific profile type from an organization-style display name
 * when stored columns are still generic (e.g. legacy "individual" defaults).
 */
export function inferProfileTypeFromDisplayName(displayName) {
  const name = String(displayName || '').trim().toLowerCase()
  if (!name) return null

  if (/\b(church|congregation|parish|diocese|synagogue|mosque|temple|faith community)\b/.test(name)) {
    return 'church'
  }
  if (/\b(ministr(?:y|ies)|mission(?:ary)?)\b/.test(name)) {
    return 'ministry'
  }
  if (/\b(nonprofit|non-profit|foundation|501\(c\)|charit(?:y|able))\b/.test(name)) {
    return 'nonprofit'
  }
  if (/\b(school district|public school|university|college|academy)\b/.test(name)) {
    return 'public_school'
  }
  if (/\b(county government|county of|municipal|city of|town of|borough of)\b/.test(name)) {
    return 'municipality'
  }
  if (/\b(fire department|fire dept|ems squad|rescue squad|volunteer fire)\b/.test(name)) {
    return 'volunteer_fire_department'
  }
  if (/\b(food pantry|food bank|homeless shelter|animal rescue|animal shelter)\b/.test(name)) {
    if (name.includes('food')) return 'food_pantry'
    if (name.includes('animal')) return 'animal_rescue'
    return 'homeless_shelter'
  }
  if (/\b(corporation|corp\.|inc\.|llc|company|enterprises)\b/.test(name)) {
    if (/\b(large|international|global)\b/.test(name)) return 'large_corporation'
    if (/\b(medium|mid-size|regional)\b/.test(name)) return 'medium_corporation'
    return 'business'
  }

  return null
}

/**
 * Resolve the best profile type for display, matching, and billing from
 * profile columns plus section data. Prefers specific section values over
 * generic stored defaults like "individual".
 */
export function resolveEffectiveProfileType(profile, sections = {}) {
  const basic =
    sections?.basic_information && typeof sections.basic_information === 'object'
      ? sections.basic_information
      : {}
  const organizationDetails =
    sections?.organization_details && typeof sections.organization_details === 'object'
      ? sections.organization_details
      : {}

  const candidates = [
    organizationDetails.organization_type,
    basic.profile_type,
    basic.profile_category,
    profile?.applicant_type,
    profile?.primary_type,
    profile?.primary_profile_type,
  ]
    .map(normalizeProfileTypeCandidate)
    .filter(Boolean)

  for (const candidate of candidates) {
    if (!isGenericProfileType(candidate)) {
      return resolveProfileType(candidate) ?? candidate
    }
  }

  const inferred = inferProfileTypeFromDisplayName(profile?.display_name)
  if (inferred) return inferred

  const fallback = candidates[0] ?? normalizeProfileTypeCandidate(resolveApplicantType(profile))
  if (!fallback) return null
  return resolveProfileType(fallback) ?? fallback
}

/**
 * Human-readable label for a stored/canonical profile type id.
 */
export function getProfileTypeDisplayLabel(rawType) {
  if (!rawType) return null
  const resolved = resolveProfileType(rawType) ?? rawType
  const entry = getProfileType(resolved)
  if (entry?.anyaLabel) return entry.anyaLabel
  if (typeof rawType === 'string') {
    return rawType
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase())
  }
  return String(rawType)
}

function safeParseJSON(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch (error) {
    console.warn('[profileHelpers] Failed to parse JSON', error)
    return fallback
  }
}

/**
 * Safely parse array fields that may be JSON arrays or comma-separated strings
 * Handles:
 * - JSON arrays: ["item1", "item2"]
 * - Comma-separated strings: "item1,item2,item3"
 * - Already parsed arrays: ["item1", "item2"]
 * - null/undefined/empty values
 */
export function safeParseArrayField(value, fallback = []) {
  if (!value) return fallback
  if (Array.isArray(value)) return value
  if (value instanceof Set) return Array.from(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        return Array.isArray(parsed) ? parsed : fallback
      } catch {
        // Fall through to comma-split
      }
    }
    // Handle comma-separated strings
    return trimmed.split(',').map(s => s.trim()).filter(Boolean)
  }
  return fallback
}

/**
 * Normalize *any* value to a string[] in a forgiving, non-destructive way.
 *
 * Handles every shape we have ever seen for profile list fields
 * (geographic_designation, programs_services.{focus_areas,interests,keywords},
 * etc.) so callers like buildProfileSignals never have to branch on shape:
 *   - undefined / null      -> []
 *   - string ""             -> []
 *   - string "rural, urban" -> ["rural", "urban"]   (split on commas/newlines)
 *   - string "[\"a\",\"b\"]"-> ["a", "b"]            (JSON arrays)
 *   - array of mixed values -> flatten + stringify + drop empties
 *   - plain object {0:"a"}  -> Object.values(...) recursively
 *   - Set                   -> Array.from(...)
 *
 * Lower-cases entries so downstream keyword/demographic sets match.
 */
export function toStringArray(value) {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => toStringArray(entry))
      .map((entry) => String(entry).trim().toLowerCase())
      .filter(Boolean)
  }
  if (value instanceof Set) return toStringArray(Array.from(value))
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return toStringArray(parsed)
      } catch {
        // fall through
      }
    }
    return trimmed
      .split(/[,\n]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  }
  if (typeof value === 'object') {
    return toStringArray(Object.values(value))
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value).toLowerCase()]
  }
  return []
}

/**
 * Section keys + field names whose values must always be string[] before they
 * reach the renderer or the matching pipeline. Centralised so the read-time
 * normalizer (in profile load endpoints) and signal extraction stay in sync.
 */
export const PROFILE_LIST_FIELDS = Object.freeze({
  housing: ['geographic_designation'],
  programs_services: ['focus_areas', 'interests', 'keywords'],
})

/**
 * Idempotent normalizer for a single profile_sections.data payload.
 * Coerces known list fields to string[] *without* mutating the input.
 * Safe to call repeatedly; safe on missing/extra keys.
 */
export function normalizeProfileSectionData(sectionKey, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const listFields = PROFILE_LIST_FIELDS[sectionKey]
  if (!listFields) return data
  let out = data
  for (const field of listFields) {
    if (!(field in out)) continue
    const current = out[field]
    if (Array.isArray(current) && current.every((entry) => typeof entry === 'string')) continue
    if (out === data) out = { ...data }
    out[field] = toStringArray(current)
  }
  return out
}

async function loadLinkedOrganizationForProfile(db, profileId, organizationId) {
  if (!profileId || !organizationId) return null
  return db
    .prepare(
      `
      WITH scope AS (SELECT ? AS profile_id)
      SELECT o.*
      FROM scope s
      JOIN profiles p ON p.id = s.profile_id
      JOIN organizations o ON o.id = p.organization_id
      WHERE s.profile_id = ?
        AND o.id = ?
      LIMIT 1
      `,
    )
    .get(profileId, profileId, organizationId)
}

const US_STATE_CODE_RE = /^[A-Z]{2}$/
const US_ZIP_RE = /^\d{5}(?:-\d{4})?$/

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

/**
 * Structured location facts from the basic_information section (flat keys, a
 * nested `location` / `address` object). A free-text address line such as
 * "3940 Eveningside Dr. NE
Cleveland, TN 37312" yields its trailing
 * "City, ST ZIP" only for the parts no structured value supplies.
 */
export function readSectionLocation(sections = {}) {
  const basic = sections?.basic_information && typeof sections.basic_information === 'object'
    ? sections.basic_information
    : {}
  const nestedLoc = basic.location && typeof basic.location === 'object' ? basic.location : {}
  const nestedAddr = basic.address && typeof basic.address === 'object' ? basic.address : {}
  let state = firstString(basic.state, nestedLoc.state, nestedAddr.state)
  let city = firstString(basic.city, nestedLoc.city, nestedAddr.city)
  // The ZIP is CORROBORATED across the shapes rather than taken from the first
  // one that answers: a live profile carried a stray flat `zip_code` (a
  // Minneapolis ZIP pasted from a scholarship form) beside a location object
  // AND an address line that both said 37312. Majority wins; a tie keeps the
  // flat value.
  const zipCandidates = [
    firstString(basic.zip, basic.zip_code, basic.postal_code),
    firstString(nestedLoc.zip, nestedLoc.zip_code, nestedLoc.postal_code),
    firstString(nestedAddr.zip, nestedAddr.zip_code, nestedAddr.postal_code),
  ]
  let addressLine = null
  if (typeof basic.address === 'string') {
    addressLine = /([A-Za-z .'-]+?)\s*,\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/.exec(basic.address.trim())
    if (addressLine) zipCandidates.push(addressLine[3])
  }
  const zipVotes = new Map()
  for (const candidate of zipCandidates) {
    if (!candidate) continue
    const key = candidate.slice(0, 5)
    if (!zipVotes.has(key)) zipVotes.set(key, { value: candidate, votes: 0 })
    zipVotes.get(key).votes += 1
  }
  let zip = null
  for (const entry of zipVotes.values()) {
    if (!zip || entry.votes > zip.votes) zip = entry
  }
  zip = zip ? zip.value : null
  if (addressLine) {
    city = city || addressLine[1].trim()
    state = state || addressLine[2].toUpperCase()
  }
  if (state) state = state.toUpperCase()
  if (state && !US_STATE_CODE_RE.test(state)) state = null
  if (zip && !US_ZIP_RE.test(zip)) zip = null
  return { state, city, zip }
}

export async function loadProfileContext(
  db,
  profileId,
  { enrichWebsitePurpose = true } = {},
) {
  const profile = await db
    .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
    .get(profileId)
  if (!profile) {
    throw new Error(`Profile ${profileId} not found`)
  }

  const sections = (await db
    .prepare(
      `
      SELECT section_key, data
      FROM profile_sections
      WHERE profile_id = ?
    `,
    )
    .all(profileId))
    .reduce((acc, row) => {
      acc[row.section_key] = safeParseJSON(row.data, {})
      return acc
    }, {})

  // Organization website and mission are first-class profile evidence. Load
  // them before enrichment so profiles that store their public URL only on the
  // linked organization do not silently skip the website-purpose chain.
  let organization = null
  if (profile.organization_id) {
    try {
      organization = await loadLinkedOrganizationForProfile(db, profileId, profile.organization_id)
    } catch (err) {
      console.warn(
        '[loadProfileContext] organization lookup failed for profile=%s org=%s:',
        sanitizeLogValue(profileId),
        profile.organization_id,
        err?.message || err,
      )
    }
  }

  // Website-derived purpose is persisted and reused by the synchronous match
  // engine. Tests stay hermetic; production/profile-crawl loads perform one
  // bounded read per cache window when a public website is present.
  if (
    enrichWebsitePurpose &&
    String(process.env.NODE_ENV || '').toLowerCase() !== 'test'
  ) {
    try {
      const { enrichProfileWebsitePurpose } = await import('./profileWebsitePurposeEnrichment.js')
      await enrichProfileWebsitePurpose(db, { profile, sections, organization })
    } catch (error) {
      console.warn('[profileHelpers] website purpose enrichment unavailable', error?.message || error)
    }
  }

  // Use safeParseArrayField for array fields
  const tags = safeParseArrayField(profile.tags, [])
  const interests = safeParseArrayField(profile.interests, [])

  const effectivePrimaryType = resolveEffectiveProfileType(profile, sections)

  // Merge organization address fields into the profile context when available.
  // Many workflows store ZIP/state/city on `organizations`, but matching relies on profileContext.signals.location.
  if (profile.organization_id && !organization) {
    try {
      organization = await loadLinkedOrganizationForProfile(db, profileId, profile.organization_id)
    } catch (err) {
      // Surface org-load failure so matching doesn't silently lose org-level
      // signals (state/city/zip/mission). Matching continues without the org.
      //
      // The ids are passed as ARGUMENTS, never interpolated into the first
      // argument. Node treats `console.warn`'s first argument as a FORMAT
      // string, so a caller-supplied `profileId` embedded there is a
      // format-string injection: a request for `?profileId=%s%o` would consume
      // the following arguments as substitutions and print unintended values
      // into the logs. `profileId` reaches here straight from HTTP query
      // parameters (CodeQL js/tainted-format-string, PR #1081; the sibling
      // js/log-injection finding — a %0A in that same query param forging a
      // fake log line — is fixed here too via sanitizeLogValue).
      console.warn(
        '[loadProfileContext] organization lookup failed for profile=%s org=%s:',
        sanitizeLogValue(profileId),
        profile.organization_id,
        err?.message || err,
      )
      organization = null
    }
  }

  // The profiles table carries NO state/city/zip columns; the applicant's
  // address lives in profile_sections.basic_information (flat `state`/`city`,
  // a nested `location`/`address` object, or a free-text address line). Read
  // it here so a Cleveland, TN 37312 profile is not logged as `zip=? state=?
  // city=?` and every state-keyed crawler lane misses it by construction.
  const sectionLocation = readSectionLocation(sections)
  const mergedProfile = {
    ...profile,
    primary_type: effectivePrimaryType ?? profile.primary_type,
    applicant_type: profile.applicant_type ?? effectivePrimaryType ?? profile.primary_type,
    tags,
    interests,
    // Provide fallbacks for location extraction
    // The profiles table column is "zip" but extraction functions check postal_code/zip_code — normalize here.
    postal_code: profile.postal_code || profile.zip_code || profile.zip || sectionLocation.zip || organization?.zip || organization?.postal_code || null,
    zip_code: profile.zip_code || profile.zip || profile.postal_code || sectionLocation.zip || null,
    state: profile.state || sectionLocation.state || organization?.state || null,
    city: profile.city || sectionLocation.city || organization?.city || null,
  }
  
  // If this is a student who has COMMITTED to a college, their funding location
  // follows the school: an off-campus address (when set) or the campus city/state.
  // This re-points geo/housing crawlers at the school's area instead of the
  // student's home — the moment they move to school, funding search moves too.
  try {
    const uni = sections?.university_applications
    if (uni) {
      const fundingLoc = resolveStudentFundingLocation(uni)
      if (fundingLoc && (fundingLoc.zip || fundingLoc.state || fundingLoc.city)) {
        if (fundingLoc.zip) { mergedProfile.postal_code = fundingLoc.zip; mergedProfile.zip_code = fundingLoc.zip; mergedProfile.zip = fundingLoc.zip }
        if (fundingLoc.state) mergedProfile.state = fundingLoc.state
        if (fundingLoc.city) mergedProfile.city = fundingLoc.city
        mergedProfile.funding_location_source = fundingLoc.source
      }
    }
  } catch (err) {
    log.warn(`[loadProfileContext] student funding-location override failed: ${err?.message || err}`)
  }

  const sectionKeys = Object.keys(sections)
  log.info(
    `[loadProfileContext] profile=${profileId} zip=${mergedProfile.postal_code || mergedProfile.zip_code || '?'} ` +
    `state=${mergedProfile.state || '?'} city=${mergedProfile.city || '?'} ` +
    `sections=[${sectionKeys.join(',')}] org=${profile.organization_id || 'none'}`,
  )

  let signals = buildProfileSignals({
    profile: mergedProfile,
    sections,
    asOf: mergedProfile.updated_at || mergedProfile.created_at || null,
  })

  // Foolproof: guarantee signals are always usable by crawlers/matching (never null or empty when profile exists).
  if (!signals || typeof signals !== 'object') {
    signals = buildProfileSignals({ profile: mergedProfile, sections: {}, asOf: null })
  }
  if (!signals.location || typeof signals.location !== 'object') {
    signals.location = {
      zip: mergedProfile.postal_code || mergedProfile.zip_code || mergedProfile.zip || null,
      state: mergedProfile.state || null,
      city: mergedProfile.city || null,
      county: null,
    }
  }
  const hasAnyKeywords = (signals.keywordSet && signals.keywordSet.size > 0) || (Array.isArray(signals.keywords) && signals.keywords.length > 0)
  if (!hasAnyKeywords && (mergedProfile.primary_type || (Array.isArray(mergedProfile.tags) && mergedProfile.tags.length > 0))) {
    const pt = String(mergedProfile.primary_type || '').trim().toLowerCase()
    if (pt) {
      if (!signals.keywordSet) signals.keywordSet = new Set()
      signals.keywordSet.add(pt)
      if (!signals.applicantTypes) signals.applicantTypes = new Set()
      signals.applicantTypes.add(pt)
    }
    if (Array.isArray(mergedProfile.tags) && mergedProfile.tags.length > 0) {
      if (!signals.keywordSet) signals.keywordSet = new Set()
      mergedProfile.tags.forEach((t) => t && signals.keywordSet.add(String(t).toLowerCase().trim()))
    }
    if (Array.isArray(signals.keywords)) {
      signals.keywords = Array.from(signals.keywordSet || [])
    }
  }

  // RC-17: load uploaded document text so the normalizer can fold need
  // signals out of PDFs / DOCX / OCR output. Best-effort: never break
  // matching if the documents table is absent (fresh DB) or empty.
  let documents = []
  try {
    documents = await db
      .prepare(
        `SELECT id, name, mime_type, extracted_text
         FROM documents
         WHERE profile_id = ?
           AND extracted_text IS NOT NULL
           AND TRIM(extracted_text) <> ''
         ORDER BY uploaded_at DESC NULLS LAST, created_at DESC NULLS LAST
         LIMIT 25`,
      )
      .all(profileId)
  } catch {
    // SQLite doesn't support `NULLS LAST` — retry with a portable form.
    try {
      documents = await db
        .prepare(
          `SELECT id, name, mime_type, extracted_text
           FROM documents
           WHERE profile_id = ?
             AND extracted_text IS NOT NULL
             AND TRIM(extracted_text) <> ''
           ORDER BY COALESCE(uploaded_at, created_at) DESC
           LIMIT 25`,
        )
        .all(profileId)
    } catch {
      documents = []
    }
  }

  const safeDocuments = Array.isArray(documents) ? documents : []

  // Build the canonical facet object and normalized profile AT LOAD TIME so every
  // consumer of loadProfileContext (matching, Robert, Anya, crawlers) gets facet-intent
  // alignment + eligibility scoring instead of silently dropping ~15 scoring points.
  //
  // The canonical matcher reads `profileContext.facets` directly and only lazily builds
  // `profileNorm` (and never builds facets). When loadProfileContext omitted both, real
  // profiles scored with facets:{} / profileNorm:null, suppressing match scores. Building
  // them here is the single, schema-drift-tolerant place that fixes it for all callers.
  //
  // STRICTLY DEFENSIVE: a missing/odd section or taxonomy hiccup must degrade to empty,
  // never throw — matching must still run on the rest of the context.
  let facets = {}
  let coverage = null
  try {
    const enriched = buildProfileFacets({
      profile: mergedProfile,
      sections,
      signals,
      organization: organization ?? null,
    })
    if (enriched && typeof enriched.facets === 'object' && enriched.facets) {
      facets = enriched.facets
    }
    if (enriched && typeof enriched.coverage === 'object' && enriched.coverage) {
      coverage = enriched.coverage
    }
  } catch (err) {
    log.warn(`[loadProfileContext] buildProfileFacets failed for profile=${profileId}: ${err?.message || err}`)
    facets = {}
  }

  let profileNorm = null
  try {
    profileNorm = normalizeProfile(mergedProfile, sections, signals, safeDocuments)
  } catch (err) {
    log.warn(`[loadProfileContext] normalizeProfile failed for profile=${profileId}: ${err?.message || err}`)
    profileNorm = null
  }

  return {
    profile: mergedProfile,
    sections,
    signals,
    facets,
    coverage,
    profileNorm,
    organization: organization ?? undefined,
    documents: safeDocuments,
  }
}

/**
 * Build canonical, deterministic profile context for crawlers, matching, and Anya.
 * This is the ONLY function crawlers/matching/Anya should use to access profile data.
 * 
 * Returns a complete, immutable snapshot including:
 * - Base profile row
 * - All profile sections and fields
 * - Derived signals (mission, geography, focus areas, populations served)
 * - Attached documents metadata (file_url, mime_type, extracted_text if available)
 * - Organization data if linked
 * 
 * The output is deterministic JSON suitable for storage in crawler_jobs.profile_context_snapshot.
 * 
 * @param {object} db - Database connection
 * @param {string} profileId - Profile ID
 * @returns {Promise<object>} Complete profile context
 */
export async function buildProfileContext(db, profileId, options = {}) {
  // Get base profile
  const profile = await db
    .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
    .get(profileId)
  
  if (!profile) {
    throw new Error(`Profile ${profileId} not found`)
  }

  // Deterministic reference timestamp for derived computations and generated_at.
  // Never default to "now" here; snapshots must be stable.
  const referenceIsoRaw =
    options && typeof options === 'object' && options.asOf
      ? String(options.asOf)
      : (profile.updated_at || profile.created_at || null)

  // Get all profile sections
  const sectionRows = await db
    .prepare(
      `
      SELECT section_key, data, created_at, updated_at
      FROM profile_sections
      WHERE profile_id = ?
      ORDER BY section_key
    `,
    )
    .all(profileId)
  
  const sections = {}
  const sectionsMeta = []
  
  for (const row of sectionRows) {
    sections[row.section_key] = safeParseJSON(row.data, {})
    sectionsMeta.push({
      key: row.section_key,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })
  }

  // Parse array fields
  const tags = safeParseArrayField(profile.tags, [])
  const interests = safeParseArrayField(profile.interests, [])

  const effectivePrimaryType = resolveEffectiveProfileType(profile, sections)

  // Get organization if linked
  let organization = null
  if (profile.organization_id) {
    try {
      organization = await loadLinkedOrganizationForProfile(db, profileId, profile.organization_id)
    } catch (error) {
      console.warn('[buildProfileContext] Failed to load organization:', error?.message)
      organization = null
    }
  }

  // Get documents with metadata and extracted text
  const documents = []
  try {
    const docRows = await db
      .prepare(
        `
        SELECT 
          d.id, d.name, d.type, d.file_url, d.file_path, 
          d.file_size, d.mime_type, d.extracted_text,
          d.created_at, d.updated_at
        FROM documents d
        WHERE d.profile_id = ?
        ORDER BY d.created_at DESC
      `,
      )
      .all(profileId)
    
    for (const doc of docRows) {
      documents.push({
        id: doc.id,
        name: doc.name,
        type: doc.type,
        file_url: doc.file_url,
        file_path: doc.file_path,
        file_size: doc.file_size,
        mime_type: doc.mime_type,
        extracted_text: doc.extracted_text || null,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
      })
    }
  } catch (error) {
    console.warn('[buildProfileContext] Failed to load documents:', error?.message)
  }

  // Build merged profile with location fallbacks (section-declared address
  // first — the profiles table has no location columns).
  const sectionLocation = readSectionLocation(sections)
  const mergedProfile = {
    ...profile,
    primary_type: effectivePrimaryType ?? profile.primary_type,
    applicant_type: profile.applicant_type ?? effectivePrimaryType ?? profile.primary_type,
    tags,
    interests,
    postal_code: profile.postal_code || sectionLocation.zip || organization?.zip || organization?.postal_code || null,
    state: profile.state || sectionLocation.state || organization?.state || null,
    city: profile.city || sectionLocation.city || organization?.city || null,
  }

  // Build signals (keywords, demographics, location, etc.)
  const signals = buildProfileSignals({ 
    profile: mergedProfile, 
    sections,
    asOf: referenceIsoRaw,
  })

  // Return deterministic context
  return {
    version: '2.0', // Version for future compatibility
    profile_id: profileId,
    generated_at: referenceIsoRaw,
    profile: mergedProfile,
    sections,
    sections_meta: sectionsMeta,
    signals,
    organization: organization || null,
    documents,
  }
}

function freeformAddressTextForInference(sections) {
  return collectAddressTextForInference(
    sections?.basic_information ?? {},
    sections?.location_focus ?? {},
    null,
    sections?.comprehensive_application ?? null,
  )
}

export function extractZipFromContext({ profile, sections, jobParameters = {} }) {
  const addr = sections?.basic_information?.address
  const compAddr = sections?.comprehensive_application?.address
  const candidates = [
    jobParameters.zip,
    jobParameters.primary_zip,
    sections?.basic_information?.zip,
    sections?.basic_information?.zip_code,
    sections?.basic_information?.postal_code,
    sections?.basic_information?.address_zip,
    addr?.zip_code,
    addr?.zip,
    addr?.postal_code,
    sections?.comprehensive_application?.zip,
    sections?.comprehensive_application?.zip_code,
    sections?.comprehensive_application?.postal_code,
    compAddr?.zip_code,
    compAddr?.zip,
    compAddr?.postal_code,
    sections?.location_focus?.primary_zip,
    sections?.location_focus?.service_zip,
    sections?.location_focus?.zip,
    sections?.location_focus?.zip_code,
    sections?.organization_details?.zip,
    sections?.organization_details?.zip_code,
    sections?.organization_details?.hq_zip,
    sections?.demographics?.zip_code,
    sections?.demographics?.zip,
    profile?.postal_code,
    profile?.zip_code,
    profile?.zip,
  ]

  const zip = candidates.find(
    (value) => typeof value === 'string' && /^\d{5}/.test(value.trim()),
  )

  if (zip) return zip.trim().slice(0, 5)
  const inferred = inferUsStateZipFromText(freeformAddressTextForInference(sections))
  return inferred.zip || null
}

export function extractStateFromContext({ profile, sections, jobParameters = {} }) {
  const addr = sections?.basic_information?.address
  const compAddr = sections?.comprehensive_application?.address

  // ── SERVICE-AREA PRECEDENCE (canonical_rules G4 geographic matching) ──────
  // A profile's geographic FIT is driven by where it DELIVERS services (its
  // service area / geographic focus), NOT by where its mail is delivered. A
  // ministry headquartered in Cleveland, TN that serves the Pine Ridge
  // Reservation, SD must match SD sources, not TN ones. So the explicit
  // "Location Focus / service area / geographic focus" fields are resolved
  // FIRST — they win over the mailing/home address below. This only fires when
  // the service-area field names a concrete state; otherwise we fall through to
  // the mailing-address candidates (single-address individuals are unchanged,
  // since they typically leave Location Focus blank and their home == service
  // area). `service_states`/`states_served` arrays are intentionally NOT used
  // here (the singular primary should reflect ONE state); they still join the
  // multi-state `states[]` list in buildProfileSignals.
  const serviceAreaCandidates = [
    sections?.location_focus?.service_area,
    sections?.location_focus?.geographic_focus,
    sections?.location_focus?.primary_state,
    sections?.location_focus?.state,
    sections?.comprehensive_application?.geographic_focus,
    sections?.narrative?.geographic_focus,
  ]
  for (const value of serviceAreaCandidates) {
    if (typeof value !== 'string' || !value.trim()) continue
    const trimmed = value.trim()
    const resolved =
      (trimmed.length === 2 ? normalizeState(trimmed) : null) ||
      STATE_NAME_TO_ABBR[trimmed.toLowerCase()] ||
      normalizeStateFromText(trimmed)
    if (resolved) return resolved
  }

  const candidates = [
    jobParameters.state,
    sections?.basic_information?.state,
    sections?.basic_information?.address_state,
    addr?.state,
    sections?.comprehensive_application?.state,
    sections?.comprehensive_application?.address_state,
    compAddr?.state,
    sections?.location_focus?.state,
    sections?.location_focus?.primary_state,
    sections?.organization_details?.state,
    sections?.demographics?.state,
    profile?.state,
  ]

  const state = candidates
    .map((value) => {
      if (typeof value !== 'string' || !value.trim()) return null
      const trimmed = value.trim()
      if (trimmed.length === 2) return normalizeState(trimmed)
      // Handle full state names (e.g. "Ohio" → "OH", "West Virginia" → "WV")
      return normalizeState(trimmed) || STATE_NAME_TO_ABBR[trimmed.toLowerCase()] || normalizeStateFromText(trimmed)
    })
    .find(Boolean)

  if (state) return state
  const freeformState = normalizeStateFromText([
    sections?.location_focus?.geographic_focus,
    sections?.location_focus?.service_area,
    sections?.comprehensive_application?.geographic_focus,
    sections?.narrative?.geographic_focus,
  ].filter(Boolean).join(' '))
  if (freeformState) return freeformState
  const inferred = inferUsStateZipFromText(freeformAddressTextForInference(sections))
  return inferred.state ?? null
}

export function extractStudentCampusZip({ sections, jobParameters = {} }) {
  const candidates = [
    jobParameters.campus_zip,
    sections?.education?.campus_zip,
    sections?.education?.planned_campus_zip,
    sections?.education?.target_school_zip,
  ]

  const zip = candidates.find(
    (value) => typeof value === 'string' && /^\d{5}$/.test(value.trim()),
  )

  return zip?.trim() ?? null
}

export function getAssistanceFlags(sections = {}) {
  const assistance = sections.government_assistance ?? {}
  return {
    lowIncome:
      assistance.snap_recipient ||
      assistance.tanf_recipient ||
      assistance.section8_housing ||
      assistance.other_programs,
    veteran: sections.military_service?.veteran ?? false,
    disabled:
      assistance.ssi_recipient ||
      assistance.ssdi_recipient ||
      sections.health_medical?.disability_type?.length > 0 ||
      sections.health_medical?.wheelchair_user ||
      sections.health_medical?.visual_impairment ||
      sections.health_medical?.hearing_impairment ||
      sections.health_medical?.chronic_illness ||
      sections.health_medical?.mental_health_condition,
    student: ['student', 'high_school_student', 'college_student'].includes(
      sections.basic_information?.profile_category ??
        sections.organization_details?.organization_type ??
        '',
    ),
  }
}

const GENDER_SYNONYMS = {
  female: ['female', 'woman', 'women', 'girl', 'girls', 'female-led', 'female identifying'],
  male: ['male', 'man', 'men', 'boy', 'boys'],
  nonbinary: ['nonbinary', 'non-binary', 'genderqueer', 'gender nonconforming', 'non conforming'],
}

const DEMOGRAPHIC_SYNONYMS = {
  african_american: ['african american', 'black', 'black american'],
  hispanic_latino: ['hispanic', 'latino', 'latina', 'latinx'],
  asian_american: ['asian american', 'asian', 'pacific islander', 'aapi'],
  native_american: ['native american', 'indigenous', 'tribal'],
  lgbtq: ['lgbtq', 'queer', 'gay', 'lesbian', 'transgender', 'trans'],
  immigrant: ['immigrant', 'refugee', 'foreign-born', 'new american'],
}

const ASSISTANCE_SYNONYMS = {
  low_income: ['low income', 'need-based', 'economic hardship', 'income eligible'],
  homeless: ['homeless', 'housing insecure'],
  ssi_recipient: ['ssi', 'supplemental security income'],
  ssdi_recipient: ['ssdi', 'social security disability'],
  snap_recipient: ['snap', 'food stamps'],
  tanf_recipient: ['tanf', 'temporary assistance for needy families'],
  section8_housing: ['section 8', 'housing voucher'],
}

const MILITARY_FLAGS = {
  veteran: ['veteran', 'military veteran'],
  active_duty_military: ['active duty', 'currently serving'],
  national_guard: ['national guard', 'guard'],
  disabled_veteran: ['disabled veteran'],
  military_spouse: ['military spouse'],
  military_dependent: ['military dependent'],
  gold_star_family: ['gold star family'],
}

const TOKEN_SPLIT_REGEX = /[^a-z0-9]+/gi

/**
 * Placeholder strings an intake form or an intake model writes to say "this
 * field has NO value": "none", "unknown", "n/a", "not provided" ... A live
 * student profile carried `medicaid_waiver_program: "none"` and the signal
 * builder read the word "none" as a waiver NAME — minting a medicaid_waiver
 * assistance flag and a "medicaid waiver" search keyword for a person who is
 * on no waiver (owner finding, 2026-09-05). 37 of 51 production profiles carry
 * at least one such field (75 fields total). A sentinel is an absence, never
 * a fact, everywhere in this reader.
 */
const SENTINEL_TEXT_RX = /^\s*(?:none|no|n\/?a|nil|null|undefined|unknown|unsure|not applicable|not provided|not specified|not reported|not available|not stated|none reported|none provided|none listed|none noted|not listed|no data|tbd|to be determined|pending|-+|\?+|\.)\s*[.!]?\s*$/i

export function isSentinelText(value) {
  return typeof value === 'string' && SENTINEL_TEXT_RX.test(value)
}

/** True for a non-empty string that is a VALUE, not a sentinel placeholder. */
export function hasTextValue(value) {
  return typeof value === 'string' && value.trim().length > 0 && !SENTINEL_TEXT_RX.test(value)
}

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().toLowerCase()
  return SENTINEL_TEXT_RX.test(normalized) ? '' : normalized
}

/**
 * Canonical health FLAG tokens that name a medical condition — a disease-specific
 * source lane could plausibly be built for each, so "no lane exists for X" is a
 * fair finding.
 */
export const HEALTH_DIAGNOSIS_FLAGS = new Set([
  'dialysis', 'transplant', 'hiv', 'tbi', 'amputee', 'neurodivergent',
  'mental_health', 'rare_disease', 'visual_impairment', 'hearing_impairment',
  'cancer', 'recovery', 'terminal',
])

/**
 * Canonical health FLAG tokens that describe a support LEVEL, an equipment need or
 * a functional status — NOT a diagnosis. No disease lane can ever name these, so
 * asking for one is noise; they belong to the need-coverage question instead.
 * `mobility_needs` is here because it leaked past the old exact-match denylist into
 * prod as an "add a disease lane for mobility_needs" wishlist entry.
 */
const HEALTH_SUPPORT_FLAGS = new Set([
  'wheelchair', 'chronic_illness', 'high_support_needs', 'disability',
  'mobility_needs', 'dme',
])

function addKeyword(set, value) {
  const normalized = normalizeString(value)
  if (!normalized) return
  set.add(normalized)
  normalized
    .split(TOKEN_SPLIT_REGEX)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .forEach((token) => set.add(token))
}

function addMultipleKeywords(set, values = []) {
  values.forEach((value) => addKeyword(set, value))
}

function collectTrueFlags(section = {}, mapping = {}) {
  const matched = []
  Object.entries(mapping).forEach(([key, labels]) => {
    if (!section || !section[key]) return
    labels.forEach((label) => matched.push(label))
  })
  return matched
}

function extractCityFromSections({ sections, jobParameters = {}, profile }) {
  const addr = sections?.basic_information?.address
  const compAddr = sections?.comprehensive_application?.address
  const candidates = [
    jobParameters.city,
    sections?.basic_information?.city,
    sections?.basic_information?.address_city,
    addr?.city,
    sections?.comprehensive_application?.city,
    compAddr?.city,
    sections?.location_focus?.primary_city,
    sections?.location_focus?.service_city,
    sections?.location_focus?.city,
    sections?.organization_details?.city,
    sections?.demographics?.city,
    profile?.city,
  ]
  const city = candidates.find((value) => typeof value === 'string' && value.trim().length > 0)
  return city ? city.trim() : null
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function parseSatRange(range) {
  const normalized = normalizeString(range)
  if (!normalized) return null
  const matches = normalized.match(/\d{3,4}/g)
  if (!matches || matches.length === 0) return null
  const numbers = matches.map((entry) => Number.parseInt(entry, 10)).filter((entry) => Number.isFinite(entry))
  if (numbers.length === 0) return null
  const max = Math.max(...numbers)
  return Number.isFinite(max) ? max : null
}

function collectNarrativeKeywords(section = {}, register) {
  const fields = [
    'primary_goal',
    'target_population',
    'unique_qualities',
    'collaboration_partners',
    'sustainability_plan',
    'special_circumstances',
    'mission',
    'barriers_faced',
    'timeline',
    'past_experience',
    'funding_needs',
    'funding_purpose',
    'assistance_notes',
    'notes',
  ]
  fields.forEach((field) => {
    // NOTE (2026-07-07): drafting-only prose (mission, narrative.*, *.notes,
    // essays) is NOT excluded from mining here — needs-silent ORGS derive their
    // need categories FROM their mission/primary_goal/target_population text via
    // NEED_MAP (the Focus Forward class), so gating the miner on those fields
    // destroyed org need derivation. The "prose must not flood scoring" rule is
    // already satisfied at the DENOMINATOR: keyword-kind data points are
    // excluded from the coverage denominator (backend/services/profileDataPoints
    // .js), so mission keywords inform need derivation + add matched credit
    // WITHOUT inflating the denominator. Do not re-add a field-name gate here.
    const value = section[field]
    if (!hasTextValue(value)) return
    // Denied clauses are not keywords: "No military affiliation ... veteran
    // status" was registering veteran/military vocabulary for a student whose
    // section positively states no service (2026-09-05).
    stripNegatedClauses(value)
      .split(/[,;]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && entry.length <= 60)
      .forEach((entry) => register(entry))
  })
}

// Stopwords for document-text mining: ordinary English + grant/admin boilerplate
// that would otherwise dominate frequency counts and add nothing discriminating.
//
// The list MOVED to config/nonEvidentiaryKeywords.js (purpose audit 2026-08-21)
// because the KEYWORD DATA-POINT inventory — which scores every match — never had
// a stopword filter at all, and a college profile's top ACCEPT turned out to be a
// commercial-fishing occupational-safety grant credited for matching "and",
// "grant", "funding" and "eligible". One list, two consumers, so a term the miner
// discards can never come back as scoring evidence.
const DOC_STOPWORDS = NON_EVIDENTIARY_KEYWORDS

/**
 * Mine salient keyword/bigram terms out of uploaded document text so a user's
 * own documents (mission statements, needs assessments, support letters) feed
 * discovery. Bounded and frequency-ranked to stay relatable, never noisy: caps
 * documents scanned, characters per document, and terms emitted.
 *
 * @param {Array<{extracted_text?: string}>} documents
 * @param {(term: string) => void} register
 * @param {{maxDocs?: number, maxCharsPerDoc?: number, maxTerms?: number}} [opts]
 */
function collectDocumentKeywords(documents = [], register, opts = {}) {
  if (typeof register !== 'function' || !Array.isArray(documents) || documents.length === 0) return
  const maxDocs = opts.maxDocs ?? 8
  const maxCharsPerDoc = opts.maxCharsPerDoc ?? 6000
  const maxTerms = opts.maxTerms ?? 25

  const text = documents
    .slice(0, maxDocs)
    .map((d) => String(d?.extracted_text || '').slice(0, maxCharsPerDoc))
    .join('\n')
    .toLowerCase()
  if (!text.trim()) return

  // Tokenize to alphabetic words (keep internal hyphens), length 4..24.
  const tokens = (text.match(/[a-z][a-z-]{2,23}/g) || []).filter(
    (w) => w.length >= 4 && !DOC_STOPWORDS.has(w),
  )
  if (tokens.length === 0) return

  const unigram = new Map()
  const bigram = new Map()
  for (let i = 0; i < tokens.length; i += 1) {
    unigram.set(tokens[i], (unigram.get(tokens[i]) || 0) + 1)
    // Bigrams of adjacent salient tokens capture phrases like "kidney dialysis".
    if (i + 1 < tokens.length) {
      const bg = `${tokens[i]} ${tokens[i + 1]}`
      bigram.set(bg, (bigram.get(bg) || 0) + 1)
    }
  }

  // Rank: phrases that recur (count >= 2) first, then the most frequent single
  // terms. Frequency, then length, breaks ties toward more specific terms.
  const rankedBigrams = [...bigram.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, Math.ceil(maxTerms / 2))
    .map(([term]) => term)
  const rankedUnigrams = [...unigram.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([term]) => term)

  const emitted = []
  for (const term of [...rankedBigrams, ...rankedUnigrams]) {
    if (emitted.length >= maxTerms) break
    emitted.push(term)
    register(term)
  }
}

export function extractCityFromContext({ profile, sections, jobParameters = {} }) {
  return extractCityFromSections({ profile, sections, jobParameters })
}

/**
 * Extract state abbreviation from an address string
 */
function extractStateFromAddress(address) {
  if (!address || typeof address !== 'string') return null
  // Match 2-letter state code before ZIP (e.g., "TN 38501" or "TN, 38501")
  const match = address.match(/\b([A-Z]{2})\s{0,10},?\s{0,10}\d{5}/)
  return match ? match[1] : null
}

/**
 * Extract ZIP code from an address string
 */
function extractZipFromAddress(address) {
  if (!address || typeof address !== 'string') return null
  const match = address.match(/\b(\d{5})(?:-\d{4})?\b/)
  return match ? match[1] : null
}

/**
 * Resolve an optional secondary address (basic_information.secondary_address) into the
 * same { zip, state, city, county, type } shape as the primary location. Accepts either a
 * structured object ({ line1, city, state, zip, type }) or a freeform string. Enriches
 * missing state/city/county from the offline ZIP database, exactly like the primary
 * location. Returns null when no usable signal is present.
 *
 * @param {unknown} raw
 * @returns {{ zip: string|null, state: string|null, city: string|null, county: string|null, type: string|null }|null}
 */
function resolveSecondaryLocation(raw) {
  if ((raw === null || raw === undefined)) return null

  let zip = null
  let state = null
  let city = null
  let type = null
  // The state string the address DECLARES, before normalization — a present
  // but unresolvable one ('USA') is positive junk evidence, an absent one is
  // ordinary silence. See isFabricatedGeoSource.
  let declaredState = ''

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    zip = extractZipFromAddress(trimmed)
    state = extractStateFromAddress(trimmed)
    city = extractCityFromAddress(trimmed)
  } else if (typeof raw === 'object') {
    const a = raw
    const rawZip = a.zip ?? a.zip_code ?? a.postal ?? a.postal_code ?? null
    zip = rawZip !== null && rawZip !== undefined ? String(rawZip).replace(/\D/g, '').slice(0, 5) || null : null
    const rawState = a.state ?? a.region ?? null
    declaredState = rawState ? String(rawState).trim() : ''
    // Two letters is a SHAPE; the canonical registry is the AUTHORITY. The old
    // `.slice(0, 2)` turned 'USA' into 'US', which is not a state either.
    state = normalizeState(declaredState)
    const rawCity = a.city ?? null
    city = rawCity ? String(rawCity).trim() || null : null
    const rawType = a.type ?? a.label ?? null
    type = rawType ? String(rawType).trim() || null : null

    // Fall back to parsing a combined line1/address string when discrete fields are absent.
    const line = a.line1 ?? a.address1 ?? a.street ?? a.street1 ?? a.address ?? a.formatted ?? null
    if (typeof line === 'string' && line.trim()) {
      if (!zip) zip = extractZipFromAddress(line)
      if (!state) state = extractStateFromAddress(line)
      if (!city) city = extractCityFromAddress(line)
    }
  } else {
    return null
  }

  // Enrich from the offline ZIP database (mirrors the primary-location logic,
  // including its placeholder-address refusal).
  if (zip && !state && !isFabricatedGeoSource({ city, state: declaredState, zip })) {
    try {
      const lookup = zipcodes.lookup(zip)
      if (lookup?.state) state = String(lookup.state).toUpperCase()
      if (lookup?.city && !city) city = String(lookup.city)
    } catch {
      // ignore
    }
  }

  let county = null
  if (zip && !isFabricatedGeoSource({ city, state: declaredState, zip })) {
    try {
      county = resolveCountyForZip(zip, state || null) || null
    } catch {
      county = null
    }
  }

  if (!zip && !state && !city) return null
  return { zip: zip || null, state: state || null, city: city || null, county, type: type || null }
}

/**
 * Extract city from an address string (line before state/zip)
 */
function extractCityFromAddress(address) {
  if (!address || typeof address !== 'string') return null
  const normalized = address.replace(/\r/g, '').trim()
  // Prefer "City, ST ZIP" on one line (common in multiline addresses).
  // Bounded (`{1,100}`) rather than unbounded `+`: the character class
  // includes whitespace, so an unbounded run right next to a `\s*`/`\s+`
  // quantifier is an overlapping-quantifier shape a regex engine can
  // backtrack through in polynomial time on a long, non-matching string. A
  // real city name is never anywhere close to 100 characters.
  const cityStateZip = normalized.match(/\b([A-Za-z][A-Za-z\s.'-]{1,100}),\s{0,20}([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/)
  if (cityStateZip) return cityStateZip[1].trim()
  // Split by newlines, look for line with city, state ZIP pattern
  const lines = normalized.split(/\n/).map((l) => l.trim()).filter(Boolean)
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z\s.'-]{1,100}),?\s+[A-Z]{2}\s*\d{5}/)
    if (match) return match[1].trim()
  }
  return null
}

export function buildProfileSignals({ profile, sections, asOf = null, documents = [] }) {
  let asOfDate = null
  if (asOf) {
    const d = new Date(asOf)
    if (!Number.isNaN(d.getTime())) asOfDate = d
  }
  const nowMs = asOfDate ? asOfDate.getTime() : Date.now()
  const nowYear = asOfDate ? asOfDate.getFullYear() : new Date().getFullYear()

  const keywordSet = new Set()
  const phraseSet = new Set()
  const intentPhraseSet = new Set()
  const demographicSet = new Set()
  const genderSet = new Set()
  const assistanceSet = new Set()
  const militarySet = new Set()
  const interestSet = new Set()
  const applicantTypeSet = new Set()
  const healthSet = new Set()
  // PROVENANCE. `healthSet` is the historical UNION and stays exactly as it was —
  // ~14 downstream consumers test canonical tokens against it. But a union cannot
  // answer "is this a DIAGNOSIS?", and the coverage gap detector needs to: it asks
  // "does a disease-specific source lane exist for X?" for every member, which is a
  // sensible question for `epilepsy` and a nonsensical one for `lodging` (a support
  // need), `unsteady gait` (a symptom) or `mobility_needs` (a support flag). Prod
  // 2026-07-16 asked the owner to add a disease lane for all three.
  //
  // The fix cannot be a denylist: these are FREE TEXT (only trim+lowercase is
  // applied), so an exact-match Set can never catch them. Provenance is the only
  // thing that distinguishes them, and it is known at the write site — so record it
  // here rather than trying to re-derive intent downstream from a bare string.
  const healthConditionSet = new Set()  // diagnoses: conditions[], medical_history, disease flags
  const healthSupportSet = new Set()    // support needs / disability descriptors / support flags
  const familySet = new Set()
  const occupationSet = new Set()
  const needs = new Set()

  // Extract location from multiple sources including address strings
  const basic = sections?.basic_information ?? {}
  const comprehensive = sections?.comprehensive_application ?? {}
  const locationFocus = sections?.location_focus ?? {}
  const organizationDetails = sections?.organization_details ?? {}

  // The corroborated section reader comes first: a stray flat `zip_code`
  // (a live profile carried a Minneapolis ZIP beside two sources that agreed
  // on 37312) must not become the crawl thesis's location.
  const corroborated = readSectionLocation(sections)
  const location = {
    zip:
      corroborated.zip ||
      extractZipFromContext({ profile, sections }) ||
      extractZipFromAddress(basic.address) ||
      extractZipFromAddress(comprehensive.address),
    state:
      extractStateFromContext({ profile, sections }) ||
      extractStateFromAddress(basic.address) ||
      extractStateFromAddress(comprehensive.address),
    city:
      extractCityFromSections({ profile, sections }) ||
      extractCityFromAddress(basic.address) ||
      extractCityFromAddress(comprehensive.address),
    county: null,
  }

  // If we have ZIP but not state/city, derive from local ZIP database.
  // This is critical for matching: many opportunities are state-scoped and the scoring engine penalizes unknown state.
  //
  // …UNLESS the address is a PLACEHOLDER (2026-08-02). This branch fires only
  // when the state is empty, which is exactly what a placeholder address
  // becomes now that the inference regex no longer mints "SA" from "USA" — so
  // `{city:'Anytown', state:'USA', zip_code:'12345'}` would resolve to
  // Schenectady, NY: a real, plausible place the applicant has no connection
  // to, which is WORSE than an obviously-wrong one. `isFabricatedGeoSource`
  // requires TWO corroborating placeholder signals, so a real person at ZIP
  // 12345 (it is an assigned GE ZIP) still resolves normally.
  if (location.zip && !location.state && !isFabricatedGeoSource(location)) {
    try {
      const lookup = zipcodes.lookup(location.zip)
      if (lookup?.state) location.state = String(lookup.state).toUpperCase()
      if (lookup?.city && !location.city) location.city = String(lookup.city)
    } catch {
      // ignore
    }
  }

  // County is a durable "expand outward" geography signal:
  // city → county → state → national. Never fabricate it unless we can resolve
  // from an offline dataset — and never from a PLACEHOLDER address, for the
  // same reason as the state rescue above (ZIP 12345 → "Schenectady County").
  if (location.zip && !location.county && !isFabricatedGeoSource(location)) {
    try {
      const county = resolveCountyForZip(location.zip, location.state || null)
      if (county) location.county = county
    } catch {
      // ignore
    }
  }

  // ============ SECONDARY ADDRESS (multi-location profiles) ============
  // A person can have more than one address (student home vs. school, missionary
  // home vs. deployed, military home vs. duty station, travel nurse's two homes).
  // basic_information.secondary_address holds an optional second address. We resolve
  // it the same way as the primary and expose ALL distinct states/locations via
  // `states` / `locations` so geo-gating + local crawlers cover every location.
  // Absent secondary_address ⇒ identical to today's single-location behavior.
  const secondaryLocation = resolveSecondaryLocation(basic.secondary_address)

  // Distinct, primary-first list of locations and their states. Geo-gating and local
  // crawlers should read `states` (all locations) while `location.state` remains the
  // primary for back-compat.
  const locations = []
  if (location.state || location.zip || location.city) locations.push(location)
  if (secondaryLocation && (secondaryLocation.state || secondaryLocation.zip || secondaryLocation.city)) {
    locations.push(secondaryLocation)
  }
  const states = []
  const addState = (value) => {
    if (!value) return
    const raw = String(value).trim()
    if (!raw) return
    // Accept a 2-letter code directly, else parse a state out of a freeform
    // string: try an "XX 12345" address pattern first, then a full state name
    // ("Tennessee" → TN) so home/service states entered as names are covered.
    const st = raw.length === 2
      ? normalizeState(raw)
      : (extractStateFromAddress(raw) || normalizeState(raw) || normalizeStateFromText(raw) || null)
    if (st && st.length === 2 && !states.includes(st)) states.push(st)
  }
  for (const loc of locations) addState(loc?.state)

  // SERVICE-AREA state (canonical_rules G4): the geographic focus / service area
  // is where the profile DELIVERS services and is the PREFERRED geographic
  // signal. extractStateFromContext already promotes it into `location.state`
  // (so it is primary above), but we also parse it directly here so the
  // service-area state is in `states[]` even when `location.state` happened to
  // resolve from a ZIP/address. normalizeStateFromText pulls a full state name
  // out of freeform text like "Pine Ridge Reservation, South Dakota" → SD.
  for (const text of [
    locationFocus?.service_area, locationFocus?.geographic_focus,
    comprehensive?.geographic_focus,
  ]) {
    if (typeof text === 'string' && text.trim()) {
      const st = normalizeStateFromText(text)
      if (st && st.length === 2 && !states.includes(st)) states.push(st)
    }
  }

  // Mailing/home-address state still belongs in the coverage list (so home-state
  // sources remain eligible) but ranks AFTER the service area — it is appended
  // here, not unshifted ahead of it. When the profile has no service area this
  // is already the primary, so single-address profiles are unchanged.
  addState(extractStateFromAddress(basic.address))
  addState(extractStateFromAddress(comprehensive.address))
  for (const homeState of [basic?.state, comprehensive?.state, profile?.state]) {
    addState(homeState)
  }

  // STRICTLY ADDITIVE multi-location coverage for the CRAWL path. The primary +
  // basic.secondary_address are handled above; a second address (or extra service
  // states) may also live in location_focus / comprehensive_application, or as an
  // explicit states array. Fold them all in so local crawlers cover EVERY state
  // the profile touches, regardless of which field the address was entered in.
  // (Mirrors the matching path's `states` so crawl + match agree.) Single-address
  // profiles are unchanged.
  for (const sectionObj of [locationFocus, comprehensive, organizationDetails]) {
    const sec = resolveSecondaryLocation(sectionObj?.secondary_address)
    if (sec?.state) addState(sec.state)
  }
  for (const arr of [
    profile?.states, basic?.states, locationFocus?.states,
    locationFocus?.states_served, locationFocus?.service_states,
    organizationDetails?.states_served, organizationDetails?.service_states,
  ]) {
    if (Array.isArray(arr)) for (const v of arr) addState(v)
  }

  const academics = {
    gpa: null,
    act: null,
    sat: null,
    psat: null,
  }

  const financial = {
    householdIncome: null,
    householdSize: null,
    needLevel: null,
    fundingAmountNeeded: null,
  }

  const registerKeyword = (value) => {
    const normalized = normalizeString(value)
    if (!normalized) return
    // "unknown support needs", "none reported ..." — a composite built around
    // a placeholder is a placeholder.
    if (/^(?:unknown|none|n\/a|not (?:provided|specified|applicable|reported|available))\b/.test(normalized)) return
    phraseSet.add(normalized)
    addKeyword(keywordSet, normalized)
  }

  const registerKeywords = (values = []) => {
    if (!Array.isArray(values)) return
    values.forEach((value) => registerKeyword(value))
  }

  // ============ UPLOADED DOCUMENTS (mission statements, needs assessments) ============
  // The user's own documents are profile information too. Mine their salient
  // terms into keywordSet so they enrich matching AND (as the lowest-priority
  // facet) the live-source queries. Bounded + frequency-ranked to stay relatable.
  collectDocumentKeywords(documents, registerKeyword)

  // ============ COMPREHENSIVE APPLICATION (PROFILE TAB) ============
  // This section is intentionally stored as a single "full application" payload, but crawlers should still
  // benefit from it by extracting keywords, applicant type, and location signals.
  if (comprehensive?.applicant_type) {
    const normalized = normalizeString(comprehensive.applicant_type)
    if (normalized) applicantTypeSet.add(normalized)
    registerKeyword(comprehensive.applicant_type)
  }

  // Freeform keyword arrays from the comprehensive application form.
  registerKeywords(Array.isArray(comprehensive?.keywords) ? comprehensive.keywords : [])
  registerKeywords(Array.isArray(comprehensive?.focus_areas) ? comprehensive.focus_areas : [])

  // Intent phrases: multi-word goal/objective phrases (e.g. "food truck business") — highest priority for matching
  const goalLikeFields = [
    comprehensive?.primary_goal,
    comprehensive?.mission,
    profile?.primary_goal,
  ]
  goalLikeFields.forEach((val) => {
    if (!val || typeof val !== 'string') return
    val
      .split(/[,;]+/)
      .map((s) => normalizeString(s))
      .filter((s) => s.length >= 6 && s.includes(' '))
      .forEach((s) => intentPhraseSet.add(s))
  })

  // If the comprehensive application includes narrative fields, treat them as signal text.
  collectNarrativeKeywords(
    {
      mission: comprehensive?.mission,
      primary_goal: comprehensive?.primary_goal,
      target_population: comprehensive?.target_population,
      geographic_focus: comprehensive?.geographic_focus,
      funding_amount_needed: comprehensive?.funding_amount_needed,
      timeline: comprehensive?.timeline,
      past_experience: comprehensive?.past_experience,
      unique_qualities: comprehensive?.unique_qualities,
      collaboration_partners: comprehensive?.collaboration_partners,
      sustainability_plan: comprehensive?.sustainability_plan,
      barriers_faced: comprehensive?.barriers_faced,
      special_circumstances: comprehensive?.special_circumstances,
    },
    registerKeyword,
  )

  // ============ PROFILE TOP-LEVEL FIELDS ============
  const baseTags = Array.isArray(profile?.tags) ? profile.tags : []
  baseTags.forEach((tag) => {
    registerKeyword(tag)
    const normalized = normalizeString(tag)
    if (normalized) interestSet.add(normalized)
  })

  const baseInterests = Array.isArray(profile?.interests) ? profile.interests : []
  baseInterests.forEach((interest) => {
    registerKeyword(interest)
    interestSet.add(normalizeString(interest))
  })

  if (profile?.primary_type) {
    const normalized = normalizeString(profile.primary_type)
    applicantTypeSet.add(normalized)
    registerKeyword(profile.primary_type)
  }

  if (profile?.display_name) {
    // Extract keywords from display name (e.g., "Axiom Community Health Cooperative" -> community, health)
    const nameWords = profile.display_name.split(/\s+/).filter(w => w.length > 3)
    nameWords.forEach(word => registerKeyword(word))
  }

  // ============ BASIC INFORMATION ============
  if (basic.gender) {
    const normalizedGender = normalizeString(basic.gender)
    if (normalizedGender) {
      genderSet.add(normalizedGender)
      registerKeyword(normalizedGender)
      const synonyms = GENDER_SYNONYMS[normalizedGender]
      if (Array.isArray(synonyms)) {
        synonyms.forEach((synonym) => registerKeyword(synonym))
      }
    }
  }
  if (basic.age) {
    const age = parseNumber(basic.age)
    if (age !== null) {
      if (age < 18) { demographicSet.add('youth'); registerKeyword('youth'); registerKeyword('minor') }
      if (age >= 18 && age <= 24) { demographicSet.add('young_adult'); registerKeyword('young adult') }
      if (age >= 55) { demographicSet.add('senior'); registerKeyword('senior'); registerKeyword('elderly') }
      if (age >= 65) { registerKeyword('retiree') }
    }
  }
  if (basic.date_of_birth) {
    // Calculate age from DOB
    const dob = new Date(basic.date_of_birth)
    if (!isNaN(dob.getTime())) {
      const age = Math.floor((nowMs - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000))
      if (age < 18) { demographicSet.add('youth'); registerKeyword('youth') }
      if (age >= 18 && age <= 24) { demographicSet.add('young_adult'); registerKeyword('young adult') }
      if (age >= 55) { demographicSet.add('senior'); registerKeyword('senior') }
    }
  }
  // Extract keywords from website/email domain for organization matching
  if (basic.website) {
    const domain = basic.website.replace(/^https?:\/\//, '').split('/')[0].replace('www.', '')
    const domainName = domain.split('.')[0]
    if (domainName && domainName.length > 3) registerKeyword(domainName)
  }
  // Nationality — immigration/citizenship context
  if (hasTextValue(basic.nationality)) {
    registerKeyword(basic.nationality)
    if (/^us|united\s*states|american/i.test(basic.nationality)) {
      demographicSet.add('us_citizen')
    }
  }
  // Freeform notes — intake context that may mention needs
  if (hasTextValue(basic.notes)) {
    collectNarrativeKeywords({ notes: basic.notes }, registerKeyword)
  }

  // ============ FINANCIAL INFORMATION ============
  const financialSection = sections?.financial_information ?? {}
  if (financialSection.financial_need_level) {
    financial.needLevel = financialSection.financial_need_level
    registerKeyword(financialSection.financial_need_level)
    if (['High', 'Critical', 'Extreme'].includes(financialSection.financial_need_level)) {
      assistanceSet.add('high_financial_need')
      registerKeyword('financial hardship')
      registerKeyword('urgent need')
    }
  }
  if (financialSection.household_income) {
    financial.householdIncome = parseNumber(financialSection.household_income)
    if (financial.householdIncome !== null && financial.householdIncome < 50000) {
      assistanceSet.add('low_income')
      ASSISTANCE_SYNONYMS.low_income.forEach((label) => registerKeyword(label))
    }
    if (financial.householdIncome !== null && financial.householdIncome < 25000) {
      registerKeyword('poverty')
      registerKeyword('extremely low income')
    }
  }
  if (financialSection.household_size) {
    financial.householdSize = parseNumber(financialSection.household_size)
  }

  // Compute below_poverty_line from explicit field OR from income+size vs federal poverty guidelines.
  // 2024 FPL base: $15,060 for 1 person; +$5,380 per additional person.
  if (financialSection.below_poverty_line === true || financialSection.below_poverty_line === 'yes') {
    financial.below_poverty_line = true
  } else if (financial.householdIncome !== null && financial.householdSize !== null) {
    const fpl = 15060 + Math.max(0, financial.householdSize - 1) * 5380
    if (financial.householdIncome <= fpl) {
      financial.below_poverty_line = true
    }
  } else if (financial.householdIncome !== null && financial.householdIncome < 15060) {
    // Single person household implied when size unknown
    financial.below_poverty_line = true
  }
  if (financial.below_poverty_line) {
    assistanceSet.add('low_income')
    registerKeyword('poverty')
    registerKeyword('below poverty line')
  }

  if (financialSection.low_income) {
    assistanceSet.add('low_income')
    ASSISTANCE_SYNONYMS.low_income.forEach((label) => registerKeyword(label))
  }
  if (financialSection.unemployed) {
    assistanceSet.add('unemployed')
    registerKeyword('unemployed')
    registerKeyword('job seeker')
  }
  if (financialSection.displaced_worker) {
    assistanceSet.add('displaced_worker')
    registerKeyword('displaced worker')
    registerKeyword('laid off')
  }
  if (financialSection.notes) {
    collectNarrativeKeywords({ notes: financialSection.notes }, registerKeyword)
  }
  if (hasTextValue(financialSection.employment_status)) {
    registerKeyword(financialSection.employment_status)
    if (financialSection.employment_status === 'unemployed') {
      assistanceSet.add('unemployed')
      registerKeyword('job seeker')
    }
  }
  if (financialSection.has_medical_debt) { assistanceSet.add('medical_debt'); registerKeyword('medical_debt'); registerKeyword('healthcare_debt_relief') }
  if (financialSection.has_education_debt) { assistanceSet.add('student_loan'); registerKeyword('student_loan'); registerKeyword('loan_forgiveness') }
  if (financialSection.bankruptcy_foreclosure) { assistanceSet.add('financial_recovery'); registerKeyword('bankruptcy'); registerKeyword('foreclosure'); registerKeyword('financial_recovery') }
  if (financialSection.first_time_homebuyer) { assistanceSet.add('first_time_homebuyer'); registerKeyword('first_time_homebuyer'); registerKeyword('down_payment_assistance') }
  if (financialSection.underemployed) { assistanceSet.add('underemployed'); registerKeyword('underemployed'); registerKeyword('workforce'); registerKeyword('job_training') }

  // --- Funding needs / purpose: what the applicant needs money for ---
  // Controlled TAG form (2026-07-07): funding_needs is now a tags array of
  // canonical need buckets (backend/config/profileVocabulary.js `needs`). Each
  // tag is read as a clean need data point — normalized through the matcher's
  // own NEED_ALIAS_MAP so a custom/legacy value still resolves. Tags are NOT
  // mined as free-text keywords (structured, not prose).
  if (Array.isArray(financialSection.funding_needs)) {
    for (const tag of financialSection.funding_needs) {
      if (typeof tag !== 'string') continue
      const canonical = normalizeNeedCategory(tag)
      if (canonical) needs.add(canonical)
    }
  }
  if (hasTextValue(financialSection.funding_needs)) {
    collectNarrativeKeywords({ funding_needs: financialSection.funding_needs }, registerKeyword)
    const fnLower = financialSection.funding_needs.toLowerCase()
    // Map explicit funding needs to canonical need categories
    const fundingNeedKeywords = {
      housing: ['rent', 'housing', 'mortgage', 'eviction', 'home repair'],
      food: ['food', 'groceries', 'nutrition'],
      utilities: ['utility', 'utilities', 'electric', 'gas', 'water', 'heating'],
      healthcare: ['medical', 'health', 'prescription', 'treatment', 'therapy', 'copay'],
      education: ['tuition', 'school', 'college', 'education', 'textbook'],
      transportation: ['transportation', 'vehicle', 'car', 'bus', 'gas money'],
      childcare: ['childcare', 'daycare', 'child care', 'after school'],
      disability: ['disability', 'wheelchair', 'adaptive', 'assistive'],
      business: ['business', 'startup', 'equipment', 'inventory'],
      legal: ['legal', 'attorney', 'court'],
    }
    // Whole-word only: 'rent' ⊂ "parent", 'car' ⊂ "care", 'bus' ⊂ "business"
    // were fabricating needs out of unrelated funding_needs narratives.
    for (const [need, triggers] of Object.entries(fundingNeedKeywords)) {
      if (triggers.some(t => containsTermWholeWord(fnLower, t))) needs.add(need)
    }
  }
  if (hasTextValue(financialSection.funding_purpose)) {
    collectNarrativeKeywords({ funding_purpose: financialSection.funding_purpose }, registerKeyword)
  }

  // --- Receives assistance: current benefits/programs ---
  if (financialSection.receives_assistance) {
    const assistList = typeof financialSection.receives_assistance === 'string'
      ? financialSection.receives_assistance.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean)
      : Array.isArray(financialSection.receives_assistance)
        ? financialSection.receives_assistance
        : []
    for (const prog of assistList) {
      const norm = normalizeString(prog)
      if (!norm) continue
      registerKeyword(norm)
      // Map common program names to assistance flags
      if (/snap|food.?stamp/i.test(norm)) { assistanceSet.add('snap_recipient'); needs.add('food') }
      if (/tanf/i.test(norm)) { assistanceSet.add('tanf_recipient'); needs.add('cash_assistance') }
      if (/medicaid/i.test(norm)) { assistanceSet.add('medicaid') }
      if (/medicare/i.test(norm)) { assistanceSet.add('medicare') }
      if (/ssi(?!d)/i.test(norm)) { assistanceSet.add('ssi_recipient'); needs.add('disability') }
      if (/ssdi/i.test(norm)) { assistanceSet.add('ssdi_recipient'); needs.add('disability') }
      if (/section.?8|housing.?voucher/i.test(norm)) { assistanceSet.add('section8_housing'); needs.add('housing') }
      if (/wic/i.test(norm)) { assistanceSet.add('wic'); needs.add('food') }
      if (/liheap|energy.?assist/i.test(norm)) { assistanceSet.add('liheap'); needs.add('utilities') }
    }
  }
  if (hasTextValue(financialSection.assistance_notes)) {
    collectNarrativeKeywords({ assistance_notes: financialSection.assistance_notes }, registerKeyword)
  }

  // --- Annual income (individual): supplement household income for poverty detection ---
  if (financialSection.annual_income && !financial.householdIncome) {
    const annualIncome = parseNumber(financialSection.annual_income)
    if (annualIncome !== null) {
      // Use annual_income as proxy when household_income is missing
      financial.householdIncome = annualIncome
      if (annualIncome < 50000) {
        assistanceSet.add('low_income')
        ASSISTANCE_SYNONYMS.low_income.forEach((label) => registerKeyword(label))
      }
      if (annualIncome < 25000) {
        registerKeyword('poverty')
        registerKeyword('extremely low income')
      }
    }
  }

  // ============ GOVERNMENT ASSISTANCE ============
  const government = sections?.government_assistance ?? {}
  Object.entries(ASSISTANCE_SYNONYMS).forEach(([flag, labels]) => {
    if (government[flag]) {
      assistanceSet.add(flag)
      labels.forEach((label) => registerKeyword(label))
    }
  })
  // Medicaid enrollment (not in ASSISTANCE_SYNONYMS)
  if (government.medicaid_enrolled) {
    assistanceSet.add('medicaid')
    registerKeyword('medicaid')
    registerKeyword('healthcare assistance')
  }
  if (government.medicare_recipient) {
    assistanceSet.add('medicare')
    registerKeyword('medicare')
  }
  // Waiver membership hides in FREE TEXT: real profiles carry
  // "Medicaid Waiver Program (ECF CHOICES - TN)" only in
  // government_assistance.other_programs (or medical_insurance.notes) while
  // the structured medicaid_waiver_program field stays empty — so the
  // ECF/HCBS membership never became a signal and the waiver lane never fired
  // (the Gilbert/Kim class, 2026-07-07). Whole-word scan the free text with
  // the same canonical markers the structured branch below uses; these
  // assistance flags become data points automatically (profileDataPoints.js,
  // kind 'assistance').
  const deriveWaiverSignalsFromText = (text) => {
    const value = String(text || '')
    if (!value.trim()) return
    const isEcf =
      containsAffirmedTermWholeWord(value, 'ecf') ||
      containsAffirmedTermWholeWord(value, 'ecf choices') ||
      containsTermWholeWord(value, 'employment and community first')
    const isHcbs =
      containsTermWholeWord(value, 'hcbs') ||
      containsTermWholeWord(value, 'home and community based services')
    const isWaiver = isEcf || isHcbs || containsTermWholeWord(value, 'medicaid waiver')
    if (!isWaiver) return
    assistanceSet.add('medicaid_waiver')
    registerKeyword('medicaid waiver')
    needs.add('disability')
    needs.add('healthcare')
    if (isHcbs) {
      registerKeyword('hcbs')
      registerKeyword('home community based services')
    }
    if (isEcf) {
      assistanceSet.add('ecf_choices')
      registerKeyword('ecf choices')
      registerKeyword('ecf_choices')
      registerKeyword('employment and community first')
      needs.add('employment')
    }
  }
  // Other programs as free text
  if (hasTextValue(government.other_programs)) {
    collectNarrativeKeywords({ other_programs: government.other_programs }, registerKeyword)
    // Also register the whole thing as a keyword if short
    if (government.other_programs.length < 100) {
      registerKeyword(government.other_programs)
    }
    deriveWaiverSignalsFromText(government.other_programs)
  }
  // Medicaid waiver program — e.g., "ecf_choices", "HCBS", "Katie Beckett"
  if (hasTextValue(government.medicaid_waiver_program)) {
    const waiver = normalizeString(government.medicaid_waiver_program)
    if (waiver) {
      registerKeyword(waiver)
      registerKeyword('medicaid waiver')
      assistanceSet.add('medicaid_waiver')
      if (/ecf|choices/i.test(waiver)) {
        registerKeyword('ecf choices')
        registerKeyword('ecf_choices')
        assistanceSet.add('ecf_choices')
        needs.add('healthcare')
        needs.add('disability')
      }
      if (/hcbs/i.test(waiver)) {
        registerKeyword('hcbs')
        registerKeyword('home community based services')
      }
    }
  }
  // ECF CHOICES role — participant, caregiver, or provider
  if (hasTextValue(government.ecf_choices_role)) {
    const role = normalizeString(government.ecf_choices_role)
    if (role) {
      registerKeyword('ecf choices ' + role)
      registerKeyword('ecf_choices')
      assistanceSet.add('ecf_choices')
      if (role === 'caregiver') {
        familySet.add('caregiver')
        registerKeyword('caregiver')
      }
    }
  }

  // ============ HEALTH/MEDICAL ============
  const health = sections?.health_medical ?? {}
  const disabilityTypes = Array.isArray(health.disability_type) ? health.disability_type : []
  registerKeywords(disabilityTypes)
  // A disability TYPE describes function ("physical", "unsteady gait"), not a
  // diagnosis — no disease lane can ever name it.
  disabilityTypes.forEach((dt) => {
    const n = normalizeString(dt)
    if (!n) return
    healthSet.add(n)
    healthSupportSet.add(n)
  })

  // Structured conditions (array of objects). Accept legacy/string formats too.
  const rawConditions = Array.isArray(health.conditions) ? health.conditions : []
  for (const entry of rawConditions) {
    const name =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? entry.name
          : null
    const normalized = normalizeString(name)
    if (!normalized) continue
    healthSet.add(normalized)
    // The conditions[] field is where a DIAGNOSIS lives — the one health signal
    // for which "is there a disease-specific source lane?" is a fair question.
    healthConditionSet.add(normalized)
    registerKeyword(normalized)
  }

  // Support needs (array<string>) - feed both keyword + assistance signals (non-exclusive).
  const rawSupportNeeds =
    Array.isArray(health.support_needs)
      ? health.support_needs
      : typeof health.support_needs === 'string'
        ? health.support_needs.split(/[,;\n]+/).map((v) => v.trim()).filter(Boolean)
        : []
  for (const need of rawSupportNeeds) {
    const normalized = normalizeString(need)
    if (!normalized) continue
    registerKeyword(normalized)
    assistanceSet.add(normalized.replace(/\s+/g, '_'))
    // Also include in health for condition-aware matching.
    healthSet.add(normalized)
    // ...but a support NEED ("lodging", "transportation", "copay_assistance") is
    // logistics, not a diagnosis. This is the provenance that stops the coverage
    // scoreboard demanding a "lodging disease lane" (prod 2026-07-16).
    healthSupportSet.add(normalized)
  }

  if (health.mobility_or_transport_notes) {
    collectNarrativeKeywords({ mobility_or_transport_notes: health.mobility_or_transport_notes }, registerKeyword)
    // Add a couple generic transport keywords to help resource matching.
    registerKeyword('transportation')
    registerKeyword('appointment transportation')
  }

  if (health.dialysis_patient) { healthSet.add('dialysis'); registerKeyword('dialysis'); registerKeyword('kidney disease') }
  if (health.organ_transplant) { healthSet.add('transplant'); registerKeyword('organ transplant'); registerKeyword('transplant recipient') }
  if (health.hiv_aids) { healthSet.add('hiv'); registerKeyword('hiv'); registerKeyword('aids') }
  if (health.tbi_survivor) { healthSet.add('tbi'); registerKeyword('traumatic brain injury'); registerKeyword('tbi') }
  if (health.amputee) { healthSet.add('amputee'); registerKeyword('amputee'); registerKeyword('prosthetic') }
  if (health.wheelchair_user) { healthSet.add('wheelchair'); registerKeyword('wheelchair user'); registerKeyword('mobility impairment') }
  if (health.neurodivergent) { healthSet.add('neurodivergent'); registerKeyword('neurodivergent'); registerKeyword('autism'); registerKeyword('adhd') }
  if (health.mental_health_condition) { healthSet.add('mental_health'); registerKeyword('mental health'); registerKeyword('behavioral health') }
  if (health.chronic_illness) { healthSet.add('chronic_illness'); registerKeyword('chronic illness'); registerKeyword('chronic condition') }
  if (hasTextValue(health.chronic_illness_type)) { registerKeyword(health.chronic_illness_type) }
  if (health.rare_disease) { healthSet.add('rare_disease'); registerKeyword('rare disease'); registerKeyword('orphan disease') }
  if (health.visual_impairment) { healthSet.add('visual_impairment'); registerKeyword('visual impairment'); registerKeyword('blind'); registerKeyword('low vision') }
  if (health.hearing_impairment) { healthSet.add('hearing_impairment'); registerKeyword('hearing impairment'); registerKeyword('deaf'); registerKeyword('hard of hearing') }
  if (health.cancer_survivor) { healthSet.add('cancer'); registerKeyword('cancer survivor'); registerKeyword('oncology') }
  if (health.substance_recovery) { healthSet.add('recovery'); registerKeyword('recovery'); registerKeyword('substance recovery'); registerKeyword('sober living') }
  if (health.terminal_illness) { healthSet.add('terminal'); registerKeyword('terminal illness'); registerKeyword('hospice') }
  if (hasTextValue(health.support_needs_level)) {
    registerKeyword(health.support_needs_level + ' support needs')
    if (['High', 'Critical'].includes(health.support_needs_level)) {
      healthSet.add('high_support_needs')
      registerKeyword('intensive support')
    }
  }
  if (health.notes) {
    collectNarrativeKeywords({ notes: health.notes }, registerKeyword)
  }

  // ============ DEMOGRAPHICS ============
  const demographicsSection = sections?.demographics ?? {}
  Object.entries(DEMOGRAPHIC_SYNONYMS).forEach(([flag, labels]) => {
    if (demographicsSection[flag]) {
      demographicSet.add(flag)
      labels.forEach((label) => registerKeyword(label))
    }
  })
  if (hasTextValue(demographicsSection.immigrant_status)) {
    const statusLabel = demographicsSection.immigrant_status.replace(/_/g, ' ')
    demographicSet.add(demographicsSection.immigrant_status)
    registerKeyword(statusLabel)
    if (['refugee', 'asylee', 'daca'].includes(demographicsSection.immigrant_status.toLowerCase())) {
      registerKeyword('new american')
      registerKeyword('immigrant')
    }
  }
  if (hasTextValue(demographicsSection.tribal_affiliation)) {
    registerKeyword(demographicsSection.tribal_affiliation)
    demographicSet.add('tribal_affiliation')
    registerKeyword('tribal affiliation')
  }
  if (hasTextValue(demographicsSection.ethnicity)) {
    registerKeyword(demographicsSection.ethnicity)
  }
  if (hasTextValue(demographicsSection.race)) {
    registerKeyword(demographicsSection.race)
  }
  if (demographicsSection.first_generation) {
    demographicSet.add('first_generation')
    registerKeyword('first generation')
    registerKeyword('first gen')
  }
  if (demographicsSection.notes) {
    collectNarrativeKeywords({ notes: demographicsSection.notes }, registerKeyword)
  }
  // Cultural/ethnic heritage — unlocks heritage-specific scholarships and grants
  if (demographicsSection.jewish_heritage) { registerKeyword('jewish_heritage'); registerKeyword('jewish'); registerKeyword('hillel') }
  if (demographicsSection.irish_heritage) { registerKeyword('irish_heritage'); registerKeyword('irish_american') }
  if (demographicsSection.italian_heritage) { registerKeyword('italian_heritage'); registerKeyword('italian_american') }
  if (demographicsSection.greek_heritage) { registerKeyword('greek_heritage'); registerKeyword('greek_american'); registerKeyword('ahepa') }
  if (demographicsSection.armenian_heritage) { registerKeyword('armenian_heritage'); registerKeyword('armenian_american') }
  if (demographicsSection.appalachian_heritage) { registerKeyword('appalachian_heritage'); registerKeyword('appalachian'); registerKeyword('arc') }
  if (hasTextValue(demographicsSection.religious_denomination)) {
    registerKeyword(demographicsSection.religious_denomination.toLowerCase().replace(/\s+/g, '_'))
    registerKeyword('denominational_scholarship')
  }
  if (demographicsSection.lgbtq) { registerKeyword('lgbtq'); registerKeyword('lgbtq_scholarship'); registerKeyword('queer') }
  if (demographicsSection.good_credit_score) { registerKeyword('good_credit'); registerKeyword('financial_literacy') }
  // General heritage field (free text)
  if (hasTextValue(demographicsSection.heritage)) {
    registerKeyword(demographicsSection.heritage)
  }
  // Citizenship / US citizen — programs requiring citizenship
  if (hasTextValue(demographicsSection.citizenship)) {
    registerKeyword(demographicsSection.citizenship)
    if (/^us|united\s*states|american/i.test(demographicsSection.citizenship)) {
      demographicSet.add('us_citizen')
    }
  }
  if (demographicsSection.us_citizen) {
    demographicSet.add('us_citizen')
  }
  // Disability status (high-level descriptor) — supplements health_medical section
  if (hasTextValue(demographicsSection.disability_status)) {
    const ds = normalizeString(demographicsSection.disability_status)
    if (ds && ds !== 'none' && ds !== 'unknown') {
      healthSet.add('disability')
      registerKeyword(ds)
      registerKeyword('disability')
      needs.add('disability')
    }
  }
  // Veteran status (high-level descriptor) — supplements military_service section
  if (hasTextValue(demographicsSection.veteran_status)) {
    const vs = normalizeString(demographicsSection.veteran_status)
    if (vs && vs !== 'none' && vs !== 'unknown' && vs !== 'not a veteran') {
      militarySet.add('veteran')
      registerKeyword('veteran')
    }
  }
  // Languages — language-specific programs and services
  if (demographicsSection.languages) {
    const langs = typeof demographicsSection.languages === 'string'
      ? demographicsSection.languages.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean)
      : Array.isArray(demographicsSection.languages) ? demographicsSection.languages : []
    // `non_english_speaker` is an ABSENCE of English, not the presence of a
    // second language: a live profile listing ["English", "Russian"] (fluent
    // in both, per its own narrative) was flagged non-English-speaking and
    // handed ESL vocabulary (2026-09-05). Bilingual stays a keyword.
    const normLangs = langs.map((lang) => normalizeString(lang)).filter(Boolean)
    const speaksEnglish = normLangs.some((norm) => /^english\b/.test(norm))
    for (const norm of normLangs) {
      if (norm === 'english') continue
      registerKeyword(norm)
      registerKeyword('bilingual')
      if (!speaksEnglish) {
        demographicSet.add('non_english_speaker')
        registerKeyword('esl')
      }
    }
  }
  // Religious affiliation — faith-based programs
  if (hasTextValue(demographicsSection.religious_affiliation)) {
    const affil = normalizeString(demographicsSection.religious_affiliation)
    if (affil) {
      registerKeyword(affil)
      registerKeyword('faith_based')
    }
  }
  // White/Caucasian demographic flag
  if (demographicsSection.white_caucasian) {
    demographicSet.add('white_caucasian')
  }

  // ============ FAMILY LIFE ============
  const family = sections?.family_life ?? {}
  // Include canonical schema keys plus a few legacy aliases that exist in older data.
  const familyFlags = [
    'single_parent',
    'foster_youth',
    'orphan',
    'adopted',
    'foster_parent',
    'caregiver',
    'widow_widower',
    'grandparent_raising_grandchildren',
    'first_time_parent',
    'homeless',
    'domestic_violence_survivor',
    'trafficking_survivor',
    'disaster_survivor',
    'formerly_incarcerated',
    // Legacy aliases (not in schema but seen in older records)
    'former_incarcerated',
    'widowed',
    'grandparent_caregiver',
    'kinship_care',
  ]
  familyFlags.forEach((flag) => {
    if (family[flag]) {
      familySet.add(flag)
      registerKeyword(flag.replace(/_/g, ' '))
    }
  })
  if (family.child_count && parseNumber(family.child_count) > 0) {
    familySet.add('parent')
    registerKeyword('parent')
    registerKeyword('children')
    if (parseNumber(family.child_count) >= 3) {
      registerKeyword('large family')
    }
  }
  if (family.dependents && parseNumber(family.dependents) > 0) {
    registerKeyword('dependents')
  }
  if (family.notes) {
    collectNarrativeKeywords({ notes: family.notes }, registerKeyword)
  }
  if (family.first_time_parent || family.foster_youth) {
    assistanceSet.add('family_support')
  }
  if (family.homeless) {
    assistanceSet.add('homeless')
    registerKeyword('housing insecure')
    registerKeyword('unhoused')
  }

  // ============ MILITARY SERVICE ============
  const military = sections?.military_service ?? {}
  Object.entries(MILITARY_FLAGS).forEach(([flag, labels]) => {
    if (military[flag]) {
      militarySet.add(flag)
      labels.forEach((label) => registerKeyword(label))
    }
  })
  if (hasTextValue(military.military_branch)) {
    registerKeyword(military.military_branch)
    militarySet.add(normalizeString(military.military_branch))
  }
  if (hasTextValue(military.service_era)) {
    registerKeyword(military.service_era)
    if (['vietnam', 'korea', 'wwii', 'gulf_war', 'oef', 'oif'].includes(normalizeString(military.service_era))) {
      registerKeyword('war veteran')
    }
  }
  if (hasTextValue(military.discharge_status)) {
    registerKeyword(military.discharge_status)
  }
  if (military.va_disability_rating) {
    const rating = parseNumber(military.va_disability_rating)
    if (rating !== null && rating > 0) {
      militarySet.add('service_connected_disability')
      registerKeyword('service connected disability')
      registerKeyword('va disability')
    }
  }

  // ============ OCCUPATION ============
  const occupation = sections?.occupation ?? {}
  Object.entries(occupation).forEach(([key, value]) => {
    if (!value) return
    if (key === 'healthcare_worker_type' && typeof value === 'string') {
      occupationSet.add(normalizeString(value))
      registerKeyword(value)
      const cred = normalizeString(value)
      if (/\b(rn|lpn|lvn|np|crna|cnm|cna|md|do|pa|lcsw|lmft|lpc|pharmd|pt|ot|slp|rd|rt)\b/.test(cred)) {
        needs.add('professional_development_continuing_education')
        needs.add('healthcare')
        needs.add('employment')
      }
      // Board remediation / reinstatement defaults apply to fully licensed roles,
      // not entry-level certifications like CNA seeking advancement training.
      if (/\b(rn|lpn|lvn|np|crna|cnm|md|do|pa|lcsw|lmft|lpc|pharmd|pt|ot|slp|rd|rt)\b/.test(cred)) {
        needs.add('license_reinstatement_support')
        needs.add('professional_remediation_funding')
      }
      return
    }
    if (key === 'job_title' && typeof value === 'string') {
      occupationSet.add(normalizeString(value))
      registerKeyword(value)
      return
    }
    if (key === 'employer' && typeof value === 'string') {
      registerKeyword(value)
      return
    }
    if (key === 'industry' && typeof value === 'string') {
      occupationSet.add(normalizeString(value))
      registerKeyword(value)
      return
    }
    if (key === 'notes' && typeof value === 'string') {
      collectNarrativeKeywords({ notes: value }, registerKeyword)
      return
    }
    if (value === true) {
      occupationSet.add(key)
      registerKeyword(key.replace(/_/g, ' '))
    }
    if (Array.isArray(value)) {
      registerKeywords(value)
      value.forEach(v => occupationSet.add(normalizeString(v)))
    }
  })

  // ============ CREDENTIALS / LICENSED PROFESSIONAL DETECTION ============
  // Look across occupation, narrative, basic_information.title, demographics
  // and the profile.display_name for healthcare / mental-health / legal /
  // education credential abbreviations. When found, the profile gets the
  // "professional_development" need bucket so opportunities like WIOA ITA,
  // state nursing foundations, and CE scholarships surface even when the
  // user's free-text query is generic — per spec "Profile-Aware Defaults".
  const credentialsSet = new Set()
  const CREDENTIAL_PATTERN = /\b(RN|LPN|APRN|CNA|MD|DO|MBBS|PA|PA-C|NP|FNP|DNP|CRNA|LCSW|LMSW|LSW|MSW|LPC|LMFT|LMHC|LCDC|LADC|PsyD|PhD|EdD|DDS|DMD|RDH|PharmD|RPh|DPT|PT|OT|OTR|SLP|RN-BC|EMT|EMT-P|paramedic|firefighter|teacher\s+credential|teaching\s+license|esthetician|cosmetolog(ist|y)|attorney|esquire|engineer\s+\(P\.?E\.?\)|cpa|enrolled agent)\b/gi
  const credentialSources = [
    profile?.display_name,
    profile?.name,
    basic?.full_name,
    basic?.title,
    basic?.profile_name,
    occupation?.notes,
    occupation?.job_title,
    occupation?.healthcare_worker_type,
    occupation?.industry,
    sections?.narrative?.story,
    sections?.narrative?.background,
    sections?.narrative?.primary_goal,
    sections?.narrative?.barriers_faced,
    sections?.narrative?.mission,
    sections?.narrative?.notes,
    sections?.demographics?.profession,
    sections?.demographics?.occupation,
    sections?.demographics?.notes,
    sections?.basic_information?.notes,
    sections?.basic_information?.profession,
  ]
  for (const src of credentialSources) {
    if (typeof src !== 'string' || src.length === 0) continue
    const matches = src.match(CREDENTIAL_PATTERN) || []
    for (const m of matches) credentialsSet.add(m.toUpperCase().replace(/\s+/g, ' '))
  }
  // Healthcare-worker_type values like "registered_nurse" / "licensed_clinical_social_worker"
  // also imply credentials; capture them as canonical labels so the matcher
  // exposes credential-aware messaging.
  const HCW_TYPE_TO_CREDENTIAL = {
    registered_nurse: 'RN',
    licensed_practical_nurse: 'LPN',
    advanced_practice_nurse: 'APRN',
    nurse_practitioner: 'NP',
    physician: 'MD',
    physician_assistant: 'PA',
    medical_doctor: 'MD',
    doctor: 'MD',
    licensed_clinical_social_worker: 'LCSW',
    licensed_master_social_worker: 'LMSW',
    licensed_social_worker: 'LSW',
    licensed_professional_counselor: 'LPC',
    licensed_marriage_family_therapist: 'LMFT',
    licensed_mental_health_counselor: 'LMHC',
    physical_therapist: 'PT',
    occupational_therapist: 'OT',
    speech_language_pathologist: 'SLP',
    pharmacist: 'RPH',
    dentist: 'DDS',
    dental_hygienist: 'RDH',
  }
  const hcwType = String(occupation?.healthcare_worker_type || '').toLowerCase()
  if (hcwType && HCW_TYPE_TO_CREDENTIAL[hcwType]) {
    credentialsSet.add(HCW_TYPE_TO_CREDENTIAL[hcwType])
  }
  // Demographics-level explicit profession field (some forms collect it).
  const demoProfession = String(sections?.demographics?.profession || '').toLowerCase()
  for (const key of Object.keys(HCW_TYPE_TO_CREDENTIAL)) {
    if (demoProfession === key) credentialsSet.add(HCW_TYPE_TO_CREDENTIAL[key])
  }

  if (credentialsSet.size > 0) {
    // Tag profile-level keywords/intent so the matcher's keyword overlap
    // contributes a positive score on professional-development funding.
    registerKeyword('licensed professional')
    registerKeyword('professional development')
    registerKeyword('continuing education')
    registerKeyword('licensure')
    intentPhraseSet.add('professional development')
    intentPhraseSet.add('continuing education')
    // Add a soft applicant-type tag so downstream scoring recognizes the
    // licensed-professional bucket without breaking the canonical
    // primary_type contract.
    applicantTypeSet.add('licensed_professional')
    // Healthcare credentials get extra workforce-board hints because WIOA ITA
    // is the dominant funding pathway for nurse / allied-health CE.
    const isHealthcareCredential = ['RN', 'LPN', 'APRN', 'CNA', 'NP', 'FNP', 'DNP', 'CRNA', 'MD', 'DO', 'PA', 'PT', 'OT', 'SLP', 'RDH', 'DDS', 'DMD', 'PHARM', 'RPH']
      .some((c) => credentialsSet.has(c) || credentialsSet.has(`${c}-BC`))
    if (isHealthcareCredential) {
      registerKeyword('healthcare worker')
      registerKeyword('wioa training')
      registerKeyword('individual training account')
      registerKeyword('workforce training board')
      registerKeyword('vocational rehabilitation')
      occupationSet.add('healthcare_worker')
    }
  }

  // ============ LOCATION FOCUS ============
  if (hasTextValue(locationFocus.geographic_focus)) {
    registerKeyword(locationFocus.geographic_focus)
  }
  if (hasTextValue(locationFocus.service_area)) {
    registerKeyword(locationFocus.service_area)
  }
  if (locationFocus.counties_served && Array.isArray(locationFocus.counties_served)) {
    locationFocus.counties_served.forEach(county => registerKeyword(county))
  }
  if (locationFocus.notes) {
    collectNarrativeKeywords({ notes: locationFocus.notes }, registerKeyword)
  }
  if (locationFocus.rural_resident) { registerKeyword('rural'); demographicSet.add('rural') }
  if (locationFocus.urban_underserved) { registerKeyword('urban underserved'); demographicSet.add('urban_underserved') }
  if (locationFocus.appalachian_region) {
    registerKeyword('appalachian')
    registerKeyword('appalachia')
    demographicSet.add('appalachian')
  }
  if (locationFocus.tribal_land) {
    registerKeyword('tribal')
    registerKeyword('reservation')
    demographicSet.add('tribal')
  }
  if (locationFocus.frontier_community) {
    registerKeyword('frontier')
    registerKeyword('remote')
    demographicSet.add('frontier')
  }

  // ============ ORGANIZATION DETAILS ============
  if (organizationDetails.organization_type) {
    // Keep the specific organization identity available to discovery, but do
    // not count it again as a broad applicant-type fact. The dedicated
    // organization data point owns this evidence exactly once.
    registerKeyword(organizationDetails.organization_type)
  }
  if (organizationDetails.nicra_rate) {
    // NICRA = Negotiated Indirect Cost Rate Agreement (common for federal compliance).
    registerKeyword('nicra')
    registerKeyword(organizationDetails.nicra_rate)
    registerKeyword(`nicra ${organizationDetails.nicra_rate}`)
  }
  if (hasTextValue(organizationDetails.audit_status)) {
    registerKeyword(organizationDetails.audit_status)
  }
  if (organizationDetails.mission) {
    collectNarrativeKeywords({ mission: organizationDetails.mission }, registerKeyword)
  }
  if (organizationDetails.ein) {
    // Has EIN = likely 501c3
    registerKeyword('501c3')
    registerKeyword('nonprofit')
  }
  if (organizationDetails.founding_year) {
    const age = nowYear - parseNumber(organizationDetails.founding_year)
    if (age !== null && age <= 3) {
      registerKeyword('new organization')
      registerKeyword('startup nonprofit')
    }
  }
  if (organizationDetails.annual_budget) {
    const budget = parseNumber(organizationDetails.annual_budget)
    if (budget !== null) {
      if (budget < 100000) registerKeyword('small nonprofit')
      if (budget < 500000) registerKeyword('grassroots')
      if (budget >= 1000000) registerKeyword('established nonprofit')
    }
  }
  if (organizationDetails.staff_count) {
    const staff = parseNumber(organizationDetails.staff_count)
    if (staff !== null && staff <= 5) {
      registerKeyword('small organization')
    }
  }
  if (organizationDetails.programs_offered && Array.isArray(organizationDetails.programs_offered)) {
    organizationDetails.programs_offered.forEach(prog => registerKeyword(prog))
  }

  // --- Compliance signals — each one unlocks specific grant eligibility ---
  if (organizationDetails.sam_gov_registered) { registerKeyword('sam_gov_registered'); registerKeyword('federal_eligible') }
  if (organizationDetails.grants_gov_account) { registerKeyword('grants_gov_account') }
  if (organizationDetails.era_commons_account) { registerKeyword('era_commons'); registerKeyword('nih_eligible'); registerKeyword('health_research') }
  if (organizationDetails.nicra_rate > 0) { registerKeyword('indirect_cost_rate'); registerKeyword('nicra') }
  if (organizationDetails.ntee_code) { registerKeyword(organizationDetails.ntee_code.toLowerCase()) }
  if (organizationDetails.is_faith_based) { registerKeyword('faith_based'); registerKeyword('church'); registerKeyword('religious_org') }
  if (organizationDetails.is_rural_serving) { registerKeyword('rural'); registerKeyword('rural_serving') }
  if (organizationDetails.is_minority_serving) { registerKeyword('minority_serving'); registerKeyword('msi') }
  // Business certifications — critical for set-aside contracts and grants
  if (organizationDetails.cert_8a) { registerKeyword('8a_certified'); registerKeyword('sba_8a'); registerKeyword('disadvantaged_business') }
  if (organizationDetails.cert_hubzone) { registerKeyword('hubzone'); registerKeyword('historically_underutilized') }
  if (organizationDetails.cert_sdvosb) { registerKeyword('sdvosb'); registerKeyword('veteran_owned_business') }
  if (organizationDetails.cert_mbe) { registerKeyword('minority_owned_business'); registerKeyword('mbe') }
  if (organizationDetails.cert_wbe) { registerKeyword('women_owned_business'); registerKeyword('wbe') }
  if (organizationDetails.cert_sbir_sttr) { registerKeyword('sbir'); registerKeyword('sttr'); registerKeyword('research_innovation') }
  // Geographic designations — grant eligibility multipliers
  if (organizationDetails.in_opportunity_zone) { registerKeyword('opportunity_zone'); registerKeyword('oz_investment') }
  if (organizationDetails.in_qct) { registerKeyword('qualified_census_tract'); registerKeyword('qct'); registerKeyword('low_income_community') }
  if (organizationDetails.in_epa_ej_area) { registerKeyword('environmental_justice'); registerKeyword('ej_community') }
  if (organizationDetails.in_usda_persistent_poverty_county) { registerKeyword('persistent_poverty'); registerKeyword('rural_poverty') }
  if (organizationDetails.in_appalachian_region) { registerKeyword('appalachian_region'); registerKeyword('arc'); registerKeyword('appalachian') }
  if (organizationDetails.broadband_unserved) { registerKeyword('broadband_unserved'); registerKeyword('digital_equity'); registerKeyword('reconnect') }
  // Specialized org types
  if (organizationDetails.is_tribal_government) { registerKeyword('tribal_government'); registerKeyword('federally_recognized_tribe'); registerKeyword('indian_tribe') }
  if (organizationDetails.is_community_action_agency) { registerKeyword('community_action_agency'); registerKeyword('caa'); registerKeyword('csbg_eligible') }
  if (organizationDetails.is_cdfi) { registerKeyword('cdfi'); registerKeyword('community_development_financial_institution') }
  if (organizationDetails.is_msi_hbcu) { registerKeyword('hbcu'); registerKeyword('msi'); registerKeyword('minority_serving_institution') }
  if (organizationDetails.is_housing_authority) { registerKeyword('housing_authority'); registerKeyword('public_housing'); registerKeyword('hud') }
  if (organizationDetails.is_cooperative) { registerKeyword('cooperative'); registerKeyword('co_op'); registerKeyword('usda_rural') }

  // ============ PROGRAMS & SERVICES (profile's stated needs → match to relatable funding) ============
  // Coerce all three list fields up-front so legacy string/object shapes still feed
  // matching (avoids the silent quality bug where a string value was dropped because
  // Array.isArray(...) was false).
  const programsServicesRaw = sections?.programs_services ?? {}
  const programsServices = {
    ...programsServicesRaw,
    focus_areas: toStringArray(programsServicesRaw.focus_areas),
    interests: toStringArray(programsServicesRaw.interests),
    keywords: toStringArray(programsServicesRaw.keywords),
  }
  if (programsServices.keywords.length > 0) {
    registerKeywords(programsServices.keywords)
    programsServices.keywords.forEach((k) => interestSet.add(normalizeString(k)))
  }
  if (programsServices.focus_areas.length > 0) {
    registerKeywords(programsServices.focus_areas)
    programsServices.focus_areas.forEach((f) => interestSet.add(normalizeString(f)))
  }
  if (programsServices.interests.length > 0) {
    registerKeywords(programsServices.interests)
    programsServices.interests.forEach((i) => interestSet.add(normalizeString(i)))
  }
  if (hasTextValue(programsServices.notes)) {
    collectNarrativeKeywords({ notes: programsServices.notes }, registerKeyword)
  }

      // Extract multi-word focus areas / keywords / interests as intent phrases for matching
          ;[...programsServices.focus_areas, ...programsServices.keywords, ...programsServices.interests]
                .forEach((val) => {
                        const norm = normalizeString(val)
                                if (norm.length >= 6 && norm.includes(' ')) intentPhraseSet.add(norm)
                                      })

  // ============ SMALL BUSINESS DETAILS (real funding for business/startup needs: NAICS, USDA, SBA) ============
  const smallBusiness = sections?.small_business_details ?? {}
  if (hasTextValue(smallBusiness.naics_code)) {
    const naics = String(smallBusiness.naics_code).trim()
    if (naics) {
      registerKeyword(naics)
      applicantTypeSet.add('small business')
      applicantTypeSet.add('small_business')
      // Common NAICS-related phrases for grant matching (e.g. 722330 = limited-service restaurants / food trucks)
      if (/^72/.test(naics)) {
        registerKeyword('food service')
        registerKeyword('restaurant')
        intentPhraseSet.add('food truck business')
      }
      if (/^44|^45/.test(naics)) {
        registerKeyword('retail')
      }
    }
  }
  if (hasTextValue(smallBusiness.notes)) {
    collectNarrativeKeywords({ notes: smallBusiness.notes }, registerKeyword)
    // Explicit program keywords from notes (USDA, SBA microloan, microenterprise, etc.)
    // Affirmed whole words only: "No small business details provided in the
    // profile." was minting a 'small business' intent phrase for a student.
    const programTerms = ['usda', 'sba', 'microloan', 'microenterprise', 'community development', 'small business', 'startup', 'rural business', 'rural development']
    programTerms.forEach((term) => {
      if (containsAffirmedTermWholeWord(smallBusiness.notes, term)) {
        registerKeyword(term)
        if (term.includes(' ')) intentPhraseSet.add(term)
      }
    })
  }
  if (hasTextValue(smallBusiness.business_name)) {
    registerKeyword(smallBusiness.business_name)
  }
  if ((smallBusiness.years_in_business !== null && smallBusiness.years_in_business !== undefined)) {
    const years = parseNumber(smallBusiness.years_in_business)
    if (years !== null && years < 3) registerKeyword('startup')
  }
  if ((smallBusiness.employee_count !== null && smallBusiness.employee_count !== undefined)) {
    const emp = parseNumber(smallBusiness.employee_count)
    if (emp !== null && emp <= 10) registerKeyword('micro-enterprise')
  }
  if ((smallBusiness.annual_revenue !== null && smallBusiness.annual_revenue !== undefined)) {
    const rev = parseNumber(smallBusiness.annual_revenue)
    if (rev !== null && rev < 250000) registerKeyword('low revenue small business')
  }
  if (smallBusiness.certifications && Array.isArray(smallBusiness.certifications)) {
    smallBusiness.certifications.forEach((cert) => {
      if (typeof cert === 'string') registerKeyword(cert)
    })
    const certSet = new Set(smallBusiness.certifications.map(c => typeof c === 'string' ? c.toLowerCase() : ''))
    if (certSet.has('wosb') || certSet.has('women-owned')) { applicantTypeSet.add('women-owned business'); registerKeyword('WOSB') }
    if (certSet.has('hubzone')) { registerKeyword('HUBZone') }
    if (certSet.has('mbe') || certSet.has('minority-owned')) { applicantTypeSet.add('minority-owned business'); registerKeyword('minority owned business') }
    if (certSet.has('8a') || certSet.has('8(a)')) { registerKeyword('8a certification') }
    if (certSet.has('sdvosb') || certSet.has('service-disabled veteran')) { applicantTypeSet.add('veteran-owned business'); registerKeyword('SDVOSB') }
  }
  // Intent category "business startup" from profile_category or organization type
  const profileCategory = basic.profile_category ?? organizationDetails.organization_type ?? profile?.primary_type ?? ''
  if (/small_business|business_startup|startup|entrepreneur/i.test(profileCategory)) {
    applicantTypeSet.add('small business')
    applicantTypeSet.add('small_business')
    registerKeyword('small business')
    registerKeyword('startup')
    registerKeyword('entrepreneur')
    intentPhraseSet.add('business startup')
  }

  // ============ NARRATIVE ============
  const narrative = sections?.narrative ?? {}
  collectNarrativeKeywords(narrative, registerKeyword)
  if (narrative.mission) {
    collectNarrativeKeywords({ mission: narrative.mission }, registerKeyword)
  }
  if (narrative.target_population) registerKeyword(narrative.target_population)
  if (narrative.primary_goal) registerKeyword(narrative.primary_goal)

        // Extract multi-word narrative fields as intent phrases (mirrors goalLikeFields logic)
            ;['primary_goal', 'mission', 'target_population'].forEach((field) => {
                  const val = narrative[field]
                        if (!val || typeof val !== 'string') return
                              val.split(/[,;]+/)
                                      .map((s) => normalizeString(s))
                                              .filter((s) => s.length >= 6 && s.includes(' '))
                                                      .forEach((s) => intentPhraseSet.add(s))
                                                          })
  if (narrative.funding_amount_needed) {
    // Extract dollar amount
    const amountMatch = String(narrative.funding_amount_needed).match(/\$?([\d,]+)/g)
    if (amountMatch) {
      const amount = parseNumber(amountMatch[0].replace(/[$,]/g, ''))
      if (amount !== null) {
        financial.fundingAmountNeeded = amount
      }
    }
    // Also register as keywords for matching
    registerKeyword(narrative.funding_amount_needed)
  }
  if (narrative.use_of_funds) {
    collectNarrativeKeywords({ use_of_funds: narrative.use_of_funds }, registerKeyword)
  }

  // ============ UNIVERSITY APPLICATIONS ============
  const universityApplications = sections?.university_applications?.applications ?? []
  universityApplications.forEach((application) => {
    if (!application) return
    if (Array.isArray(application.interests)) {
      application.interests.forEach((interest) => {
        registerKeyword(interest)
        interestSet.add(normalizeString(interest))
      })
    }
    if (application.name) registerKeyword(application.name)
    if (application.application_type) registerKeyword(application.application_type)
    if (application.institution_type) registerKeyword(application.institution_type)
    if (hasTextValue(application.intended_major)) {
      registerKeyword(application.intended_major)
      interestSet.add(normalizeString(application.intended_major))
    }
    if (application.notes) {
      collectNarrativeKeywords({ notes: application.notes }, registerKeyword)
    }
    const gpaCandidate = parseNumber(application.avg_gpa ?? application.gpa)
    if (Number.isFinite(gpaCandidate) && (!academics.gpa || gpaCandidate > academics.gpa)) {
      academics.gpa = gpaCandidate
    }
    const actCandidate = parseNumber(application.act_score ?? application.act)
    if (Number.isFinite(actCandidate) && (!academics.act || actCandidate > academics.act)) {
      academics.act = actCandidate
    }
    const satCandidate = parseNumber(application.sat_score ?? application.sat)
    const satRangeCandidate = parseSatRange(application.sat_range)
    const satValue = satCandidate ?? satRangeCandidate
    if (Number.isFinite(satValue) && (!academics.sat || satValue > academics.sat)) {
      academics.sat = satValue
    }
  })

  // ============ EDUCATION ============
  const education = sections?.education ?? sections?.education_details ?? {}
  if (education.gpa) {
    const gpaCandidate = parseNumber(education.gpa)
    if (Number.isFinite(gpaCandidate) && (!academics.gpa || gpaCandidate > academics.gpa)) {
      academics.gpa = gpaCandidate
    }
  }
  if (education.act_score) {
    const actCandidate = parseNumber(education.act_score)
    if (Number.isFinite(actCandidate) && (!academics.act || actCandidate > academics.act)) {
      academics.act = actCandidate
    }
  }
  if (education.sat_score || education.sat_range) {
    const satCandidate = parseNumber(education.sat_score)
    const satRangeCandidate = parseSatRange(education.sat_range)
    const satValue = satCandidate ?? satRangeCandidate
    if (Number.isFinite(satValue) && (!academics.sat || satValue > academics.sat)) {
      academics.sat = satValue
    }
  }
  if (education.programs && Array.isArray(education.programs)) {
    education.programs.forEach((program) => registerKeyword(program))
  }
  if (education.degree_type) registerKeyword(education.degree_type)
  if (hasTextValue(education.field_of_study)) {
    registerKeyword(education.field_of_study)
    interestSet.add(normalizeString(education.field_of_study))
  }
  if (education.school_name) registerKeyword(education.school_name)
  if (education.graduation_year) {
    const gradYear = parseNumber(education.graduation_year)
    const currentYear = nowYear
    if (gradYear !== null) {
      if (gradYear === currentYear || gradYear === currentYear + 1) {
        registerKeyword('graduating senior')
      }
      if (gradYear > currentYear) {
        registerKeyword('current student')
      }
    }
  }
  if (education.first_generation) {
    demographicSet.add('first_generation')
    registerKeyword('first generation college student')
  }
  if (education.current_institution) registerKeyword(education.current_institution)
  if (hasTextValue(education.highest_level)) {
    registerKeyword(education.highest_level)
    const lvl = normalizeString(education.highest_level)
    if (lvl && /high\s*school|ged/i.test(lvl)) demographicSet.add('high_school')
    if (lvl && /associate/i.test(lvl)) demographicSet.add('associate_degree')
    if (lvl && /bachelor/i.test(lvl)) demographicSet.add('bachelors_degree')
    if (lvl && /master/i.test(lvl)) demographicSet.add('masters_degree')
    if (lvl && /doctor|phd/i.test(lvl)) demographicSet.add('doctorate')
  }
  if (education.community_service_hours) {
    const hours = parseNumber(education.community_service_hours)
    if (hours !== null && hours >= 100) registerKeyword('community service')
  }
  if (education.leadership_roles && Array.isArray(education.leadership_roles)) {
    education.leadership_roles.forEach((r) => registerKeyword(r))
    registerKeyword('leadership')
  }
  if (education.valedictorian) registerKeyword('valedictorian')
  if (education.target_colleges && Array.isArray(education.target_colleges)) {
    education.target_colleges.forEach((c) => registerKeyword(c))
  }
  if (education.pell_grant_eligible) { registerKeyword('pell_grant'); registerKeyword('need_based_aid'); registerKeyword('low_income_student') }
  if (education.fafsa_completed) { registerKeyword('fafsa'); registerKeyword('federal_financial_aid') }
  if (hasTextValue(education.cte_pathway)) {
    registerKeyword('cte'); registerKeyword('career_technical')
    registerKeyword(education.cte_pathway.toLowerCase().replace(/\s+/g, '_'))
  }
  if (education.rotc_jrotc) { registerKeyword('rotc'); registerKeyword('military_scholarship') }
  if (education.honor_societies) { registerKeyword('honor_society'); registerKeyword('academic_achievement') }
  if (education.first_generation_college_student) { registerKeyword('first_generation'); registerKeyword('first_gen_college') }
  if (education.dual_enrollment) { registerKeyword('dual_enrollment'); registerKeyword('early_college') }
  // EFC/SAI band — Expected Family Contribution for financial aid matching
  if (hasTextValue(education.efc_sai_band)) {
    const efc = normalizeString(education.efc_sai_band)
    if (efc) {
      registerKeyword('efc ' + efc)
      registerKeyword('student aid index')
      // Low EFC = high financial need
      if (/zero|0|low|very.?low/i.test(efc)) {
        registerKeyword('high_financial_need')
        registerKeyword('need_based_aid')
        assistanceSet.add('low_efc')
      }
    }
  }
  // Intended major — scholarship targeting by field
  if (hasTextValue(education.intended_major)) {
    registerKeyword(education.intended_major)
    interestSet.add(normalizeString(education.intended_major))
  }
  // Education-section interests array — preserve every interest as a keyword and
  // an interestSet entry so STEM/forensic/criminal-justice/etc. signals reach the
  // matcher's keyword overlap and category scoring.
  if (Array.isArray(education.interests)) {
    education.interests.forEach((interest) => {
      if (hasTextValue(interest)) {
        registerKeyword(interest)
        interestSet.add(normalizeString(interest))
      }
    })
  }
  // STEM detection — if the student's major OR any interest is STEM-related,
  // emit explicit `stem` / `stem_student` keywords so STEM-targeted scholarships
  // (Society of Women Engineers, AAFS, etc.) and broad scholarship platforms
  // (Bold.org, Scholarships.com) align with the profile.
  const _stemHaystack = [
    String(education.field_of_study || ''),
    String(education.intended_major || ''),
    String(education.major || ''),
    ...(Array.isArray(education.interests) ? education.interests.map((i) => String(i || '')) : []),
  ].join(' ').toLowerCase()
  const _STEM_TERMS = [
    'stem', 'science', 'technology', 'engineering', 'mathematics', 'forensic',
    'forensics', 'biology', 'chemistry', 'physics', 'computer', 'data science',
    'cybersecurity', 'biomedical', 'biotechnology', 'pre-med', 'pre med',
    'health science', 'nursing', 'paramedic', 'pharmacy', 'environmental science',
    'criminal justice',
  ]
  if (_STEM_TERMS.some((t) => _stemHaystack.includes(t))) {
    registerKeyword('stem')
    registerKeyword('stem student')
    interestSet.add('stem')
    if (_stemHaystack.includes('forensic')) {
      registerKeyword('forensic science')
      interestSet.add('forensic science')
    }
    if (_stemHaystack.includes('criminal justice')) {
      registerKeyword('criminal justice')
      interestSet.add('criminal justice')
    }
  }
  // Education notes — additional context keywords
  if (hasTextValue(education.notes)) {
    collectNarrativeKeywords({ notes: education.notes }, registerKeyword)
  }

  // ============ MEDICAL INSURANCE ============
  // Insurance plan type unlocks assistance program matching (Medicaid/Medicare → benefits crawlers)
  const medicalInsurance = sections?.medical_insurance ?? {}
  if (medicalInsurance.plan_type) {
    const planType = normalizeString(medicalInsurance.plan_type)
    if (planType) {
      registerKeyword(planType)
      if (/medicaid/i.test(planType)) {
        assistanceSet.add('medicaid')
        registerKeyword('medicaid')
      }
      if (/medicare/i.test(planType)) {
        assistanceSet.add('medicare')
        registerKeyword('medicare')
      }
      if (/marketplace|aca/i.test(planType)) {
        registerKeyword('marketplace insurance')
      }
    }
  }
  if (hasTextValue(medicalInsurance.insurance_provider)) {
    registerKeyword(medicalInsurance.insurance_provider)
  }
  if (medicalInsurance.notes) {
    collectNarrativeKeywords({ notes: medicalInsurance.notes }, registerKeyword)
    // Waiver membership stated in insurance notes (e.g. "HCBS waiver through
    // TennCare") — same free-text scan as government_assistance.other_programs.
    deriveWaiverSignalsFromText(medicalInsurance.notes)
  }

  // ============ MEDICAL HISTORY ============
  // Primary/secondary conditions feed health signals and condition-specific grant matching
  const medicalHistory = sections?.medical_history ?? {}
  if (medicalHistory.primary_condition) {
    const condition = normalizeString(medicalHistory.primary_condition)
    if (condition) {
      healthSet.add(condition)
      healthConditionSet.add(condition) // a diagnosis field — see the provenance note
      registerKeyword(condition)
    }
  }
  if (Array.isArray(medicalHistory.secondary_conditions)) {
    for (const cond of medicalHistory.secondary_conditions) {
      const normalized = normalizeString(cond)
      if (normalized) {
        healthSet.add(normalized)
        healthConditionSet.add(normalized) // a diagnosis field
        registerKeyword(normalized)
      }
    }
  }
  if (hasTextValue(medicalHistory.mobility_needs)) {
    registerKeyword(medicalHistory.mobility_needs)
    healthSet.add('mobility_needs')
    registerKeyword('mobility assistance')
  }
  if (Array.isArray(medicalHistory.dme_needed) && medicalHistory.dme_needed.length > 0) {
    medicalHistory.dme_needed.forEach((item) => registerKeyword(item))
    registerKeyword('durable medical equipment')
    healthSet.add('dme')
  }
  if (medicalHistory.letter_support_needed) {
    registerKeyword('letter of medical necessity')
  }
  if (medicalHistory.notes) {
    collectNarrativeKeywords({ notes: medicalHistory.notes }, registerKeyword)
  }

  // ============ NONPROFIT COMPLIANCE ============
  // 501c3/SAM status is critical for federal grant eligibility
  const nonprofitCompliance = sections?.nonprofit_compliance ?? {}
  if (nonprofitCompliance.is_501c3) {
    registerKeyword('501c3')
    registerKeyword('tax exempt')
    applicantTypeSet.add('nonprofit')
    applicantTypeSet.add('501c3')
  }
  if (nonprofitCompliance.fiscal_sponsor) {
    registerKeyword('fiscal sponsor')
    registerKeyword('fiscal sponsorship')
    if (hasTextValue(nonprofitCompliance.fiscal_sponsor_name)) {
      registerKeyword(nonprofitCompliance.fiscal_sponsor_name)
    }
  }
  if (nonprofitCompliance.sam_registered) {
    registerKeyword('sam registered')
    registerKeyword('sam.gov')
    applicantTypeSet.add('sam_registered')
  }
  if (nonprofitCompliance.compliance_notes) {
    collectNarrativeKeywords({ notes: nonprofitCompliance.compliance_notes }, registerKeyword)
  }

  // ============ EMPLOYMENT ============
  // Employment status and career goals feed workforce/training program matching
  const employment = sections?.employment ?? {}
  if (employment.current_status) {
    const status = normalizeString(employment.current_status)
    if (status) {
      registerKeyword(status)
      occupationSet.add(status)
      // A full-time STUDENT whose status reads "Unemployed" has not lost a
      // job: a live high-school senior ("High school student focused on
      // academics") was minted an unemployed flag, an employment need and
      // the DOL workforce vocabulary from that one word (2026-09-05).
      const studentProfile = applicantTypeSet.has('student')
        || /\bstudent\b/i.test(String(employment.notes ?? ''))
        || /student/i.test(String(profile?.primary_type ?? ''))
      if (!studentProfile && /unemploy|job.?seek|between.?jobs|laid.?off/i.test(employment.current_status)) {
        assistanceSet.add('unemployed')
        registerKeyword('job seeker')
        registerKeyword('workforce development')
      }
      if (/self.?employ|freelance|independent/i.test(employment.current_status)) {
        applicantTypeSet.add('self_employed')
        registerKeyword('self employed')
      }
      if (/part.?time|underemploy/i.test(employment.current_status)) {
        assistanceSet.add('underemployed')
        registerKeyword('underemployed')
      }
    }
  }
  if (hasTextValue(employment.career_goal)) {
    registerKeyword(employment.career_goal)
    // Career goals are strong intent signals for matching
    const goalNorm = normalizeString(employment.career_goal)
    if (goalNorm && goalNorm.length >= 6 && goalNorm.includes(' ')) {
      intentPhraseSet.add(goalNorm)
    }
  }
  if (employment.experience) {
    collectNarrativeKeywords({ experience: employment.experience }, registerKeyword)
  }
  if (employment.notes) {
    collectNarrativeKeywords({ notes: employment.notes }, registerKeyword)
  }

  // ============ HOUSING ============
  // Housing status drives assistance program eligibility; broadband drives digital divide programs
  const housing = sections?.housing ?? {}
  if (housing.status) {
    const status = normalizeString(housing.status)
    if (status) {
      registerKeyword(status)
      if (/homeless|unhoused|shelter/i.test(housing.status)) {
        assistanceSet.add('homeless')
        familySet.add('homeless')
        registerKeyword('housing insecure')
        registerKeyword('unhoused')
      }
      if (/at.?risk|unstable|transitional/i.test(housing.status)) {
        assistanceSet.add('housing_at_risk')
        registerKeyword('housing instability')
        registerKeyword('at-risk housing')
      }
    }
  }
  if (hasTextValue(housing.type)) {
    registerKeyword(housing.type)
    if (/rent/i.test(housing.type)) registerKeyword('renter')
    if (/section.?8|voucher/i.test(housing.type)) {
      assistanceSet.add('section8_housing')
      registerKeyword('section 8')
    }
  }
  if (housing.broadband_speed) {
    registerKeyword('broadband')
    registerKeyword('internet access')
    // Low/no broadband signals digital divide programs (ACP, FCC, etc.)
    if (/none|no.?service|slow|dial.?up|satellite|under.?25/i.test(housing.broadband_speed)) {
      assistanceSet.add('digital_divide')
      registerKeyword('digital divide')
      registerKeyword('broadband access')
    }
  }
  // Housing geographic designations may legacy-arrive as a string ("rural, frontier"),
  // an object, or an array; toStringArray normalises every shape so rural/urban/frontier
  // signals are never silently dropped from matching.
  const geographicDesignations = toStringArray(housing.geographic_designation)
  if (geographicDesignations.length > 0) {
    geographicDesignations.forEach((desig) => {
      const norm = normalizeString(desig)
      if (norm) {
        registerKeyword(norm)
        demographicSet.add(norm)
      }
    })
  }
  if (housing.notes) {
    collectNarrativeKeywords({ notes: housing.notes }, registerKeyword)
  }
  // Housing address — backup location data when primary location is missing
  if (housing.address && typeof housing.address === 'string' && !location.state) {
    const housingState = extractStateFromAddress(housing.address)
    if (housingState) location.state = housingState
    if (!location.zip) {
      const housingZip = extractZipFromAddress(housing.address)
      if (housingZip) location.zip = housingZip
    }
    if (!location.city) {
      const housingCity = extractCityFromAddress(housing.address)
      if (housingCity) location.city = housingCity
    }
  }

  // ============ FAMILY (HOUSEHOLD DETAILS) ============
  // Distinct from family_life: structured household info (size, responsibilities, support)
  const familyHousehold = sections?.family ?? {}
  if (familyHousehold.household_size) {
    const size = parseNumber(familyHousehold.household_size)
    if (size !== null) {
      // Merge with financial.householdSize if not already set
      if (!financial.householdSize) financial.householdSize = size
      if (size >= 5) registerKeyword('large household')
      if (size === 1) registerKeyword('single person household')
    }
  }
  if (familyHousehold.responsibilities) {
    collectNarrativeKeywords({ responsibilities: familyHousehold.responsibilities }, registerKeyword)
    if (/caregiv|eldercare|childcare|dependent/i.test(familyHousehold.responsibilities)) {
      familySet.add('caregiver')
      registerKeyword('caregiver')
    }
  }
  if (familyHousehold.support_system) {
    collectNarrativeKeywords({ support_system: familyHousehold.support_system }, registerKeyword)
  }
  if (familyHousehold.notes) {
    collectNarrativeKeywords({ notes: familyHousehold.notes }, registerKeyword)
  }

  // ============ PRO BONO / IN-KIND SIGNAL INJECTION ============
  // When profile signals indicate needs that can be met by non-cash services,
  // automatically inject search terms so crawlers surface pro bono / in-kind resources.
  const proBonoTerms = new Set()

  if (familySet.has('homeless') || familySet.has('domestic_violence_survivor') ||
      assistanceSet.has('housing_at_risk') || assistanceSet.has('homeless')) {
    ;['legal aid', 'eviction prevention', 'pro bono legal', 'tenant rights', 'housing intake'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }
  if (familySet.has('domestic_violence_survivor') || familySet.has('trafficking_survivor')) {
    ;['domestic violence hotline', 'protective order', 'victim services', 'crisis intervention'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }
  if (healthSet.has('chronic_illness') || healthSet.has('terminal') || healthSet.has('cancer') ||
      healthSet.has('dialysis') || healthSet.has('hiv')) {
    ;['charity care', 'patient assistance program', 'free clinic', 'sliding scale', 'copay assistance',
      'financial assistance policy'].forEach(t => { proBonoTerms.add(t); registerKeyword(t) })
  }
  if (healthSet.has('mental_health') || healthSet.has('recovery')) {
    ;['free counseling', 'community mental health', 'behavioral health clinic', 'crisis hotline'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }
  if (healthSet.has('dme') || healthSet.has('wheelchair') || healthSet.has('amputee')) {
    ;['donated equipment', 'dme loaner', 'assistive technology', 'equipment donation program'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }
  if (occupationSet.has('healthcare_worker') || occupationSet.has('nurse') ||
      keywordSet.has('licensure') || keywordSet.has('nclex') || keywordSet.has('certification')) {
    ;['wioa training', 'etpl provider', 'no cost training', 'tuition waiver', 'workforce training board',
      'vocational rehabilitation'].forEach(t => { proBonoTerms.add(t); registerKeyword(t) })
  }
  if (assistanceSet.has('unemployed') || assistanceSet.has('displaced_worker') || assistanceSet.has('underemployed')) {
    ;['workforce development', 'job training program', 'career center', 'wioa', 'one-stop center'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }
  if (demographicSet.has('immigrant') || keywordSet.has('immigration') || keywordSet.has('refugee') || keywordSet.has('daca')) {
    ;['immigration legal aid', 'free immigration clinic', 'refugee resettlement', 'pro bono immigration'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }
  if (familySet.has('formerly_incarcerated') || familySet.has('former_incarcerated')) {
    ;['reentry services', 'expungement clinic', 'pro bono reentry', 'second chance program'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }

  // ============ NEEDS DETECTION ============
  const NEED_MAP = {
    utilities: ['utilities','utility','electric','gas','water','energy','heating','cooling','lieap','liheap','power bill'],
    housing: ['housing','rent','mortgage','shelter','homeless','section 8','home repair','eviction'],
    food: ['food','snap','groceries','hunger','nutrition','wic','food bank','food pantry'],
    healthcare: ['healthcare','medical','hospital','treatment','copay','prescription','therapy','nursing'],
    disability: ['disability','disabled','special needs','assistive','wheelchair','blind','deaf'],
    mental_health: ['mental health','behavioral health','counseling','psychiatric','ptsd'],
    substance_recovery: ['substance','recovery','sober','addiction','detox','rehab'],
    education: ['education','scholarship','tuition','college','university','school'],
    employment: ['employment','job','workforce','career','vocational','job training'],
    cash_assistance: ['cash assistance','emergency fund','financial aid','poverty'],
    childcare: ['childcare','daycare','child care','after school','head start'],
    transportation: ['transportation','vehicle','transit','bus','ride'],
    internet: ['internet','broadband','connectivity','digital'],
    legal: ['legal','attorney','court','eviction defense','immigration'],
    business: ['business','entrepreneur','startup','self-employ','microenterprise'],
    certification_assistance: ['cpr','first aid','aed','bls','heartsaver','acls','instructor certification','safety training','safety certification','cpr class','first aid class','cpr instructor','first aid instructor','instructor course','cpr/first aid','cpr/aed','teach cpr','community cpr','medical certification'],
    cpr_first_aid_training: ['cpr','first aid','aed','bls','heartsaver','cpr certification','first aid certification','safety trainer'],
    license_reinstatement_support: ['probe','probe class','probe course','probe ethics','license reinstatement','nursing reinstatement','reinstatement course','ethics course','ethics class','remediation','remediation course','remediation program','board required','board-required','professional boundaries','return to practice','return to nursing','relicensing','recertification','nurse reentry','nurse re-entry','credential restoration','license back','nursing license back','disciplinary education','board-ordered education','mandatory professional education','professional compliance'],
    nursing_reentry_support: ['nurse reentry','nurse re-entry','return to nursing','return to practice','nursing refresher','nursing re-entry','healthcare return to work','nursing workforce'],
    professional_remediation_funding: ['probe','remediation','ethics course','professional boundaries','disciplinary remediation','board required education','mandated continuing education','professional compliance training'],
    professional_development_continuing_education: ['continuing education','professional development','cme','ce credits','licensure exam','certification exam','workforce training','wioa','vocational rehabilitation','tuition reimbursement','training scholarship','conference travel','professional association dues','refresher program','re-entry program'],
  }
  // Check both individual tokens (keywordSet) AND full phrases (phraseSet) so multi-word
  // triggers like 'food bank', 'mental health', 'probe ethics' are correctly matched.
  const allKws = Array.from(keywordSet)
  const allPhrases = Array.from(phraseSet)
  const allSignals = [...allKws, ...allPhrases]
  // Whole-word only (suffix-tolerant): substring includes() fabricated needs
  // from fragments — 'bus' ⊂ "business" gave every business profile a
  // transportation need; 'rent' ⊂ "current"/"parent" gave nearly everyone a
  // housing need. Phantom needs dilute the need-anchored coverage denominator
  // AND mis-steer discovery queries, so precision here is scoring-critical.
  // This loop is the ONE whole-profile FREE-TEXT need channel: the keyword bag
  // is mined from every narrative/notes field, including the denials ("no
  // medical equipment required", "No military affiliation ... veteran
  // status"). Its output is kept apart as `textInferredNeeds` so consumers
  // that must treat needs as DECLARATIONS (the crawl thesis) can read the
  // flag/field-derived set alone; `needs` stays the union for everyone else.
  const textInferredNeeds = new Set()
  for (const signal of allSignals) {
    for (const [need, triggers] of Object.entries(NEED_MAP)) {
      if (triggers.some(t => containsTermWholeWord(signal, t))) textInferredNeeds.add(need)
    }
  }
  if (assistanceSet.has('medicaid') || assistanceSet.has('medicare')) needs.add('healthcare')
  if (assistanceSet.has('ssi') || assistanceSet.has('ssdi')) { needs.add('disability'); needs.add('cash_assistance') }
  if (assistanceSet.has('snap')) needs.add('food')
  if (assistanceSet.has('tanf')) needs.add('cash_assistance')
  if (assistanceSet.has('section_8') || assistanceSet.has('section8')) needs.add('housing')
  if (assistanceSet.has('liheap')) needs.add('utilities')
  if (assistanceSet.has('wic')) needs.add('food')
  if (assistanceSet.has('medical_debt')) needs.add('healthcare')
  if (assistanceSet.has('student_loan')) needs.add('education')
  if (assistanceSet.has('financial_recovery')) needs.add('cash_assistance')
  if (assistanceSet.has('first_time_homebuyer')) needs.add('housing')
  if (assistanceSet.has('underemployed')) needs.add('employment')
  if (healthSet.size > 0) needs.add('healthcare')
  if (healthSet.has('disability') || healthSet.has('physical_disability') || healthSet.has('visual_impairment') || healthSet.has('hearing_impairment')) needs.add('disability')
  if (healthSet.has('mental_health')) needs.add('mental_health')
  if (healthSet.has('recovery')) needs.add('substance_recovery')
  if (familySet.has('homeless')) needs.add('housing')
  if (familySet.has('domestic_violence') || familySet.has('trafficking_survivor')) { needs.add('housing'); needs.add('legal') }

  // Credentials → professional development pool (per spec section 5).
  // These needs unlock the professional_development funder taxonomy in
  // matching (workforce boards, nursing foundations, professional-association
  // scholarships, HRSA Nurse Corps, etc.) without requiring the user to type
  // the right keywords.
  if (credentialsSet.size > 0) {
    needs.add('professional_development')
    needs.add('continuing_education')
    needs.add('license_reinstatement_support')
    needs.add('professional_remediation_funding')
    needs.add('workforce_reentry_training')
    if (
      credentialsSet.has('RN') || credentialsSet.has('LPN') ||
      credentialsSet.has('APRN') || credentialsSet.has('NP') ||
      credentialsSet.has('FNP') || credentialsSet.has('DNP') ||
      credentialsSet.has('CRNA') || credentialsSet.has('CNA')
    ) {
      needs.add('nursing_reentry_support')
    }
  }

  // ============ APPLICANT TYPE (single string) ============
  let applicantType = 'individual'
  if (applicantTypeSet.has('organization') || applicantTypeSet.has('nonprofit') || applicantTypeSet.has('501c3')) {
    applicantType = 'organization'
  } else if (applicantTypeSet.has('small business') || applicantTypeSet.has('small_business') ||
             applicantTypeSet.has('women-owned business') || applicantTypeSet.has('minority-owned business') ||
             applicantTypeSet.has('veteran-owned business') || applicantTypeSet.has('self_employed')) {
    applicantType = 'business'
    needs.add('business')
  } else if (applicantTypeSet.has('student') || applicantTypeSet.has('college student') ||
             applicantTypeSet.has('college_student') ||
             applicantTypeSet.has('high school student') || applicantTypeSet.has('high_school_student') ||
             applicantTypeSet.has('graduate_student') || applicantTypeSet.has('graduate student') ||
             applicantTypeSet.has('returning_student') || applicantTypeSet.has('returning student') ||
             demographicSet.has('current_student') ||
             // Tags or primary_type may use any of these synonyms; match liberally so
             // sparse profiles get classified as student before the generic fallback fires.
             [...applicantTypeSet].some((t) => /\b(?:high.?school.?student|college.?student|graduate.?student|undergraduate|hs.?student|hs.?senior|hs.?junior|hs.?sophomore|hs.?freshman|student)\b/i.test(t))) {
    applicantType = 'student'
    needs.add('education'); needs.add('scholarship')

    // STUDENT AID AUTO-TAGGING (global, profile-aware default per spec).
    // Every student profile gets a baseline pool of student-aid signals so
    // the matching SQL filter (LOWER(keywords) LIKE ...) hits the right
    // rows even when the user's free-text query is "off-campus living
    // expenses at MTSU" (which only tokenizes to "campus", "living",
    // "expenses", "mtsu"). These keywords surface FAFSA / Pell / FSEOG /
    // state student aid / room-and-board scholarships / school emergency
    // aid / school cards. Per the user rule "Profile attributes should
    // increase score, not eliminate results", these are additive — they
    // never block other matches.
    ;[
      'student aid',
      'student housing',
      'off-campus housing',
      'on-campus housing',
      'student living',
      'cost of attendance',
      'room and board',
      'tuition assistance',
      'scholarship',
      'fafsa',
      'pell grant',
      'fseog',
      'federal work-study',
      'student emergency aid',
      'completion grant',
      'institutional aid',
      'financial aid office',
    ].forEach((kw) => registerKeyword(kw))

    // Add student_living and student_aid as needs so the need-based scoring
    // in matchEngine bucket-aligns with student-aid opportunities and the
    // route can detect student_aid as the primary intent server-side.
    needs.add('student_aid')
    needs.add('student_living')
    needs.add('cost_of_attendance')

    // Tennessee residents get the state student-aid program names so HOPE
    // / TSAA / STEP UP / Aspire / Promise rows appear in candidates even
    // before the user types those acronyms. Same pattern is used for
    // any state in profile.location.state via STATE_STUDENT_AID below.
    const STATE_STUDENT_AID = {
      TN: ['tennessee hope', 'tn promise', 'tennessee promise', 'tennessee student assistance award', 'tsaa', 'step up scholarship', 'aspire award', 'tennessee reconnect'],
      WV: ['promise scholarship', 'wv invests', 'higher education grant', 'cfwv'],
      CA: ['cal grant', 'middle class scholarship', 'chafee grant'],
      NY: ['tap grant', 'tuition assistance program', 'excelsior scholarship'],
      IL: ['map grant', 'monetary award program'],
      TX: ['toward excellence access success', 'teach grant'],
      GA: ['hope scholarship georgia', 'zell miller', 'hope grant'],
      FL: ['bright futures', 'florida student assistance grant'],
      OH: ['ohio college opportunity grant', 'choose ohio first'],
      PA: ['pheaa state grant', 'ready to succeed'],
      NC: ['nc need based', 'nc community college grant'],
      MI: ['michigan competitive scholarship', 'tuition incentive program'],
      KY: ['kentucky educational excellence scholarship', 'kees', 'cap grant', 'go higher'],
      AL: ['alabama student assistance program', 'asap grant'],
      VA: ['virginia tuition assistance grant', 'vtag'],
      SC: ['palmetto fellows', 'life scholarship', 'south carolina need based grant'],
    }
    const stateAidKey = String(location?.state || '').toUpperCase()
    if (stateAidKey && STATE_STUDENT_AID[stateAidKey]) {
      STATE_STUDENT_AID[stateAidKey].forEach((kw) => registerKeyword(kw))
    }

    // Target colleges → emit the college name as a keyword AND add a
    // generic "<college name> financial aid" / "<college name> housing"
    // pair so the candidate set includes school-specific cards.
    // `education` (singular) is declared earlier in this function as the
    // alias for sections.education ?? sections.education_details.
    const targetCollegesArr = Array.isArray(education?.target_colleges)
      ? education.target_colleges
      : []
    targetCollegesArr.forEach((college) => {
      if (!college || typeof college !== 'string') return
      registerKeyword(college)
      const lc = college.toLowerCase()
      registerKeyword(`${lc} financial aid`)
      registerKeyword(`${lc} housing`)
      registerKeyword(`${lc} scholarship`)
    })
    if (education?.current_institution) {
      const lc = String(education.current_institution).toLowerCase()
      registerKeyword(`${lc} financial aid`)
      registerKeyword(`${lc} scholarship`)
    }

    // Auto-eligibility hints for HOPE-style merit aid based on GPA / ACT /
    // SAT thresholds. These DO NOT discard anything — they only register
    // additional keywords so the right candidate rows surface. Match-score
    // weighting is still done by matchEngine.
    if (Number.isFinite(academics.gpa) && academics.gpa >= 3.0) registerKeyword('merit scholarship')
    if (Number.isFinite(academics.gpa) && academics.gpa >= 3.5) registerKeyword('high merit scholarship')
    if (Number.isFinite(academics.act) && academics.act >= 21) registerKeyword('hope eligible')
    if (Number.isFinite(academics.act) && academics.act >= 27) registerKeyword('aspire eligible')
    if (Number.isFinite(academics.gpa) && academics.gpa >= 3.75 &&
        Number.isFinite(academics.act) && academics.act >= 27) {
      registerKeyword('aspire scholarship eligible')
    }

    // Low-income student signals → Pell / FSEOG / state need-based aid.
    // These are additive scoring boosts, never filters.
    const householdIncomeNum = parseNumber(financialSection?.household_income)
    const householdSizeNum = parseNumber(financialSection?.household_size)
    if (Number.isFinite(householdIncomeNum) && Number.isFinite(householdSizeNum) && householdSizeNum > 0) {
      const perCapita = householdIncomeNum / householdSizeNum
      if (perCapita < 15000) {
        registerKeyword('low_income_student')
        registerKeyword('high_financial_need')
        registerKeyword('pell eligible')
        registerKeyword('need based aid')
      }
    }
    if (financialSection?.financial_need_level) {
      const lvl = String(financialSection.financial_need_level).toLowerCase()
      if (/(high|moderate|severe|extreme)/.test(lvl)) {
        registerKeyword('need based aid')
        registerKeyword('pell eligible')
      }
    }

    // Children of disabled / SSDI parents qualify for Social Security
    // dependent benefits while in school in some states + may qualify for
    // additional Pell / FSEOG. Emit the relevant scholarship keywords.
    // `government` (singular) is the alias declared earlier in this function.
    if (assistanceSet.has('ssdi') || government?.ssdi_recipient) {
      registerKeyword('social security dependent')
      registerKeyword('children of ssdi recipients')
      registerKeyword('disability dependent scholarship')
    }
    if (familySet.has('caregiver') || familySet.has('family_caregiver')) {
      registerKeyword('caregiver scholarship')
      registerKeyword('student caregiver')
    }
    if (/immigrant|second.generation|first.generation/i.test(String(demographicsSection?.immigrant_status || '')) ||
        /immigrant|second.generation|first.generation/i.test(String(demographicsSection?.notes || ''))) {
      registerKeyword('immigrant scholarship')
      registerKeyword('first generation scholarship')
      registerKeyword('multilingual student')
    }
    // Heritage / language scholarships — Polish / Russian / Slavic / etc.
    // `basic` (singular) is the alias for sections.basic_information.
    const heritageHaystack = [
      String(demographicsSection?.notes || ''),
      String(demographicsSection?.ethnicity || ''),
      String(basic?.notes || ''),
    ].join(' ').toLowerCase()
    const HERITAGE_KEYWORDS = {
      polish: ['polish american scholarship', 'kosciuszko foundation', 'polish heritage'],
      russian: ['russian heritage scholarship', 'slavic scholarship'],
      ukrainian: ['ukrainian heritage scholarship'],
      irish: ['irish heritage scholarship', 'ancient order of hibernians'],
      italian: ['italian american scholarship', 'order sons italy'],
      german: ['german american scholarship'],
      hispanic: ['hispanic scholarship fund', 'hsf'],
      latino: ['hispanic scholarship fund', 'hsf'],
      asian: ['asian pacific fund', 'apia scholars'],
      'african american': ['uncf', 'thurgood marshall college fund', 'tmcf'],
      black: ['uncf', 'thurgood marshall college fund', 'tmcf'],
      jewish: ['jewish federation scholarship'],
      armenian: ['armenian general benevolent union', 'agbu'],
      greek: ['ahepa scholarship'],
    }
    for (const [tag, kws] of Object.entries(HERITAGE_KEYWORDS)) {
      if (heritageHaystack.includes(tag)) {
        kws.forEach((kw) => registerKeyword(kw))
      }
    }
    // Female STEM students → Society of Women Engineers / NCWIT / etc.
    // Look at every place gender can be expressed: basic.gender (already
    // captured in genderSet), demographics.gender, demographics.notes, and
    // basic.notes. Many real profiles list gender in a free-text notes
    // field rather than the dedicated gender field.
    const genderHaystack = [
      ...Array.from(genderSet),
      String(basic?.gender || ''),
      String(demographicsSection?.gender || ''),
      String(demographicsSection?.notes || ''),
      String(basic?.notes || ''),
    ].join(' ').toLowerCase()
    const isFemale =
      genderSet.has('female') || genderSet.has('woman') || genderSet.has('women') ||
      /\b(female|woman|women|she\/her|girl|she\/they)\b/i.test(genderHaystack)
    if (isFemale) {
      registerKeyword('female')
      if (interestSet.has('stem') || keywordSet.has('stem') || keywordSet.has('forensic science') ||
          interestSet.has('forensic science')) {
        registerKeyword('women in stem')
        registerKeyword('society of women engineers')
        registerKeyword('ncwit')
        registerKeyword('aauw')
      }
    }
    // Rural / Appalachian student → Appalachian Regional Commission scholars,
    // rural-student scholarships.
    if (demographicSet.has('rural') || demographicSet.has('appalachian')) {
      registerKeyword('rural student scholarship')
      registerKeyword('appalachian scholar')
      registerKeyword('appalachian regional commission')
    }
  } else if (militarySet.has('veteran') || militarySet.has('disabled_veteran')) {
    applicantType = 'veteran'
  } else if (familySet.has('caregiver')) {
    applicantType = 'caregiver'
  }
  // Map education/business/employment section signals to needs before fallback
  if (applicantTypeSet.has('student') || education.level || education.current_institution || education.school_name) {
    needs.add('education')
  }
  if (applicantTypeSet.has('small business') || applicantTypeSet.has('small_business') ||
      sections?.small_business_details?.naics_code) {
    needs.add('business')
  }
  if (assistanceSet.has('unemployed') || assistanceSet.has('displaced_worker') ||
      assistanceSet.has('underemployed')) {
    needs.add('employment')
  }
  // Preserve the profile's existing needs so they survive the signal layer.
  // Without this, a profile with needs: ['disability'] would lose that signal when
  // sections don't produce keyword triggers for 'disability'.
  const existingNeeds = safeParseArrayField(profile?.needs, [])
  for (const n of existingNeeds) {
    const key = typeof n === 'string' ? n.trim().toLowerCase().replace(/\s+/g, '_') : null
    if (key) needs.add(key)
  }
  // Inject generic needs when no needs could be derived from profile sections,
  // assistance programs, health signals, or existing profile.needs.
  // Previously this also required keywordSet.size === 0, but display-name-derived
  // display-name keywords are not meaningful needs signals and were
  // preventing the fallback from firing for sparse individual profiles.
  //
  // The fallback is TYPE-SHAPED (2026-07-06): the person-benefit set
  // (utilities/housing/food/healthcare/cash_assistance) was injected for EVERY
  // needs-silent profile, so a church/VFD/biotech "needed" rent and food help.
  // On the need-anchored scale those phantom needs became the org's whole
  // coverage denominator — person-benefit programs scored as strong fits while
  // the org's real mission funding looked like a partial match (the Focus
  // Forward disability-skew class). Orgs now fall back to org-generic fundable
  // needs; person/household (and untyped, per the safe default) profiles keep
  // the benefit set.
  //
  // PROVENANCE (2026-08-02): the fallback makes `needs` NEVER EMPTY, so
  // "the profile has needs" is not evidence the profile SAID anything. A
  // consumer asking "did this person declare anything at all?" (the
  // unconfigured-profile detector) read a defaulted set as a declaration and
  // concluded a wholly-blank placeholder was servable. `needsDefaulted` records
  // that the set was INFERRED FROM TYPE, never read — "we could not read it" ≠
  // "there is nothing". Nothing about the fallback's behaviour changes.
  // Structured (flag/field/status-derived) needs, captured BEFORE the free-text
  // inference is folded in. Exposed as `needs_structured`.
  const structuredNeeds = new Set(needs)
  for (const need of textInferredNeeds) needs.add(need)
  let needsDefaulted = false
  if (needs.size === 0) {
    needsDefaulted = true
    const RE_ORG_SHAPED = /(non.?profit|501c3|501\(c\)|church|ministry|congregation|organi[sz]ation|coalition|consortium|foundation|charity|ngo|business|company|llc|corp|cooperative|school|district|universit|college|government|municipal|county|tribal|fire|ems|first responder|law enforcement|hospital|clinic|laborator|institute|research|biotech|agency|shelter|food bank|food pantry|library|museum|workforce board|chamber)/i
    const declaredTypeText = [profile?.primary_type, profile?.profile_type, profile?.type, ...applicantTypeSet]
      .filter((v) => typeof v === 'string')
      .join(' ')
    if (RE_ORG_SHAPED.test(declaredTypeText)) {
      ;['operations','programs','capacity_building'].forEach(n => needs.add(n))
    } else {
      ;['utilities','housing','food','healthcare','cash_assistance'].forEach(n => needs.add(n))
    }
  }

  // ============ IMMIGRATION SIGNALS ============
  const immigrationSet = new Set()
  const immigrantStatus = demographicsSection?.immigrant_status
  if (immigrantStatus && immigrantStatus !== 'unknown' && immigrantStatus !== 'us_citizen') {
    immigrationSet.add(immigrantStatus.toLowerCase().replace(/_/g, ' ').trim())
    if (/refugee/i.test(immigrantStatus)) immigrationSet.add('refugee')
    if (/permanent.resident/i.test(immigrantStatus)) immigrationSet.add('permanent_resident')
    if (/new.immigrant/i.test(immigrantStatus)) immigrationSet.add('new_immigrant')
    if (/daca/i.test(immigrantStatus)) immigrationSet.add('daca')
    if (/asylee/i.test(immigrantStatus)) immigrationSet.add('asylee')
  }

  // ============ GEOGRAPHIC QUALIFIERS ============
  const geographicSet = new Set()
  if (demographicSet.has('rural')) geographicSet.add('rural')
  if (demographicSet.has('appalachian')) geographicSet.add('appalachian')
  if (demographicSet.has('urban_underserved')) geographicSet.add('urban_underserved')
  if (demographicSet.has('tribal')) geographicSet.add('tribal')
  if (demographicSet.has('frontier')) geographicSet.add('frontier')

  // ============ FULL EDUCATION OBJECT ============
  // Read major + STEM signals from EVERY supported field shape:
  //   eduSection.field_of_study, eduSection.intended_major, eduSection.major,
  //   plus the interests array and any university_applications[*].intended_major.
  // STEM detection considers the major, the interests/keywords list, and a
  // broader set of STEM disciplines (forensic science, criminal justice with
  // forensics, environmental science, health science, etc.) so STEM-track
  // students get the same boosts as engineering/CS students.
  const eduSection = sections?.education ?? sections?.education_details ?? {}
  const uniApps = sections?.university_applications ?? {}
  const eduInterestsRaw = Array.isArray(eduSection.interests)
    ? eduSection.interests
    : []
  const uniIntendedMajors = Array.isArray(uniApps.applications)
    ? uniApps.applications.map((a) => a?.intended_major).filter(Boolean)
    : []
  const intendedMajorResolved =
    eduSection.field_of_study ||
    eduSection.intended_major ||
    eduSection.major ||
    eduSection.degree_program ||
    uniIntendedMajors[0] ||
    null
  const STEM_DISCIPLINES = [
    'stem', 'engineering', 'computer science', 'mathematics', 'biology', 'chemistry',
    'physics', 'forensic', 'forensics', 'forensic science', 'biomedical',
    'biotechnology', 'environmental science', 'data science', 'statistics',
    'information technology', 'cybersecurity', 'health science', 'nursing',
    'paramedic', 'pre-med', 'pre med', 'pharmacy', 'veterinary', 'physics',
    'astronomy', 'geology', 'neuroscience', 'genetics', 'molecular',
    'mechanical', 'electrical', 'civil engineering', 'aerospace',
  ]
  const stemSearchHaystack = [
    String(intendedMajorResolved || ''),
    ...eduInterestsRaw.map((i) => String(i || '')),
    ...uniIntendedMajors.map((m) => String(m || '')),
  ].join(' ').toLowerCase()
  const stemStudentResolved = STEM_DISCIPLINES.some((s) => stemSearchHaystack.includes(s))

  const fullEducation = {
    level: eduSection.highest_level || eduSection.degree_type || null,
    currentSchool: eduSection.current_institution || eduSection.school_name || null,
    targetColleges: Array.isArray(eduSection.target_colleges) ? eduSection.target_colleges : [],
    intendedMajor: intendedMajorResolved,
    gpa: academics.gpa,
    act: academics.act,
    sat: academics.sat,
    firstGeneration: !!eduSection.first_generation,
    communityServiceHours: parseNumber(eduSection.community_service_hours),
    valedictorian: !!eduSection.valedictorian,
    leadershipRoles: Array.isArray(eduSection.leadership_roles) ? eduSection.leadership_roles : [],
    extracurriculars: Array.isArray(eduSection.extracurriculars) ? eduSection.extracurriculars : [],
    achievements: Array.isArray(eduSection.achievements) ? eduSection.achievements : [],
    stemStudent: stemStudentResolved,
    returningAdult: !!eduSection.returning_adult,
    recentGraduate: !!eduSection.recent_graduate,
    gedGraduate: !!eduSection.ged_graduate,
    jobRetraining: !!eduSection.job_retraining,
  }

  // ============ SCHOOLS (from university_applications) ============
  const schools = Array.isArray(uniApps.applications) ? uniApps.applications : []

  // ============ SPORTS ============
  const sportsSet = new Set()
  const sportsTerms = ['basketball','football','soccer','baseball','softball','volleyball','tennis','swimming','track','cross country','wrestling','lacrosse','hockey','golf','gymnastics','rowing','cheer','dance']
  for (const interest of interestSet) {
    if (sportsTerms.some(s => interest.includes(s))) sportsSet.add(interest)
  }

  // ============ ORGANIZATION DETAILS ============
  const orgDetailsSection = sections?.organization_details ?? {}
  const npCompliance = sections?.nonprofit_compliance ?? {}
  const organizationType = String(
    orgDetailsSection.organization_type ?? orgDetailsSection.org_type ?? '',
  ).trim() || null
  const organizationSignals = {
    // Specific organization identity is substantive matching evidence, not a
    // replacement for the broad applicant-type eligibility gate.
    orgType: organizationType,
    is501c3: !!npCompliance.has_501c3 || !!npCompliance.is_501c3 || !!orgDetailsSection.is_501c3,
    samRegistered: !!npCompliance.sam_registered || !!orgDetailsSection.sam_registered,
    faithBased: !!orgDetailsSection.faith_based,
    ein: npCompliance.ein || orgDetailsSection.ein || null,
    uei: npCompliance.uei || orgDetailsSection.uei || null,
    naicsCode: sections?.small_business_details?.naics_code || null,
  }

  // ============ RAW SECTIONS PASSTHROUGH ============
  const rawSections = sections

  // ============ COVERAGE TRACKING ============
  // Track how much of the profile data was processed to ensure 100% coverage.
  // This list must match ALL section keys in backend/config/profileSchema.js.
  const sectionKeys = Object.keys(sections || {})
  const expectedSections = [
    'basic_information', 'organization_details', 'financial_information',
    'government_assistance', 'health_medical', 'medical_insurance', 'medical_history',
    'nonprofit_compliance', 'small_business_details', 'demographics', 'family_life',
    'military_service', 'occupation', 'location_focus', 'university_applications',
    'education', 'employment', 'housing', 'family', 'programs_services', 'narrative',
  ]
  const presentSections = sectionKeys.filter(k => expectedSections.includes(k))
  
  // Calculate coverage percentage (at least 1 section = 100% for crawler purposes)
  // The crawler check requires pct >= 1 (i.e., at least some sections present)
  const coverage = {
    fields_total: keywordSet.size + phraseSet.size,
    fields_used: keywordSet.size + phraseSet.size,
    sections_present: presentSections.length,
    sections_expected: expectedSections.length,
    // Reflect actual section coverage as a fraction so crawlers can distinguish
    // a profile with 1 section from one with 18 sections.
    pct: expectedSections.length > 0
      ? Math.round((presentSections.length / expectedSections.length) * 100)
      : 0,
    // Separate signal richness metric: non-zero only when signals were extracted
    signal_richness: keywordSet.size > 0 ? Math.min(100, keywordSet.size) : 0,
  }

  // Educators / grant-seeking professionals must not inherit student-aid needs
  // from narrative keywords ("STEM education pathways", "scholarship", etc.).
  const eduSectionForGate = sections?.education ?? sections?.education_details ?? {}
  const hasExplicitStudentEnrollment =
    applicantType === 'student' ||
    Boolean(
      eduSectionForGate.currently_enrolled ||
        eduSectionForGate.enrolled_in_school ||
        eduSectionForGate.is_student ||
        eduSectionForGate.current_institution ||
        eduSectionForGate.school_name ||
        eduSectionForGate.grade_level ||
        (Array.isArray(eduSectionForGate.target_colleges) && eduSectionForGate.target_colleges.length > 0),
    ) ||
    demographicSet.has('current_student')

  if (!hasExplicitStudentEnrollment) {
    for (const studentAidNeed of ['scholarship', 'student_aid', 'student_living', 'cost_of_attendance']) {
      needs.delete(studentAidNeed)
    }
    const tagHaystack = [
      ...(Array.isArray(profile?.tags) ? profile.tags : []),
      profile?.primary_type,
      basic?.notes,
      sections?.narrative?.mission,
      sections?.narrative?.primary_goal,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    const isEducatorOrGrantSeeker =
      /\beducator\b|\binstructor\b|\bteacher\b|\bprofessor\b|\bcommunity (?:leader|advocate)\b|\bgrant\b|\bfunding\b|\bnonprofit\b|\bministr/.test(
        tagHaystack,
      )
    const adultLearner = Boolean(
      eduSectionForGate.returning_adult || eduSectionForGate.job_retraining || eduSectionForGate.ged_graduate,
    )
    if ((isEducatorOrGrantSeeker || applicantType === 'individual') && !adultLearner) {
      needs.delete('education')
    }
  }

  // Classify the CANONICAL flag tokens (the boolean-flag branch above). Unlike the
  // free-text fields — which are classified at their write site because only the
  // write site knows their provenance — these are a finite, known vocabulary, so a
  // table is honest here and a new flag cannot silently fall out (totality-tested:
  // health_conditions ∪ health_support ⊇ every canonical flag).
  for (const token of healthSet) {
    if (HEALTH_DIAGNOSIS_FLAGS.has(token)) healthConditionSet.add(token)
    else if (HEALTH_SUPPORT_FLAGS.has(token)) healthSupportSet.add(token)
  }

  return {
    keywords: Array.from(keywordSet),
    keywordSet,
    phrases: phraseSet,
    intentPhrases: intentPhraseSet,
    demographics: demographicSet,
    genders: genderSet,
    assistance: assistanceSet,
    military: militarySet,
    interests: interestSet,
    applicantTypes: applicantTypeSet,
    health: healthSet,
    // Provenance-split view of `needs` (which stays the union, unchanged):
    // needs derived from structured flags, status fields, assistance programs
    // and the declared funding_needs field — never from the narrative keyword
    // bag. Empty when the fallback defaulted `needs`.
    needs_structured: needsDefaulted ? new Set() : structuredNeeds,
    needs_text_inferred: textInferredNeeds,
    // Provenance-split views of `health` (which stays the union, unchanged).
    // Only `health_conditions` is a fair input to "does a disease lane exist?".
    health_conditions: healthConditionSet,
    health_support: healthSupportSet,
    family: familySet,
    occupation: occupationSet,
    credentials: credentialsSet,
    isLicensedProfessional: credentialsSet.size > 0,
    proBonoTerms,
    location,
    // Multi-location signals: `location` stays the primary (back-compat); `states` is
    // the deduped, primary-first list of ALL states across primary + secondary
    // addresses, and `locations` carries each resolved address. Geo-gating and local
    // crawlers should read `states` so every address is covered.
    secondaryLocation,
    locations,
    states,
    academics,
    financial,
    rawSections,
    coverage,
    needs,
    // TRUE when `needs` holds only the type-shaped fallback — i.e. the profile
    // declared no need at all and this set was inferred. See the fallback above.
    needsDefaulted,
    applicantType,
    immigration: immigrationSet,
    geographic: geographicSet,
    education: fullEducation,
    schools,
    sports: sportsSet,
    organization: organizationSignals,
  }
}

// ============================================================
// PROFILE DIGEST — for crawler idempotency (GF-AUDIT-019)
// ============================================================

/**
 * Return the list of section fields that are "material" for crawl purposes.
 * Changes to these fields should produce a different idempotency key,
 * triggering a fresh discovery run.  Cosmetic fields (notes, updated_by,
 * updated_at, display preferences) are intentionally excluded.
 *
 * @returns {Object.<string, string[]>} Map of section_key → material field names
 */
export function getMaterialFields() {
  return {
    basic_information: [
      'name', 'email', 'phone', 'address', 'zip_code', 'postal_code',
      'city', 'state', 'country',
    ],
    organization_details: [
      'organization_name', 'organization_type', 'mission', 'primary_type',
      'is_501c3', 'ein', 'uei', 'sam_registered', 'faith_based',
      'year_founded', 'annual_budget', 'staff_count',
    ],
    financial_information: [
      'annual_income', 'household_income', 'income_level', 'assets',
      'receiving_benefits', 'benefits_list',
    ],
    demographics: [
      'race', 'ethnicity', 'age', 'gender', 'disability_status',
      'veteran_status', 'immigration_status',
    ],
    narrative: [
      'mission_statement', 'programs_description', 'target_population',
      'geographic_focus', 'primary_focus_area',
    ],
    location_focus: [
      'service_area', 'counties', 'cities', 'states', 'national',
      'zip_codes',
    ],
    student_details: [
      'school_name', 'grade_level', 'gpa', 'major', 'degree_level',
      'enrollment_status',
    ],
    health_medical: [
      'chronic_illness', 'conditions', 'disability', 'mental_health',
      'substance_recovery',
    ],
    military_service: [
      'veteran', 'branch', 'service_era', 'discharge_status',
    ],
    small_business_details: [
      'naics_code', 'business_type', 'employee_count', 'annual_revenue',
      'years_in_business',
    ],
    programs_services: [
      'primary_programs', 'populations_served', 'service_types',
    ],
    family_life: [
      'household_size', 'children_count', 'marital_status', 'dependents',
    ],
  }
}

/**
 * Compute a short content-based digest of the material profile fields.
 *
 * The digest is intentionally coarse — it is designed to change when a user
 * edits any field that would meaningfully alter crawler search strategy, but
 * to remain stable across cosmetic/timestamp-only saves.
 *
 * @param {object} db - Database connection
 * @param {string} profileId - Profile ID
 * @returns {Promise<string>} First 16 hex chars of SHA-256 over material fields
 */
export async function computeProfileDigest(db, profileId) {
  if (!profileId) return 'no-profile'

  try {
    // Load base profile (primary_type is material; location fields live in sections)
    const profile = await db
      .prepare('SELECT primary_type FROM profiles WHERE id = ? LIMIT 1')
      .get(profileId)

    if (!profile) return 'profile-not-found'

    // Load all profile sections
    const sectionRows = await db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ? ORDER BY section_key')
      .all(profileId)

    const materialMap = getMaterialFields()

    // Build a stable object containing only material fields across all sections
    const digest = {}

    // Include material profile-level fields
    digest['__profile__'] = {
      primary_type: profile.primary_type ?? null,
    }

    for (const row of sectionRows) {
      const sectionKey = row.section_key
      const materialKeys = materialMap[sectionKey]
      if (!materialKeys) continue // section not tracked — skip

      let data
      try {
        data = JSON.parse(row.data || '{}')
      } catch {
        data = {}
      }

      const materialData = {}
      for (const field of materialKeys) {
        const val = data[field]
        if (val !== undefined && val !== null && val !== '') {
          materialData[field] = val
        }
      }

      if (Object.keys(materialData).length > 0) {
        digest[sectionKey] = materialData
      }
    }

    // Stable stringify (sorted keys at every level) then SHA-256, first 16 chars
    let stable
    try {
      function stableStr(val) {
        if (val === null || val === undefined) return 'null'
        if (typeof val !== 'object') return JSON.stringify(val)
        if (Array.isArray(val)) return '[' + val.map(stableStr).join(',') + ']'
        const sorted = Object.keys(val).sort()
        return '{' + sorted.map(k => JSON.stringify(k) + ':' + stableStr(val[k])).join(',') + '}'
      }
      stable = stableStr(digest)
    } catch (strErr) {
      console.warn('[computeProfileDigest] stableStr failed, falling back to JSON.stringify:', strErr?.message)
      stable = JSON.stringify(digest) || profileId
    }
    return crypto.createHash('sha256').update(stable).digest('hex').substring(0, 16)
  } catch (err) {
    console.warn('[computeProfileDigest] Failed to compute digest:', err?.message)
    return 'digest-error'
  }
}

/**
 * Compare two profile digests and determine whether the change is material.
 * A change is material when the digests differ (non-cosmetic fields changed).
 *
 * @param {string} oldDigest - Digest before the change
 * @param {string} newDigest - Digest after the change
 * @returns {boolean} true if the profile changed materially
 */
export function hasMaterialProfileChange(oldDigest, newDigest) {
  if (!oldDigest || !newDigest) return false
  return oldDigest !== newDigest
}

/**
 * buildProfileSignalAudit — single canonical helper for "what facts did the
 * matcher actually use about this profile?" (Phase 3 mission rule).
 *
 * Every match output (matching route, discovery route, Anya summary, pipeline
 * save) MUST attach the result of this function so users and tests can
 * answer "what facts from my profile caused this to appear?".
 *
 * Pure / synchronous: takes a profileContext-like object (the same shape
 * loadProfileContext / buildProfileContext produces) and returns a small,
 * stable JSON payload. Never throws.
 */
export function buildProfileSignalAudit(profileContext = {}) {
  const profile = profileContext?.profile ?? profileContext ?? {}
  const sections = profileContext?.sections ?? {}
  const signals = profileContext?.signals ?? {}
  const documents = Array.isArray(profileContext?.documents) ? profileContext.documents : []

  const setOrArrayToArray = (v) => {
    if (!v) return []
    if (Array.isArray(v)) return v
    if (typeof v?.values === 'function') return Array.from(v).slice(0, 12)
    if (typeof v === 'object') return Object.keys(v)
    return [String(v)]
  }

  const location_used = []
  if (profile?.zip || profile?.zip_code || profile?.postal_code) location_used.push('zip')
  if (profile?.city) location_used.push('city')
  if (profile?.county) location_used.push('county')
  if (profile?.state) location_used.push('state')

  const high_value_fields = [
    'state',
    'zip',
    'organization_type',
    'primary_type',
    'applicant_type',
  ]
  const missing_high_value_fields = high_value_fields.filter((f) => {
    const v = profile?.[f] ?? sections?.basic_information?.[f]
    return v === null || v === undefined || v === ''
  })

  return {
    profile_type:
      profile?.primary_type ?? profile?.applicant_type ?? profile?.organization_type ?? null,
    location_used,
    needs_used: setOrArrayToArray(signals?.needs).slice(0, 12),
    interests_used: setOrArrayToArray(signals?.interests).slice(0, 12),
    health_used: setOrArrayToArray(signals?.health).slice(0, 8),
    military_used: setOrArrayToArray(signals?.military).slice(0, 4),
    family_used: setOrArrayToArray(signals?.family).slice(0, 6),
    organization_used: profile?.organization_type ? [profile.organization_type] : [],
    documents_used: documents
      .map((d) => d?.title || d?.filename || d?.name)
      .filter(Boolean)
      .slice(0, 5),
    sections_seen: Object.keys(sections),
    missing_high_value_fields,
  }
}

export function summarizeProfileSignals(signals) {
  const parts = []
  if (signals.demographics?.size) {
    const labels = Array.from(signals.demographics)
      .slice(0, 3)
      .map((label) => label.replace(/_/g, ' '))
    parts.push(`Demographics: ${labels.join(', ')}`)
  }
  if (signals.genders?.size) {
    const labels = Array.from(signals.genders)
      .slice(0, 2)
      .map((label) => label.replace(/_/g, ' '))
    parts.push(`Gender: ${labels.join(', ')}`)
  }
  if (signals.assistance?.size) {
    const labels = Array.from(signals.assistance)
      .slice(0, 3)
      .map((label) => label.replace(/_/g, ' '))
    parts.push(`Assistance: ${labels.join(', ')}`)
  }
  if (signals.interests?.size) {
    const labels = Array.from(signals.interests)
      .slice(0, 4)
      .map((label) => label.replace(/_/g, ' '))
    parts.push(`Interests: ${labels.join(', ')}`)
  }
  if (signals.academics) {
    const academicParts = []
    if (signals.academics.gpa) academicParts.push(`GPA ${signals.academics.gpa}`)
    if (signals.academics.act) academicParts.push(`ACT ${signals.academics.act}`)
    if (signals.academics.sat) academicParts.push(`SAT ${signals.academics.sat}`)
    if (academicParts.length > 0) {
      parts.push(`Academics: ${academicParts.join(', ')}`)
    }
  }
  return parts.join(' • ')
}

/**
 * Merge grant categories/keywords into a profile's implicit_signals field.
 * Call this after a user saves or applies to a grant so future crawls are
 * better tuned to their revealed interests.
 *
 * @param {object} db - Database instance
 * @param {string} profileId - Profile to update
 * @param {object} opportunity - Opportunity record (categories, keywords, need_types_supported)
 * @param {'save'|'apply'} action - The triggering action
 */
export async function mergeOpportunitySignals(db, profileId, opportunity, action = 'save') {
  if (!db || !profileId || !opportunity) return

  // Fetch current implicit_signals
  const profileRow = await db
    .prepare('SELECT implicit_signals FROM profiles WHERE id = ?')
    .get(profileId)
  if (!profileRow) return

  const current = safeParseJSON(profileRow.implicit_signals, {})

  // Helper: deduplicate-merge an array into an existing set-like array
  const mergeInto = (existing, incoming) => {
    const arr = Array.isArray(existing) ? existing : []
    const next = Array.isArray(incoming) ? incoming : []
    const set = new Set([...arr, ...next.map((v) => String(v).trim().toLowerCase()).filter(Boolean)])
    return Array.from(set)
  }

  // Parse incoming categories and keywords from the opportunity
  const incomingCategories = safeParseArrayField(opportunity.categories, [])
  const incomingKeywords = safeParseArrayField(opportunity.keywords, [])
  const incomingNeedTypes = safeParseArrayField(opportunity.need_types_supported, [])

  // Merge into interested_categories (categories + need_types combined)
  current.interested_categories = mergeInto(
    current.interested_categories,
    [...incomingCategories, ...incomingNeedTypes]
  )

  // Merge keywords into interested_keywords
  current.interested_keywords = mergeInto(current.interested_keywords, incomingKeywords)

  // Increment counters
  if (action === 'save') {
    current.save_count = (current.save_count ?? 0) + 1
  } else if (action === 'apply') {
    current.apply_count = (current.apply_count ?? 0) + 1
    // Track categories the user applied to specifically
    current.applied_categories = mergeInto(
      current.applied_categories,
      [...incomingCategories, ...incomingNeedTypes]
    )
  }

  await db
    .prepare('UPDATE profiles SET implicit_signals = ? WHERE id = ?')
    .run(JSON.stringify(current), profileId)
}
