/**
 * ClinicalTrials.gov Connector
 *
 * Surfaces RECRUITING clinical trials / research studies that a person with
 * MEDICAL NEEDS may be able to join AS A PARTICIPANT, emphasizing early-phase
 * (Phase 1 / Early Phase 1) studies.
 *
 * IMPORTANT — these are STUDIES, NOT FUNDING:
 *   - Normalized records carry opportunity_type / funding_type = 'clinical_trial'
 *     so they are never confused with grants, scholarships, or loans.
 *   - Joining a study is a PERSONAL CHOICE. This connector is discovery-only:
 *     it never enrolls, never auto-submits, and only runs for a profile that has
 *     EXPLICITLY opted in (see isOptedIntoClinicalTrials / connectorIngestService).
 *   - GrantFlow surfaces the listing; the user signs up themselves on the real
 *     ClinicalTrials.gov study page or by contacting the study team.
 *
 * API: Public ClinicalTrials.gov REST API v2 — NO API KEY REQUIRED.
 *   Docs:  https://clinicaltrials.gov/data-api/api
 *   Base:  https://clinicaltrials.gov/api/v2/studies
 *   Study URL: https://clinicaltrials.gov/study/<NCTID>
 *
 * Contract (mission rules):
 *   - REAL data only — never fabricate a study, NCT id, sponsor, or URL.
 *   - NEVER throws — on any failure logs and returns [] (no silent enrollment,
 *     no zero-vs-error ambiguity for the caller).
 *   - Only RECRUITING studies are returned; early-phase studies are boosted.
 */

import fetch from 'node-fetch'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('clinicalTrialsConnector')

const API_BASE = 'https://clinicaltrials.gov/api/v2/studies'
const STUDY_URL_PREFIX = 'https://clinicaltrials.gov/study/'
const RATE_LIMIT_MS = 1000 // polite: 1 req/sec

// Record origin / source so downstream trust + dedupe treat these consistently.
export const CLINICAL_TRIALS_SOURCE = 'clinicaltrials.gov'
export const CLINICAL_TRIALS_RECORD_ORIGIN = 'clinical_trials'

// Recruiting-only statuses we surface. A medical-need participant can only join
// a study that is actively (or about to be) enrolling.
const RECRUITING_STATUSES = new Set(['RECRUITING', 'ENROLLING_BY_INVITATION'])

// Early-phase markers we boost (the user's explicit ask: early/Phase 1).
const EARLY_PHASES = new Set(['EARLY_PHASE1', 'PHASE1'])

let lastRequestAt = 0

async function rateLimitedFetch(url) {
  const now = Date.now()
  const sinceLast = now - lastRequestAt
  if (sinceLast < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - sinceLast))
  }
  lastRequestAt = Date.now()
  return fetch(url, {
    // node-fetch has no default deadline; without a signal a hung remote stalls the caller forever.
    signal: AbortSignal.timeout(30000),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GrantFlow/1.0 (medical-needs study discovery)',
    },
  })
}

/**
 * Does this profile health section EXPLICITLY opt in to study discovery?
 *
 * Opt-in is a deliberate, affirmative choice. We accept the existing
 * `consent_for_studies` flag (already surfaced by HealthResourcesCard) and the
 * additive `clinical_trials_opt_in` alias. Anything falsy / missing means NOT
 * opted in — we never surface trials by default.
 *
 * @param {object} healthSection - sections.health_medical (or equivalent)
 * @returns {boolean}
 */
export function isOptedIntoClinicalTrials(healthSection) {
  if (!healthSection || typeof healthSection !== 'object') return false
  const truthy = (v) => v === true || v === 1 || v === '1' ||
    (typeof v === 'string' && ['true', 'yes', 'y', 'on'].includes(v.trim().toLowerCase()))
  return truthy(healthSection.clinical_trials_opt_in) ||
    truthy(healthSection.consent_for_studies)
}

/**
 * Extract de-duplicated condition/diagnosis search terms from a profile's
 * health/medical section. Reads the same real field names buildProfileSignals
 * uses for health signals: `conditions` (array of {name}|string),
 * `chronic_illness_type`, and `disability_type`.
 *
 * @param {object} healthSection - sections.health_medical
 * @returns {string[]} lowercased, de-duped condition terms (most specific first)
 */
