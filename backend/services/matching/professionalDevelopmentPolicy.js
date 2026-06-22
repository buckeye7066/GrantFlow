/**
 * Professional Development & Continuing Education matching policy.
 *
 * Ensures CE / licensure / remediation queries route to workforce boards,
 * nursing foundations, HRSA, VR, and association scholarships — not SSI.
 */

import { expandNeed } from '../shared/needTaxonomy.js'
import NATIONAL_PROGRAMS from '../shared/data/nationalPrograms.js'
import SCHOLARSHIPS from '../shared/data/scholarships.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('matching:professionalDevelopment')

/** Well-known branded CE / remediation program names → canonical need routing. */
export const BRANDED_CE_PROGRAMS = Object.freeze([
  { pattern: /\bprobe\b|\bpro-?be\b/i, programType: 'ethics_remediation', label: 'PROBE ethics/boundaries remediation' },
  { pattern: /\bciti\b/i, programType: 'research_ethics', label: 'CITI research ethics training' },
  { pattern: /\bscope\b/i, programType: 'professional_boundaries', label: 'SCOPE professional boundaries' },
  { pattern: /\bpace\b/i, programType: 'continuing_education', label: 'PACE continuing education' },
  { pattern: /\bcpep\b/i, programType: 'physician_remediation', label: 'CPEP physician remediation' },
  { pattern: /\bancc\b/i, programType: 'nursing_ce', label: 'ANCC nursing CE' },
  { pattern: /\bncsbn\b/i, programType: 'nursing_reinstatement', label: 'NCSBN nurse re-entry' },
])

export const PD_CATEGORY_CODES = Object.freeze([
  'professional_development_continuing_education',
  'license_reinstatement_support',
  'professional_remediation_funding',
  'nursing_reentry_support',
  'workforce_reentry_training',
  'continuing_education',
  'ce_cme_credits',
  'licensure_exam_fees',
  'remedial_coursework',
  'workforce_training',
])

export const INCOME_SUPPORT_CATEGORY_CODES = Object.freeze([
  'cash_assistance',
  'income_support',
  'ssi',
  'ssdi',
  'snap',
  'tanf',
  'general_assistance',
])

const PD_QUERY_RE =
  /\b(probe|pro-?be|ethics|boundaries|continuing education|cme|ce credits|licensure|license reinstatement|remediation|wioa|workforce training|professional development|board required|board-?required|return to practice|nurse re-?entry|vocational rehabilitation|ita\b|etpl|nursing foundation|hrsa|nhsc|nasw|ana foundation|tuition reimbursement|certification exam)\b/i

const CREDENTIAL_RE =
  /\b(rn|lpn|lvn|lcsw|lmft|lpc|md|do|pa|np|crna|cnm|pharmd|pt|ot|slp|rd|rt|emt|paramedic|cna)\b/i

const PD_PROGRAM_CATEGORIES = new Set([
  ...PD_CATEGORY_CODES,
  'employment',
  'education',
  'healthcare',
  'scholarship',
])

function parseCategories(raw) {
  if (Array.isArray(raw)) return raw.map((c) => String(c).toLowerCase())
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map((c) => String(c).toLowerCase())
    } catch {
      return raw.split(/[,|]/).map((c) => c.trim().toLowerCase()).filter(Boolean)
    }
  }
  return []
}

function oppText(opp) {
  return `${opp?.title || opp?.name || ''} ${opp?.description || ''} ${opp?.sponsor || ''}`.toLowerCase()
}

function oppCategories(opp) {
  return parseCategories(opp?.categories)
}

export function resolveBrandedProgram(text = '') {
  const raw = String(text || '')
  if (!raw.trim()) return null
  for (const entry of BRANDED_CE_PROGRAMS) {
    if (entry.pattern.test(raw)) {
      return { ...entry, matchedText: raw.slice(0, 200) }
    }
  }
  return null
}

/**
 * Detect whether the current search/profile context is a professional-development query.
 */
