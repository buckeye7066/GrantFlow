/**
 * relevanceFilter.js
 *
 * Post-scoring hard disqualification filter.
 * Removes opportunities that cannot possibly be relevant to a profile,
 * regardless of keyword overlap or computed score.
 *
 * Rules are intentionally conservative: when profile data is missing or
 * ambiguous the filter PASSES (returns { pass: true }) so we never
 * accidentally suppress a genuine match.
 *
 * Rule definitions live in relevanceFilterRules.js — add new rules there.
 */

import { RELEVANCE_RULES } from './relevanceFilterRules.js'
import { buildFlatProfileData, buildCanonicalProfileView } from './canonicalProfileView.js'
import { normalizeProfile } from './profileNormalizer.js'

// State name → 2-letter abbreviation (uppercase) sorted by name length descending so
// multi-word state names ("west virginia") match before single-word names ("virginia").
const STATE_NAME_TO_ABBR_ENTRIES = [
  ['west virginia', 'WV'], ['north carolina', 'NC'], ['north dakota', 'ND'],
  ['south carolina', 'SC'], ['south dakota', 'SD'], ['new hampshire', 'NH'],
  ['rhode island', 'RI'], ['new mexico', 'NM'], ['new jersey', 'NJ'],
  ['new york', 'NY'], ['connecticut', 'CT'], ['massachusetts', 'MA'],
  ['mississippi', 'MS'], ['pennsylvania', 'PA'], ['minnesota', 'MN'],
  ['tennessee', 'TN'], ['california', 'CA'], ['louisiana', 'LA'],
  ['wisconsin', 'WI'], ['kentucky', 'KY'], ['oklahoma', 'OK'],
  ['nebraska', 'NE'], ['arkansas', 'AR'], ['colorado', 'CO'],
  ['maryland', 'MD'], ['michigan', 'MI'], ['missouri', 'MO'],
  ['delaware', 'DE'], ['illinois', 'IL'],
  ['virginia', 'VA'], ['montana', 'MT'], ['wyoming', 'WY'],
  ['georgia', 'GA'], ['arizona', 'AZ'], ['indiana', 'IN'],
  ['florida', 'FL'], ['alabama', 'AL'], ['vermont', 'VT'],
  ['kansas', 'KS'], ['nevada', 'NV'], ['oregon', 'OR'],
  ['alaska', 'AK'], ['hawaii', 'HI'], ['idaho', 'ID'],
  ['maine', 'ME'], ['texas', 'TX'], ['utah', 'UT'],
  ['iowa', 'IA'], ['ohio', 'OH'],
] // entries are already ordered longest-first; no runtime sort needed

/**
 * Detect a US state name embedded in an opportunity title.
 * "Ohio Family and Children First" → "OH"
 * "New York Tuition Assistance Program" → "NY"
 *
 * Returns the 2-letter uppercase state abbreviation or null.
 */
export function extractStateNameFromTitle(title) {
  const lower = (title || '').toLowerCase()
  for (const [name, abbr] of STATE_NAME_TO_ABBR_ENTRIES) {
    if (lower.includes(name)) return abbr
  }
  return null
}

/**
 * Build the combined text string used for pattern matching.
 * @param {object} opportunity
 * @returns {string}
 */
function buildOppText(opportunity) {
  return [
    opportunity.title || '',
    opportunity.description || '',
    opportunity.sponsor || '',
    ...(Array.isArray(opportunity.keywords) ? opportunity.keywords : []),
    ...(Array.isArray(opportunity.categories) ? opportunity.categories : []),
    ...(Array.isArray(opportunity.eligibility_bullets) ? opportunity.eligibility_bullets : []),
  ]
    .join(' ')
    .toLowerCase()
}