export function extractConditionTerms(healthSection) {
  if (!healthSection || typeof healthSection !== 'object') return []
  const seen = new Set()
  const out = []
  const add = (raw) => {
    if (!raw) return
    const term = String(raw).trim()
    if (term.length < 3 || term.length > 80) return
    const key = term.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(term)
  }

  // Structured conditions (array of {name}|string).
  const conditions = Array.isArray(healthSection.conditions) ? healthSection.conditions : []
  for (const entry of conditions) {
    if (typeof entry === 'string') add(entry)
    else if (entry && typeof entry === 'object') add(entry.name)
  }

  // Free-text chronic illness type.
  if (typeof healthSection.chronic_illness_type === 'string') {
    add(healthSection.chronic_illness_type)
  }

  // Disability types are diagnoses too (e.g. "epilepsy", "multiple sclerosis").
  const disability = Array.isArray(healthSection.disability_type) ? healthSection.disability_type : []
  for (const dt of disability) add(dt)

  return out
}

/**
 * Build a ClinicalTrials.gov API v2 query URL for one condition.
 * Filters server-side to RECRUITING and sorts so the most recently updated
 * studies come first. We over-fetch and then phase-filter/boost client-side
 * so early-phase studies always lead.
 *
 * @param {string} condition
 * @param {object} [opts]
 * @param {string|null} [opts.state] - 2-letter US state to bias location
 * @param {number} [opts.pageSize=30]
 * @returns {string} fully-qualified API URL
 */