export function detectProfessionalDevelopmentIntent({
  searchTerms = [],
  freeText = '',
  profileContext = null,
} = {}) {
  const combinedText = [
    freeText,
    ...searchTerms,
    profileContext?.profile?.primary_goal,
    profileContext?.sections?.narrative?.primary_goal,
    profileContext?.sections?.occupation?.healthcare_worker_type,
    profileContext?.sections?.employment?.career_goal,
  ]
    .filter(Boolean)
    .join(' ')

  const branded = resolveBrandedProgram(combinedText)
  const expanded = expandNeed(combinedText)
  const expandedCats = expanded?.programCategories || []

  const pdFromTaxonomy =
    expanded?.matchedKey === 'license_reinstatement' ||
    expanded?.matchedKey === 'professional_development' ||
    expanded?.matchedKey === 'training' ||
    expanded?.matchedKey === 'licensure' ||
    expanded?.canonicalNeed === 'license_reinstatement_support' ||
    expanded?.canonicalNeed === 'professional_development_continuing_education' ||
    expandedCats.some((c) => PD_CATEGORY_CODES.includes(c))

  const pdFromQuery =
    PD_QUERY_RE.test(combinedText) ||
    searchTerms.some((t) => PD_QUERY_RE.test(String(t)))

  const profileNeeds = profileContext?.signals?.needs
  const needsSet = profileNeeds instanceof Set ? profileNeeds : new Set()
  const pdFromProfile =
    needsSet.has('license_reinstatement_support') ||
    needsSet.has('professional_remediation_funding') ||
    needsSet.has('nursing_reentry_support') ||
    needsSet.has('professional_development_continuing_education') ||
    CREDENTIAL_RE.test(combinedText)

  const active = Boolean(branded || pdFromTaxonomy || pdFromQuery)
  const profileDefault = !active && pdFromProfile

  return {
    active: active || profileDefault,
    profileDefault,
    branded,
    expandedNeed: expanded,
    canonicalNeed:
      expanded?.canonicalNeed ||
      (branded ? 'license_reinstatement_support' : null),
    programCategories: [...new Set([...expandedCats, ...PD_CATEGORY_CODES])],
    excludeIncomeSupport: active && !/\b(ssi|ssdi|snap|tanf|cash assistance)\b/i.test(combinedText),
  }
}

export function isIncomeSupportOpportunity(opp) {
  const cats = oppCategories(opp)
  const text = oppText(opp)
  if (cats.some((c) => INCOME_SUPPORT_CATEGORY_CODES.includes(c))) return true
  if (/\b(ssi|supplemental security income|ssdi|snap|food stamps|tanf|cash assistance|general assistance)\b/i.test(text)) {
    return true
  }
  if (/\bincome support\b/i.test(text) && !/\b(workforce|training|wioa|licen|certif|continuing education|probe|remediation)\b/i.test(text)) {
    return true
  }
  return false
}

export function isProfessionalDevelopmentOpportunity(opp) {
  const cats = oppCategories(opp)
  if (cats.some((c) => PD_PROGRAM_CATEGORIES.has(c))) return true
  const text = oppText(opp)
  return /\b(wioa|workforce|vocational rehabilitation|continuing education|cme|probe|license reinstatement|nursing re-?entry|remediation|professional boundaries|nurse corps|nhsc|american job center|ita\b|etpl)\b/i.test(text)
}

/**
 * Resolve a curated record's REAL geographic scope. The dataset records carry
 * `state` / `stateRestriction` / `eligibility.stateResident` for state-specific
 * programs and `isNational` for national ones. (Bug: this used to be discarded —
 * every curated program was stamped `nationwide`, so a Texas-only nurse grant or
 * a WV-resident scholarship matched everyone and bypassed the geo filter.)
 */
function recordState(record) {
  const raw =
    record.state ||
    record.stateRestriction ||
    record.eligibility?.stateResident ||
    null
  return raw ? String(raw).toUpperCase().trim() : null
}

