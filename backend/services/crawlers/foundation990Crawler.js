/**
 * Foundation 990 Batch Crawler
 *
 * Ingests foundation/grantmaker data from ProPublica's 990 filings API
 * into the funding_opportunities table.
 *
 * TWO MODES (canonical goal: "use the FULL profile"):
 *
 *   1. PROFILE-DRIVEN (default whenever a job carries a profileContext/signals):
 *      - States are derived from the profile (ALL of its states: primary +
 *        secondary, via signals.states), NOT a hardcoded ['nationwide'].
 *      - NTEE codes are derived from the profile's primary_type / needs /
 *        keywords via deriveNteeCodesForProfile(), NOT a hardcoded ['T'].
 *      - Every returned foundation is scored against the profile with the
 *        CANONICAL matcher (computeMatchDecision), filtered against the
 *        profile's pipeline exclusions, and only ACCEPT/REVIEW matches with a
 *        meaningful score are surfaced/inserted.
 *
 *   2. ADMIN BATCH (no profileContext): falls back to the historical static
 *      params so the nationwide grantmaker sweep keeps working unchanged.
 *
 * Job type: 'foundation_990'
 * Dispatched via crawlerDispatcher.js (which passes context.profileContext).
 */

import { searchOrganizations, orgToFundingOpportunity } from '../../src/integrations/propublica990.js'
import { bulkUpsertFundingOpportunities } from '../opportunityInserter.js'
import { computeMatchDecision } from '../matchEngine.js'
import { filterOutPipelineMembers } from '../pipelineExclusion.js'
import { NTEE_DESCRIPTIONS, needsToNteeCodes } from '../../constants/nteeMapping.js'
import { createLogger } from '../../utils/logger.js'
const log = createLogger('foundation990Crawler')

const DEFAULT_MIN_GRANT = 10_000
const DEFAULT_MAX_PAGES = 20
const RATE_LIMIT_MS = 250

// Minimum canonical match score (0-100) below which a profile-driven foundation
// is not surfaced. We keep this modest (G2: zero-results is a failure state),
// but high enough that a foundation must show SOME profile relevance.
const PROFILE_MATCH_FLOOR = 40

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * Map a profile's PRIMARY TYPE (entity / applicant type) to NTEE major-group
 * letters. Foundations are classified by who/what they fund; this gives us a
 * sensible default search axis even when the profile declared no explicit needs.
 *
 * Letters reference NTEE_DESCRIPTIONS in constants/nteeMapping.js.
 */
const PRIMARY_TYPE_TO_NTEE = {
  // Faith / religion
  church: ['X'],
  faith: ['X'],
  faith_based: ['X'],
  ministry: ['X'],
  religious: ['X'],
  // Education / students
  student: ['B'],
  college_student: ['B'],
  high_school_student: ['B'],
  school: ['B'],
  education: ['B'],
  researcher: ['H', 'U'], // medical research + science & technology
  // Health
  health: ['E', 'G'],
  healthcare: ['E', 'G'],
  medical: ['E', 'G'],
  medical_assistance: ['E', 'G'],
  patient: ['E', 'G'],
  // Human services / individuals / families
  individual: ['P'],
  individual_need: ['P'],
  family: ['P'],
  caregiver: ['P'],
  senior: ['P'],
  // Arts & culture
  arts: ['A'],
  artist: ['A'],
  culture: ['A'],
  // Veterans
  veteran: ['W'],
  military: ['W'],
  // Business / nonprofits / orgs
  business: ['S', 'W'],
  small_business: ['S', 'W'],
  nonprofit: ['T', 'S'], // grantmaking + community improvement
  organization: ['T', 'S'],
  government: ['W'],
  municipality: ['W'],
}

