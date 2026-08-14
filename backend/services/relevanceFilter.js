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
import { SOFT_RELEVANCE_PENALTY } from '../config/matchThresholds.js'

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
  // FIXED: 'washington' was missing from this list entirely (a real US state
  // omission, not a deliberate DC-ambiguity exclusion -- matchEngine.js's own
  // STATE_MAPPING and relevanceFilterRules.js's _STATE_ABBREVIATIONS both
  // already carry it without issue, and "washington, d.c." / "district of
  // columbia" is handled as its own separate DC concept elsewhere -- so a
  // title naming the state of Washington was silently unresolvable here).
  ['washington', 'WA'],
] // entries are already ordered longest-first; no runtime sort needed

// A state NAME used as the name of a COUNTY/CITY/PARISH is a place inside
// some OTHER state, not a claim about this one ("Delaware County, OH",
// "Washington County, PA", "Indiana County, PA", "Ohio County, WV",
// "Kansas City, MO" are all real places a bare substring test resolved to
// DE/WA/IN/OH/KS). Mirrors the fix already applied in relevanceFilterRules.js
// (_extractStateNameFromTitle) -- both files forked from the same original
// bare-substring implementation and carried the same bug.
const PLACE_QUALIFIER_AFTER_STATE_NAME =
  /^\s*(county|counties|parish|borough|municipio|city|township|village|town|district)\b/i

/**
 * Detect a US state name embedded in an opportunity title.
 * "Ohio Family and Children First" → "OH"
 * "New York Tuition Assistance Program" → "NY"
 * "Delaware County, OH Assistance Program" → "OH" (county-name guard; the
 * bare "delaware" substring is a PLACE inside Ohio, not a claim about DE).
 *
 * Returns the 2-letter uppercase state abbreviation or null.
 */
export function extractStateNameFromTitle(title) {
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

/**
 * Build the combined text string used for pattern matching.
 * @param {object} opportunity
 * @returns {string}
 */
// Coerce a field that may be an array OR a JSON-encoded string OR a plain string
// into an array of strings. DB rows frequently arrive with keywords/categories/
// eligibility_bullets as JSON TEXT, which the old code silently dropped — so
// eligibility/demographic rules never saw that text and ineligible opportunities
// slipped through. This makes every data point on the opportunity visible to the
// rules regardless of shape.
function asTextList(v) {
  if (!v) return []
  if (Array.isArray(v)) return v.map((x) => String(x ?? ''))
  if (typeof v === 'string') {
    const s = v.trim()
    if (s.startsWith('[')) {
      try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map((x) => String(x ?? '')) } catch { /* fall through */ }
    }
    return [s]
  }
  if (typeof v === 'object') { try { return [JSON.stringify(v)] } catch { return [] } }
  return [String(v)]
}

function buildOppText(opportunity) {
  return [
    opportunity.title || '',
    opportunity.description || opportunity.summary || '',
    opportunity.sponsor || opportunity.funder || opportunity.organization || '',
    // Eligibility / restriction prose — the single most important text for the
    // demographic + entity-type + geographic exclusivity rules.
    opportunity.eligibility_text || opportunity.eligibility || '',
    opportunity.restrictions || opportunity.amount_description || '',
    ...asTextList(opportunity.keywords),
    ...asTextList(opportunity.categories),
    ...asTextList(opportunity.eligibility_bullets),
    // Structured eligibility is part of the same source-of-truth evidence as
    // eligibility prose. Without it, JSON-only demographic restrictions can
    // bypass both the canonical soft penalty and explicit hard exclusivity.
    ...asTextList(opportunity.eligibility_json),
    ...asTextList(opportunity.tags),
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
 *   - Directory / general funding resources pass by default for legacy recall
 *     paths. Profile-specific display/pipeline gates can set
 *     opts.allowDirectories=false so directories do not bypass relevance.
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
  if (isDirectoryResource && opts.allowDirectories !== false) {
    return { pass: true, directory: true }
  }

  // A HARD rule (or strict mode) always wins, regardless of rule order — so we
  // must NOT return on the first soft match. Remember the first soft match but
  // keep scanning; if any rule later in the list is hard (or we're in strict
  // mode), it rejects. This is what lets a tight hard-exclusivity rule
  // (e.g. demographic_veteran_exclusive) override a broader soft rule
  // (demographic_veteran_focused) that happens to match the same text first.
  // Callers can suppress specific rule IDs (e.g. the NO-FIT content-shape family
  // for a row the matchEngine already scored above the surfacing floor). We keep
  // scanning the remaining rules so a real eligibility/demographic mismatch that
  // sits LATER in the list still rejects — suppression removes only the named
  // no-fit rules, never the hard-ineligibility ones underneath them.
  const skipRuleIds =
    opts.skipRuleIds instanceof Set
      ? opts.skipRuleIds
      : Array.isArray(opts.skipRuleIds)
        ? new Set(opts.skipRuleIds)
        : null

  let softMatch = null
  for (const rule of RELEVANCE_RULES) {
    if (skipRuleIds && skipRuleIds.has(rule.id)) continue
    const patternMatches = (rule.oppPattern === null || rule.oppPattern === undefined) || rule.oppPattern.test(oppText)
    if (!(patternMatches && rule.profileCheck(profileData, oppText, opportunity))) continue

    const reason =
      typeof rule.reason === 'function' ? rule.reason(profileData, opportunity) : rule.reason

    // Rules explicitly marked hard:true, or legacy strict mode, reject now.
    if (rule.hard === true || mode === 'strict') {
      return { pass: false, reason, ruleId: rule.id }
    }

    // Soft mode: remember the first soft penalty but keep looking for a hard rule.
    if (!softMatch) {
      softMatch = {
        pass: true,
        softFail: true,
        reason,
        ruleId: rule.id,
        penalty: Number.isFinite(Number(rule.penalty)) ? Number(rule.penalty) : SOFT_RELEVANCE_PENALTY,
      }
    }
  }
  if (softMatch) return softMatch

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