function recordIsNational(record) {
  if (record.isNational === true || record.is_national === true) return true
  return !recordState(record)
}

function nationalRecordToOpportunity(record, sourceLabel) {
  const categories = Array.isArray(record.categories) ? record.categories : []
  const st = recordState(record)
  const national = recordIsNational(record)
  return {
    id: record.id || `${sourceLabel}-${record.name?.slice(0, 24) || 'program'}`,
    title: record.name || record.title || 'Professional development program',
    name: record.name || record.title,
    description: record.description || '',
    application_url: record.url || record.application_url || null,
    source_url: record.url || record.source_url || null,
    url: record.url || null,
    sponsor: record.sponsor || record.name?.split('—')[0]?.trim() || 'National program',
    source: sourceLabel,
    record_origin: 'curated_verified',
    // Preserve the record's REAL geography so the geo filter + geographic_match
    // reasoning are honest. National programs stay nationwide; state-specific
    // ones carry their state and are NOT flagged national.
    is_national: national,
    state: national ? 'nationwide' : st,
    is_active: true,
    is_loan: false,
    requires_match: false,
    deadline_type: 'rolling',
    categories: JSON.stringify(categories),
    keywords: JSON.stringify(categories),
    opportunity_type: record.type || 'program',
    funding_type: record.fundingType || record.funding_type || null,
    is_directory_resource: record.type === 'portal' || record.fundingType === 'referral_service',
    _pd_curated: true,
  }
}

// Ethnicity/heritage detection. A scholarship explicitly for one heritage is
// "explicitly exclusive" (Goal 4) — surfacing it to an unrelated profile is
// noise. The dataset's declared tokens are INCONSISTENT (the same fund is tagged
// in one file, untagged in the other), so we detect from the program NAME +
// description too and map each indicator to a canonical token we can match
// against the profile's STRUCTURED ethnicity/heritage. Each entry: [regex,
// canonicalToken].
const ETHNIC_PATTERNS = [
  [/asian|pacific islander|\baapi\b|\bapia\b/i, 'asian'],
  [/hispanic|latino|latina|latinx|chicano/i, 'hispanic'],
  [/united negro|negro college|\bhbcu\b|thurgood marshall|african[- ]?american|\bblack\b/i, 'black'],
  [/native american|american indian|alaska native|indigenous|\btribal\b|first nations/i, 'native american'],
  [/\bpolish\b/i, 'polish'],
  [/\bitalian\b/i, 'italian'],
  [/\bjewish\b|hebrew/i, 'jewish'],
  [/\barmenian\b/i, 'armenian'],
  [/\bgreek\b/i, 'greek'],
  [/\bportuguese\b/i, 'portuguese'],
  [/\bfilipino\b/i, 'filipino'],
  [/\bvietnamese\b/i, 'vietnamese'],
  [/\bkorean\b/i, 'korean'],
  [/\bchinese\b/i, 'chinese'],
  [/\bjapanese\b/i, 'japanese'],
]

/** Canonical heritage tokens a record targets, detected from name+description. */
function detectEthnicTargets(record) {
  const text = `${record?.name || record?.title || ''} ${record?.description || ''}`
  const out = new Set()
  for (const [re, token] of ETHNIC_PATTERNS) {
    if (re.test(text)) out.add(token)
  }
  return out
}

function lowerSet(value) {
  const out = new Set()
  const add = (x) => { if (x !== null && x !== undefined) { const s = String(x).toLowerCase().trim(); if (s) out.add(s) } }
  if (value instanceof Set) for (const x of value) add(x)
  else if (Array.isArray(value)) for (const x of value) add(x)
  return out
}

/**
 * Build a compact descriptor of who the profile IS, from its signals, so curated
 * records can be matched against their declared targeting.
 */