// Lightweight keyword → NTEE letter hints. Applied against the profile's free
// keyword set so an unusual profile still steers the search. Each entry is an
// array of substrings that imply the letter.
const KEYWORD_NTEE_HINTS = [
  { letter: 'X', any: ['church', 'faith', 'ministry', 'congregation', 'religious', 'gospel', 'parish'] },
  { letter: 'B', any: ['school', 'student', 'scholarship', 'tuition', 'education', 'college', 'university', 'classroom'] },
  { letter: 'A', any: ['art', 'music', 'theater', 'theatre', 'museum', 'culture', 'humanities'] },
  { letter: 'E', any: ['health', 'clinic', 'hospital', 'medical', 'patient', 'healthcare'] },
  { letter: 'F', any: ['mental health', 'counseling', 'crisis', 'suicide', 'behavioral'] },
  { letter: 'G', any: ['disease', 'cancer', 'diabetes', 'illness', 'diagnosis'] },
  { letter: 'P', any: ['human service', 'family', 'caregiver', 'senior', 'elderly', 'disability', 'poverty', 'assistance'] },
  { letter: 'L', any: ['housing', 'shelter', 'homeless', 'rent', 'eviction'] },
  { letter: 'K', any: ['food', 'nutrition', 'hunger', 'pantry', 'agriculture', 'farm'] },
  { letter: 'J', any: ['employment', 'workforce', 'job', 'career', 'vocational'] },
  { letter: 'M', any: ['ems', 'paramedic', 'ambulance', 'fire', 'first responder', 'public safety', 'disaster', 'emergency'] },
  { letter: 'W', any: ['veteran', 'military', 'service member'] },
  { letter: 'C', any: ['environment', 'conservation', 'climate', 'wildlife'] },
  { letter: 'D', any: ['animal', 'rescue', 'shelter pet', 'wildlife'] },
  { letter: 'S', any: ['community development', 'economic development', 'rural', 'small business', 'entrepreneur'] },
  { letter: 'U', any: ['technology', 'science', 'research', 'stem'] },
  { letter: 'I', any: ['legal', 'justice', 'attorney', 'court'] },
]

function asIterable(v) {
  if (!v) return []
  if (Array.isArray(v)) return v
  if (typeof v[Symbol.iterator] === 'function') return Array.from(v)
  return []
}

/**
 * Derive the set of NTEE major-group letters to search for a given profile's
 * signals. Combines (a) the canonical needs→NTEE map, (b) the primary-type map,
 * and (c) keyword hints. Always returns at least one code; falls back to 'T'
 * (grantmaking foundations) only when nothing else is derivable so the search
 * is never empty (G2: zero-results is a failure state).
 *
 * @param {Object} signals - buildProfileSignals() output (or compatible)
 * @returns {string[]} unique NTEE letters
 */
export function deriveNteeCodesForProfile(signals) {
  const codes = new Set()

  // (a) Canonical needs → NTEE. signals.needs is a Set of canonical need keys.
  const needs = asIterable(signals?.needs).map((n) => String(n).toLowerCase())
  for (const code of needsToNteeCodes(needs)) {
    // needsToNteeCodes always appends 'T'; keep it only if other codes are also
    // present so a needs-only profile still benefits from grantmaker coverage.
    codes.add(code)
  }

  // (b) Primary / applicant type → NTEE.
  const primaryTypes = new Set()
  const addType = (t) => { const s = String(t || '').toLowerCase().trim(); if (s) primaryTypes.add(s) }
  addType(signals?.applicantType)
  addType(signals?.primaryType)
  addType(signals?.entityType)
  for (const t of asIterable(signals?.applicantTypes)) addType(t)
  for (const t of primaryTypes) {
    for (const c of (PRIMARY_TYPE_TO_NTEE[t] || [])) codes.add(c)
  }

  // Demographic / military flags steer some letters explicitly.
  const military = asIterable(signals?.military).map((m) => String(m).toLowerCase())
  if (military.length > 0) codes.add('W')
  const demographics = asIterable(signals?.demographics).map((d) => String(d).toLowerCase())
  if (demographics.some((d) => d.includes('veteran'))) codes.add('W')

  // (c) Keyword hints.
  const keywords = [
    ...asIterable(signals?.keywords),
    ...asIterable(signals?.keywordSet),
    ...asIterable(signals?.occupation),
    ...asIterable(signals?.interests),
  ].map((k) => String(k).toLowerCase())
  const keywordBlob = keywords.join(' ')
  if (keywordBlob) {
    for (const hint of KEYWORD_NTEE_HINTS) {
      if (hint.any.some((needle) => keywordBlob.includes(needle))) codes.add(hint.letter)
    }
  }

  if (codes.size === 0) codes.add('T')
  return [...codes]
}