/**
 * Apply hard disqualification rules to a single opportunity.
 * Rules are defined in relevanceFilterRules.js — add new rules there.
 *
 * Per project rules ("Population / eligibility mismatches must reduce score,
 * not discard results" and "Hard boolean filters must be avoided unless the
 * funding source is explicitly exclusive"):
 *   - Rules flagged `hard: true` still return { pass: false } and REJECT.
 *   - Soft rules (default) return { pass: true, softFail: true, penalty }
 *     so callers can reduce the score instead of discarding the opportunity.
 *   - Directory / general funding resources ALWAYS pass (they must survive
 *     filtering unless explicitly excluded).
 *
 * The optional `opts.mode` lets legacy callers keep strict behavior:
 *   - 'strict' (default): soft rules still fail (backward-compatible)
 *   - 'soft': only truly exclusive (hard:true) rules fail
 *
 * @param {object} opportunity  - Opportunity row
 * @param {object} profileData  - Extracted profile fields
 * @param {object} [opts]
 * @param {'strict'|'soft'} [opts.mode='strict']
 * @returns {{ pass: boolean, reason?: string, ruleId?: string, softFail?: boolean, penalty?: number }}
 */
export function applyRelevanceFilter(opportunity, profileData, opts = {}) {
  if (!opportunity || !profileData) return { pass: true }

  const mode = opts.mode || 'strict'
  const oppText = buildOppText(opportunity)

  // Directory-style / general funding resources always survive — the project
  // explicitly requires this. Callers can still apply URL validation.
  const isDirectoryResource = Boolean(
    opportunity.is_directory_resource ||
    String(opportunity.source || '').startsWith('directory') ||
    String(opportunity.source || '').includes('local_directory') ||
    String(opportunity.record_origin || '').startsWith('directory') ||
    String(opportunity.type || '').toUpperCase() === 'DIRECTORY',
  )
  if (isDirectoryResource) return { pass: true, directory: true }

  for (const rule of RELEVANCE_RULES) {
    const patternMatches = (rule.oppPattern === null || rule.oppPattern === undefined) || rule.oppPattern.test(oppText)
    if (!(patternMatches && rule.profileCheck(profileData, oppText, opportunity))) continue

    const reason =
      typeof rule.reason === 'function' ? rule.reason(profileData, opportunity) : rule.reason

    // Rules explicitly marked hard:true, or legacy strict mode, reject
    if (rule.hard === true || mode === 'strict') {
      return { pass: false, reason, ruleId: rule.id }
    }

    // Soft mode: allow through but signal a penalty so the caller can
    // adjust the match score rather than discarding the opportunity.
    return { pass: true, softFail: true, reason, ruleId: rule.id, penalty: rule.penalty ?? 25 }
  }

  return { pass: true }
}

/**
 * Extract a flat profileData object from a profileContext for use by the
 * rule-driven relevance filter.
 *
 * NOTE: This used to build its own narrow shape. It now delegates to the
 * canonical profile view so the filter sees the same fields (needs,
 * description, situation, challenges, special_circumstances, ethnicity,
 * affiliations, geographic qualifiers, derived age/ageGroup, etc.) that
 * the matcher sees. Before this change several rules that checked
 * pd.needs / pd.description / pd.situation / pd.challenges never fired
 * because the extractor did not populate them.
 *
 * Accepts either a full profileContext ({ profile, sections, signals }) or a
 * pre-flattened profileData object (old call sites). Passing a flat object
 * through re-derives the canonical-derived fields it was missing.
 */
export function extractProfileData(profileContext) {
  if (!profileContext) return {}

  // Already a flat profile-data object (has no "sections" key and no "profile"
  // key but has things like primary_type/state): hydrate missing canonical
  // fields without losing any caller-provided overrides.
  if (
    typeof profileContext === 'object' &&
    !profileContext.profile &&
    !profileContext.sections &&
    (profileContext.primary_type !== undefined ||
      profileContext.state !== undefined ||
      profileContext.veteran_status !== undefined)
  ) {
    const normalized = normalizeProfile(profileContext, {}, null)
    const hydrated = buildFlatProfileData({ profile: profileContext, sections: {} }, normalized)
    return { ...hydrated, ...profileContext }
  }

  const view = buildCanonicalProfileView(profileContext)
  return view.flat
}