export function buildProfileTargeting(profileContext) {
  const sig = profileContext?.signals ?? {}
  const states = new Set()
  const addState = (x) => { if (x) states.add(String(x).toUpperCase().trim()) }
  addState(sig?.location?.state)
  if (Array.isArray(sig?.states)) sig.states.forEach(addState)
  const occupations = lowerSet(sig?.occupation)
  const demographics = lowerSet(sig?.demographics)
  const interests = lowerSet(sig?.interests)
  // Ethnicity/heritage from the STRUCTURED demographics section — NOT the
  // signals.keywordSet bag, which over-expands (e.g. it contained 'asian' for a
  // White/Polish profile and let an API-heritage fund slip through). The
  // structured fields are the reliable identity for heritage gating.
  const demoSection = profileContext?.sections?.demographics ?? {}
  const ethnicityText = [
    demoSection.ethnicity, demoSection.race, demoSection.heritage,
    demoSection.tribal_affiliation, demoSection.nationality, demoSection.ancestry,
  ].filter(Boolean).map((x) => String(x).toLowerCase()).join(' ')
  const primaryType = String(profileContext?.profile?.primary_type || profileContext?.profile?.primary_profile_type || '').toLowerCase()
  const isStudent = primaryType.includes('student') || occupations.has('student')
  return { states, occupations, demographics, interests, ethnicityText, isStudent }
}

/**
 * Does a curated record actually fit this profile? We only ever REJECT on a
 * dimension the record itself DECLARES (state / occupation / student / heritage)
 * — a record with no declared targeting is broadly relevant and kept. This keeps
 * "missing profile field is neutral" (Goal 4) while honoring each program's
 * explicit exclusivity. Returns true when no targeting info is available
 * (profile-less callers) so behavior degrades to the old broad list rather than
 * silently emptying.
 */
export function recordMatchesProfile(record, targeting) {
  if (!targeting) return true

  // Geography — a state-restricted program is explicitly exclusive.
  if (!recordIsNational(record)) {
    const st = recordState(record)
    if (st) {
      if (targeting.states.size === 0) return false // unknown profile state → don't push a state-only program
      if (!targeting.states.has(st)) return false
    }
  }

  // Student requirement.
  if (record.eligibility?.requiresStudent && !targeting.isStudent) return false

  // Occupation targeting (e.g. nurse / social worker / first responder programs).
  // Match against the structured occupation + interest signals only (NOT the
  // over-broad keywordSet bag).
  const occ = Array.isArray(record.occupationMatch) ? record.occupationMatch.map((o) => String(o).toLowerCase()) : []
  if (occ.length > 0) {
    const hit = occ.some((o) => targeting.occupations.has(o) || targeting.interests.has(o))
    if (!hit) return false
  }

  // Heritage / ethnicity targeting — detected from the program name+description
  // (reliable; the dataset's declared tokens are inconsistent). When a record
  // targets a specific heritage, require the profile's STRUCTURED ethnicity to
  // include it. We do NOT match against the keyword/interest bags (they
  // over-expand — e.g. 'asian' appeared for a White/Polish profile).
  const ethnicTargets = detectEthnicTargets(record)
  if (ethnicTargets.size > 0) {
    // Word-boundary match so 'asian' does NOT match "Cauc-asian" (substring
    // false-positive that let an API-heritage fund through for a White profile).
    const hit = [...ethnicTargets].some((t) => new RegExp(`\\b${t}\\b`, 'i').test(targeting.ethnicityText))
    if (!hit) return false
  }

  return true
}

/**
 * Load curated national PD / CE / reinstatement programs for injection into
 * catalog matching — PROFILE-AWARE. Only programs whose declared targeting
 * (state, occupation, student status, heritage) actually fits the profile are
 * returned, so a TN student no longer gets Texas/Florida nurse grants, a
 * WV-only scholarship, or an API-heritage fund. Pass the profileContext (the
 * legacy string-state signature is still accepted but ignored → broad list).
 */