/**
 * Derive ALL of a profile's states (primary first, deduped, uppercased).
 * Reads signals.states (multi-address) and falls back to the primary location.
 * Returns ['nationwide'] only when no state is known so the search still runs.
 *
 * @param {Object} signals
 * @returns {string[]}
 */
export function deriveStatesForProfile(signals) {
  const out = []
  const add = (v) => {
    const s = String(v ?? '').toUpperCase().trim()
    if (s && s.length === 2 && !out.includes(s)) out.push(s)
  }
  add(signals?.location?.state)
  for (const st of asIterable(signals?.states)) add(st)
  return out.length > 0 ? out : ['nationwide']
}

/**
 * Build the per-job parameters, preferring the profile when one is supplied.
 * @returns {{ states, ntee_codes, min_grant_amount, max_pages, profileDriven }}
 */
function resolveJobParams(params, signals) {
  const max_pages = params.max_pages ?? DEFAULT_MAX_PAGES
  const min_grant_amount = params.min_grant_amount ?? DEFAULT_MIN_GRANT

  if (signals) {
    return {
      states: params.states ?? deriveStatesForProfile(signals),
      ntee_codes: params.ntee_codes ?? deriveNteeCodesForProfile(signals),
      min_grant_amount,
      max_pages,
      profileDriven: true,
    }
  }

  // Admin batch fallback — historical static defaults.
  return {
    states: params.states ?? ['nationwide'],
    ntee_codes: params.ntee_codes ?? ['T'],
    min_grant_amount,
    max_pages,
    profileDriven: false,
  }
}

/**
 * Process a foundation_990 crawler job.
 *
 * @param {Object} context
 * @param {Object} context.db - Database connection
 * @param {Object} context.job - Crawler job row
 * @param {Object} [context.profileContext] - { profile, sections, signals } from the dispatcher snapshot
 * @param {Object} [context.params] - explicit overrides (states, ntee_codes, min_grant_amount, max_pages)
 * @param {Object} [context.deps] - test seam: { searchOrganizations, orgToFundingOpportunity, bulkUpsert, computeMatchDecision, filterOutPipelineMembers }
 * @returns {Object} Result summary
 */
