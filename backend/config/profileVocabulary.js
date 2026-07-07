/**
 * profileVocabulary — canonical controlled vocabularies for profile TAG fields.
 *
 * OWNER DIRECTIVE (2026-07-07 profile schema redesign): every profile field is
 * either a structured, matcher-consumed data point (enum/tags/boolean/number) or
 * explicitly `scored:false` drafting-only prose. Free-text needs/interests that
 * used to flood the keyword miner are replaced by controlled TAG pickers whose
 * options are SOURCED FROM THE MATCHER'S OWN VOCABULARY — so every value a user
 * can pick is guaranteed to normalize to a bucket the match engine scores.
 *
 * Two vocabularies are exposed:
 *  - `needs` — the canonical NEED buckets the matcher scores. Derived from the
 *    deduped range of `NEED_ALIAS_MAP` (services/profileNormalizer.js), i.e. the
 *    exact set of buckets `normalizeNeedCategory()` collapses any need alias to.
 *    Used by financial_information.funding_needs.
 *  - `focus` — the broader browse-by-category taxonomy (needs + population + org
 *    + specialized). Derived from `CANONICAL_NEED_CATEGORIES`
 *    (constants/needCategories.js), the same list the "browse by category" UI
 *    and the matching endpoint already accept as queries. Used by
 *    programs_services.focus_areas and programs_services.interests.
 *
 * Because both lists are DERIVED (not hand-maintained), a new matcher bucket
 * automatically becomes pickable, and a tag can never drift out of the matcher's
 * vocabulary. `profileVocabulary.test.js` asserts every value normalizes.
 */
import { NEED_ALIAS_MAP, normalizeNeedCategory } from '../services/profileNormalizer.js'
import { CANONICAL_NEED_CATEGORIES } from '../constants/needCategories.js'

function titleize(id) {
  return String(id)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

const CATEGORY_LABEL_BY_ID = new Map(CANONICAL_NEED_CATEGORIES.map((c) => [c.id, c.label]))

/**
 * `needs` vocabulary: the matcher's own canonical need buckets.
 * The deduped range of NEED_ALIAS_MAP — every value the matcher recognizes as a
 * need. `value` is the token stored on the profile (canonical); `label` is a
 * human-readable display string.
 */
const NEED_BUCKET_IDS = Array.from(new Set(Object.values(NEED_ALIAS_MAP))).sort()

export const NEEDS_VOCABULARY = NEED_BUCKET_IDS.map((id) => ({
  value: id,
  label: CATEGORY_LABEL_BY_ID.get(id) || titleize(id),
}))

/**
 * `focus` vocabulary: the broader browse-by-category taxonomy for org focus
 * areas and interests (includes population/org/specialized categories that are
 * not strictly "needs" but are matchable browse categories).
 */
export const FOCUS_VOCABULARY = CANONICAL_NEED_CATEGORIES.map((c) => ({
  value: c.id,
  label: c.label,
  icon: c.icon,
  group: c.group,
}))

/**
 * The full set of named vocabularies exposed to the frontend tag pickers and the
 * GET /api/profiles/vocabulary endpoint. A tag field's `vocabulary:'<name>'`
 * must resolve here.
 */
export const PROFILE_VOCABULARIES = Object.freeze({
  needs: NEEDS_VOCABULARY,
  focus: FOCUS_VOCABULARY,
})

export const VOCABULARY_NAMES = Object.freeze(Object.keys(PROFILE_VOCABULARIES))

/** @returns {Array<{value:string,label:string}>|null} */
export function getProfileVocabulary(name) {
  return PROFILE_VOCABULARIES[name] ?? null
}

/** True if `name` names a real vocabulary a tag field may point at. */
export function isVocabularyName(name) {
  return Object.prototype.hasOwnProperty.call(PROFILE_VOCABULARIES, name)
}

/**
 * Map an arbitrary free-text value to its nearest canonical `needs` tag, or null
 * when no confident match exists. Used by the free-text→tags migration. Only
 * ever returns a value that IS in NEEDS_VOCABULARY (guaranteed matchable).
 */
export function mapFreeTextToNeedTag(raw) {
  if (!raw || typeof raw !== 'string') return null
  const canonical = normalizeNeedCategory(raw)
  if (canonical && NEED_BUCKET_IDS.includes(canonical)) return canonical
  return null
}

/**
 * Map an arbitrary free-text value to its nearest `focus` tag, or null. Tries the
 * category id directly, then the need normalization (need buckets that are also
 * category ids), so "housing" → 'housing'. Only returns a value present in
 * FOCUS_VOCABULARY.
 */
const FOCUS_IDS = new Set(FOCUS_VOCABULARY.map((c) => c.value))
export function mapFreeTextToFocusTag(raw) {
  if (!raw || typeof raw !== 'string') return null
  const key = raw.toLowerCase().trim().replace(/[\s-]+/g, '_')
  if (FOCUS_IDS.has(key)) return key
  const canonical = normalizeNeedCategory(raw)
  if (canonical && FOCUS_IDS.has(canonical)) return canonical
  return null
}

export default {
  PROFILE_VOCABULARIES,
  NEEDS_VOCABULARY,
  FOCUS_VOCABULARY,
  VOCABULARY_NAMES,
  getProfileVocabulary,
  isVocabularyName,
  mapFreeTextToNeedTag,
  mapFreeTextToFocusTag,
}