export function loadCuratedProfessionalDevelopmentPrograms(profileContextOrState = null) {
  const profileContext =
    profileContextOrState && typeof profileContextOrState === 'object' ? profileContextOrState : null
  const targeting = profileContext ? buildProfileTargeting(profileContext) : null

  const seen = new Set()
  const out = []
  let skipped = 0

  const isPdRecord = (rec) => {
    const cats = Array.isArray(rec.categories) ? rec.categories : []
    return cats.some((c) => PD_PROGRAM_CATEGORIES.has(String(c).toLowerCase()))
  }

  const consider = (rec, sourceLabel) => {
    if (!isPdRecord(rec)) return
    if (seen.has(rec.id)) return
    seen.add(rec.id)
    if (!recordMatchesProfile(rec, targeting)) { skipped += 1; return }
    out.push(nationalRecordToOpportunity(rec, sourceLabel))
  }

  for (const rec of NATIONAL_PROGRAMS) consider(rec, 'national_pd_program')
  for (const rec of SCHOLARSHIPS) consider(rec, 'national_pd_scholarship')

  if (targeting && skipped > 0) {
    log.info(`[pd] curated injection: kept ${out.length}, skipped ${skipped} as off-profile (state/occupation/student/heritage)`)
  }
  return out
}

/**
 * Apply PD query policy to scored opportunities:
 * - drop income-support rows unless user explicitly asked for them
 * - cap cross-category mismatches at 25%
 */
export function applyProfessionalDevelopmentQueryPolicy(opportunities, intent) {
  if (!intent?.active || !Array.isArray(opportunities)) return opportunities

  return opportunities
    .map((opp) => {
      if (intent.excludeIncomeSupport && isIncomeSupportOpportunity(opp)) {
        return null
      }

      const pdOpp = isProfessionalDevelopmentOpportunity(opp)
      if (!pdOpp && intent.active) {
        const capped = Math.min(Number(opp.match_score ?? 0), 25)
        if (capped !== opp.match_score) {
          return {
            ...opp,
            match_score: capped,
            match: capped,
            pd_cross_category_capped: true,
            match_explanation: `${opp.match_explanation || ''} Cross-category mismatch with professional development query (capped at 25%).`.trim(),
          }
        }
      }
      return opp
    })
    .filter(Boolean)
}

/**
 * Lightweight telemetry for admin review when qualified results are sparse.
 */
export async function recordLowCoverageEvent(db, payload = {}) {
  const {
    profileId,
    searchTerms = [],
    freeText = '',
    qualifiedCount = 0,
    minScore = 50,
    intent = null,
  } = payload

  const event = {
    profile_id: profileId || null,
    search_terms: searchTerms,
    free_text: freeText?.slice(0, 500) || null,
    qualified_count: qualifiedCount,
    min_score: minScore,
    intent: intent?.canonicalNeed || null,
    branded_program: intent?.branded?.label || null,
    recorded_at: new Date().toISOString(),
  }

  log.info('[low_coverage]', event)

  if (!db?.prepare) return event

  try {
    await db.prepare(`
      INSERT INTO matching_low_coverage_events
        (profile_id, search_terms, free_text, qualified_count, min_score, intent_label, branded_program, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.profile_id,
      JSON.stringify(event.search_terms),
      event.free_text,
      event.qualified_count,
      event.min_score,
      event.intent,
      event.branded_program,
      event.recorded_at,
    )
  } catch (err) {
    log.warn('Could not persist low_coverage event (table may not exist yet):', err?.message)
  }

  return event
}

export default {
  BRANDED_CE_PROGRAMS,
  PD_CATEGORY_CODES,
  resolveBrandedProgram,
  detectProfessionalDevelopmentIntent,
  isIncomeSupportOpportunity,
  isProfessionalDevelopmentOpportunity,
  loadCuratedProfessionalDevelopmentPrograms,
  applyProfessionalDevelopmentQueryPolicy,
  recordLowCoverageEvent,
}