export async function processFoundation990Job(context) {
  const { db, job, profileContext = null } = context
  const params = context.params ?? (job?.parameters && typeof job.parameters === 'object' ? job.parameters : {}) ?? {}

  // Test seam: allow injecting the ProPublica client + matcher so tests run
  // without network access. Defaults to the real implementations.
  const deps = context.deps ?? {}
  const _search = deps.searchOrganizations ?? searchOrganizations
  const _toOpp = deps.orgToFundingOpportunity ?? orgToFundingOpportunity
  const _bulkUpsert = deps.bulkUpsertFundingOpportunities ?? bulkUpsertFundingOpportunities
  const _match = deps.computeMatchDecision ?? computeMatchDecision
  const _filterPipeline = deps.filterOutPipelineMembers ?? filterOutPipelineMembers

  const signals = profileContext?.signals ?? null
  const profile = profileContext?.profile ?? null
  const sections = profileContext?.sections ?? null
  const profileId = profile?.id ?? job?.profile_id ?? null

  const { states, ntee_codes, min_grant_amount, max_pages, profileDriven } = resolveJobParams(params, signals)

  log.info(
    `[foundation990] Starting ${profileDriven ? 'PROFILE-DRIVEN' : 'ADMIN-BATCH'} ingestion: ` +
    `states=${states.join(',')}, ntee=${ntee_codes.join(',')}, min_grant=$${min_grant_amount}`,
  )

  let totalOrgs = 0
  let qualifiedOrgs = 0
  let matchedOrgs = 0
  let excludedCount = 0
  let insertedCount = 0
  const errors = []
  const candidateOpps = []

  for (const state of states) {
    for (const ntee of ntee_codes) {
      const stateLabel = state === 'nationwide' ? 'all states' : state
      const nteeLabel = NTEE_DESCRIPTIONS[ntee] ?? ntee
      log.info(`[foundation990] Searching: ${stateLabel} / ${nteeLabel} (NTEE ${ntee})`)

      for (let page = 0; page < max_pages; page++) {
        try {
          await sleep(RATE_LIMIT_MS)

          const searchParams = {
            q: '*',
            page,
            ...(state !== 'nationwide' ? { state } : {}),
            ntee,
            c_code: '3', // 501(c)(3) orgs only
          }

          const result = await _search(searchParams)
          const orgs = result.organizations ?? []

          if (orgs.length === 0) {
            log.info(`[foundation990] No more results for ${stateLabel}/${ntee} at page ${page}`)
            break
          }

          totalOrgs += orgs.length

          const qualified = orgs.filter((org) => {
            const grantAmt = org.grant_amount ?? org.income_amount ?? 0
            return grantAmt >= min_grant_amount
          })
          qualifiedOrgs += qualified.length

          for (const org of qualified) {
            const opp = _toOpp(org)
            candidateOpps.push(opp)
          }

          if (result.total_results && (page + 1) * 25 >= result.total_results) break
        } catch (err) {
          // Log + continue (G1: no silent swallow). Do not abort the whole job
          // for one bad page/combo.
          log.warn(`[foundation990] Error on ${state}/${ntee} page ${page}: ${err.message}`)
          errors.push({ state, ntee, page, error: err.message })
        }
      }
    }
  }

  // PROFILE-DRIVEN: score every candidate against the canonical matcher, drop
  // anything the profile has already saved/dismissed, and surface only matches
  // at/above the floor. ADMIN-BATCH: keep historical behavior (insert all
  // qualified foundations as directory rows for the nationwide catalog).
  let toInsert = candidateOpps

  if (profileDriven && profileId) {
    const matchProfile = profile ? { profile, sections, signals } : { profile, signals }
    const scored = []
    for (const opp of candidateOpps) {
      try {
        const decision = _match(matchProfile, opp, { profileSections: sections, signals })
        if (decision.decision === 'REJECT') continue
        if ((decision.score ?? 0) < PROFILE_MATCH_FLOOR) continue
        matchedOrgs++
        scored.push({
          ...opp,
          match_score: decision.score,
          match_decision: decision.decision,
          match_explanation: decision.explanation ?? null,
          match_reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
        })
      } catch (err) {
        log.warn(`[foundation990] Match scoring failed for "${opp.title}": ${err.message}`)
        errors.push({ stage: 'match', title: opp.title, error: err.message })
      }
    }

    try {
      const { results, excluded } = await _filterPipeline(db, profileId, scored)
      excludedCount = excluded
      toInsert = results
    } catch (err) {
      log.warn(`[foundation990] Pipeline-exclusion filter failed: ${err.message}; inserting unfiltered matches`)
      errors.push({ stage: 'pipeline_exclusion', error: err.message })
      toInsert = scored
    }
  }

  if (toInsert.length > 0) {
    try {
      const upsertResult = await _bulkUpsert(db, toInsert)
      insertedCount = upsertResult.inserted?.length ?? upsertResult.length ?? 0
    } catch (err) {
      log.error(`[foundation990] Bulk upsert failed: ${err.message}`)
      errors.push({ stage: 'upsert', error: err.message })
    }
  }

  log.info(
    `[foundation990] Complete: ${totalOrgs} scanned, ${qualifiedOrgs} qualified (>=$${min_grant_amount}), ` +
    `${profileDriven ? `${matchedOrgs} matched, ${excludedCount} excluded, ` : ''}${insertedCount} upserted`,
  )

  return {
    success: true,
    result_count: insertedCount,
    result_meta: {
      mode: profileDriven ? 'profile_driven' : 'admin_batch',
      total_orgs_scanned: totalOrgs,
      qualified_orgs: qualifiedOrgs,
      matched_orgs: profileDriven ? matchedOrgs : undefined,
      excluded_in_pipeline: profileDriven ? excludedCount : undefined,
      inserted: insertedCount,
      states_processed: states.length,
      ntee_codes_processed: ntee_codes.length,
      derived_states: profileDriven ? states : undefined,
      derived_ntee_codes: profileDriven ? ntee_codes : undefined,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    },
  }
}