export function buildStudyQueryUrl(condition, opts = {}) {
  const { state = null, pageSize = 30 } = opts
  const params = new URLSearchParams()
  params.set('query.cond', String(condition || '').trim())
  // Recruiting-only at the source. The v2 API accepts pipe-separated statuses.
  params.set('filter.overallStatus', 'RECRUITING|ENROLLING_BY_INVITATION')
  if (state) {
    // Bias toward the participant's state when known (still returns national).
    params.set('query.locn', String(state).trim())
  }
  params.set('pageSize', String(Math.max(1, Math.min(Number(pageSize) || 30, 100))))
  params.set('sort', 'LastUpdatePostDate:desc')
  // Only request the fields we normalize — keeps the payload small.
  params.set(
    'fields',
    [
      'NCTId',
      'BriefTitle',
      'OfficialTitle',
      'OverallStatus',
      'Phase',
      'Condition',
      'LeadSponsorName',
      'EligibilityCriteria',
      'MinimumAge',
      'MaximumAge',
      'Sex',
      'LocationCity',
      'LocationState',
      'LocationCountry',
    ].join('|'),
  )
  return `${API_BASE}?${params.toString()}`
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

/**
 * Normalize a single ClinicalTrials.gov v2 study object into a GrantFlow
 * opportunity record clearly labeled as a clinical_trial STUDY.
 *
 * Returns null when the study cannot be honestly represented (no NCT id, not
 * recruiting). NEVER fabricates missing fields.
 *
 * @param {object} study - one entry from API response `.studies[]`
 * @returns {object|null}
 */
export function normalizeStudy(study) {
  const ps = study?.protocolSection
  if (!ps || typeof ps !== 'object') return null

  const nctId = firstString(ps.identificationModule?.nctId)
  if (!nctId || !/^NCT\d{6,}$/i.test(nctId)) return null

  const status = String(ps.statusModule?.overallStatus || '').toUpperCase()
  if (!RECRUITING_STATUSES.has(status)) return null

  const title = firstString(
    ps.identificationModule?.briefTitle,
    ps.identificationModule?.officialTitle,
  )
  if (!title) return null

  const sponsor = firstString(ps.sponsorCollaboratorsModule?.leadSponsor?.name)
  const phases = Array.isArray(ps.designModule?.phases) ? ps.designModule.phases : []
  const phaseUpper = phases.map((p) => String(p).toUpperCase())
  const isEarlyPhase = phaseUpper.some((p) => EARLY_PHASES.has(p))

  const conditions = Array.isArray(ps.conditionsModule?.conditions)
    ? ps.conditionsModule.conditions.map((c) => String(c).trim()).filter(Boolean)
    : []

  const eligibility = ps.eligibilityModule || {}
  const eligibilityBullets = []
  const sex = firstString(eligibility.sex)
  if (sex && sex.toUpperCase() !== 'ALL') eligibilityBullets.push(`Sex: ${sex}`)
  const minAge = firstString(eligibility.minimumAge)
  if (minAge) eligibilityBullets.push(`Minimum age: ${minAge}`)
  const maxAge = firstString(eligibility.maximumAge)
  if (maxAge) eligibilityBullets.push(`Maximum age: ${maxAge}`)

  // Location (first listed) — purely informational for the participant.
  const loc = Array.isArray(ps.contactsLocationsModule?.locations)
    ? ps.contactsLocationsModule.locations[0]
    : null
  const locState = firstString(loc?.state)
  const locCity = firstString(loc?.city)

  const phaseLabel = phaseUpper.length
    ? phaseUpper.map((p) => p.replace(/_/g, ' ').replace(/PHASE/i, 'Phase')).join(', ')
    : 'Not specified'

  const studyUrl = `${STUDY_URL_PREFIX}${nctId}`

  // Honest label: this is a STUDY a participant may join, not money.
  const description =
    `Clinical research study (${phaseLabel}, currently ${status.toLowerCase().replace(/_/g, ' ')}). ` +
    (conditions.length ? `Conditions: ${conditions.slice(0, 5).join(', ')}. ` : '') +
    'This is a study you may be able to participate in — it is NOT funding. ' +
    'Eligibility is determined by the study team; sign up on ClinicalTrials.gov.'

  return {
    // Identity / dedupe
    title,
    sponsor: sponsor || 'Study sponsor (see ClinicalTrials.gov)',
    source: CLINICAL_TRIALS_SOURCE,
    source_id: nctId,
    external_id: nctId,
    // Real, verifiable study URL.
    source_url: studyUrl,
    application_url: studyUrl,
    evidence_url: studyUrl,
    url: studyUrl,
    description,
    eligibility_bullets: eligibilityBullets,
    // DISTINCT type so this is never mistaken for a grant/loan/scholarship.
    opportunity_type: 'clinical_trial',
    funding_type: 'clinical_trial',
    type: 'STUDY',
    // Studies enroll on a rolling basis; there is no award deadline.
    deadline: null,
    deadline_type: 'rolling',
    is_national: !locState,
    state: locState || null,
    categories: [
      'clinical_trial',
      'research_study',
      'health',
      'medical',
      ...(isEarlyPhase ? ['early_phase', 'phase_1'] : []),
    ],
    keywords: [...conditions.slice(0, 8), ...phaseUpper, status].filter(Boolean),
    record_origin: CLINICAL_TRIALS_RECORD_ORIGIN,
    // Surfacing metadata used by the connector to rank early-phase first.
    _phase: phaseUpper,
    _is_early_phase: isEarlyPhase,
    _status: status,
    _location: [locCity, locState].filter(Boolean).join(', ') || null,
    last_crawled: new Date().toISOString(),
  }
}

/**
 * Search ClinicalTrials.gov for RECRUITING studies matching the given
 * conditions, emphasizing early-phase. NEVER throws — logs and returns [].
 *
 * @param {object} args
 * @param {string[]} args.conditions - condition/diagnosis terms from the profile
 * @param {string|null} [args.state] - participant's 2-letter US state (location bias)
 * @param {number} [args.maxConditions=4] - how many conditions to query
 * @param {number} [args.pageSize=30] - results requested per condition
 * @param {boolean} [args.earlyPhaseOnly=false] - drop non-early-phase studies entirely
 * @returns {Promise<object[]>} normalized clinical_trial opportunity records
 */
export async function searchClinicalTrials({
  conditions = [],
  state = null,
  maxConditions = 4,
  pageSize = 30,
  earlyPhaseOnly = false,
} = {}) {
  const terms = (Array.isArray(conditions) ? conditions : [])
    .map((c) => String(c || '').trim())
    .filter((c) => c.length >= 3)
    .slice(0, Math.max(1, maxConditions))

  if (terms.length === 0) {
    // No conditions = nothing relevant to a medical-need participant. Honest
    // empty result, not an error.
    return []
  }

  const byNct = new Map()
  for (const condition of terms) {
    try {
      const url = buildStudyQueryUrl(condition, { state, pageSize })
      const res = await rateLimitedFetch(url)
      if (!res.ok) {
        log.warn(`[clinicalTrials] HTTP ${res.status} for condition "${condition}" — skipping`)
        continue
      }
      const data = await res.json()
      const studies = Array.isArray(data?.studies) ? data.studies : []
      for (const study of studies) {
        const normalized = normalizeStudy(study)
        if (!normalized) continue
        if (earlyPhaseOnly && !normalized._is_early_phase) continue
        // De-dupe by NCT id across condition queries; keep the first hit.
        if (!byNct.has(normalized.source_id)) byNct.set(normalized.source_id, normalized)
      }
    } catch (err) {
      // No silent enrollment, no thrown error: record and continue.
      log.warn(`[clinicalTrials] search failed for condition "${condition}": ${err?.message || err}`)
    }
  }

  // Boost early-phase (the user's explicit ask) to the top.
  return [...byNct.values()].sort((a, b) => {
    if (a._is_early_phase !== b._is_early_phase) return a._is_early_phase ? -1 : 1
    return 0
  })
}

export default {
  CLINICAL_TRIALS_SOURCE,
  CLINICAL_TRIALS_RECORD_ORIGIN,
  isOptedIntoClinicalTrials,
  extractConditionTerms,
  buildStudyQueryUrl,
  normalizeStudy,
  searchClinicalTrials,
}
