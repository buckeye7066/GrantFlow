/**
 * nonEvidentiaryKeywords — terms that are NOT evidence that a funder fits.
 *
 * WHY THIS EXISTS (purpose audit 2026-08-21, measured, local corpus).
 * The College/University profile's top surfaced result was "Commercial Fishing
 * Occupational Safety Training Project Grants (T03)" — ACCEPT, score 59. The
 * stored `match_explain_json` names the evidence that carried it: nine credited
 * `keyword` data points, of which six were
 *
 *     and · era · grant · grants · funding · eligible
 *
 * "and" is a conjunction. "grant", "grants", "funding" and "eligible" appear in
 * essentially every funding announcement ever written, so matching them proves
 * only that the document is a funding announcement. "era" is a fragment of the
 * SPONSOR's own name ("Centers for Disease Control and Prevention - ERA").
 *
 * The arithmetic turns that noise into free score rather than a wash: `keyword`
 * points are excluded from the coverage DENOMINATOR but credited to the
 * NUMERATOR (see profileDataPoints.js DENOMINATOR_EXCLUDE_KINDS /
 * NUMERATOR_EXCLUDE_KINDS), so a junk keyword can only ever raise a score. The
 * same profile carried 37 keyword points against a coverage denominator of 8.
 *
 * THE VOCABULARY ALREADY EXISTED. `DOC_STOPWORDS` was written in profileHelpers
 * for exactly this reason — "ordinary English + grant/admin boilerplate that
 * would otherwise dominate frequency counts and add nothing discriminating" —
 * but it only ever guarded uploaded-DOCUMENT mining. It never guarded the
 * data-point inventory that scores every match. This module is that same
 * vocabulary, promoted to config so both consumers read ONE list, plus the two
 * classes the document miner never had to think about:
 *
 *   - FORM NOISE: the literal value of an unanswered field ("none", "n/a",
 *     "unknown"). `comprehensiveApplicationSchema` defaults
 *     `medicaid_waiver_program: 'none'`, so without this a profile earns credit
 *     whenever a funder's page happens to contain the word "none".
 *   - REGISTRATION FRAGMENTS: tokens exploded out of administrative booleans
 *     (`sam_gov_registered`, `grants_gov_account`, `era_commons_account`,
 *     `federal_eligible`) — "sam", "gov", "era", "commons", "account",
 *     "registered", "federal". These describe the applicant's paperwork status,
 *     never what it needs money for, and being 3-4 characters they collide
 *     freely inside sponsor names.
 *
 * NOT A LENGTH RULE. Raising the minimum keyword length to 4 would have killed
 * "and"/"era"/"sam"/"gov" — and also "ems", "cte", "ssi", "cdl", "hiv", which
 * are real, discriminating profile vocabulary. Membership is enumerable and
 * inspectable on purpose; a regex would have taken the acronyms with it.
 *
 * TIGHTENING ONLY. Because keyword credit is numerator-only, withholding it can
 * lower a match score and can never raise one. Nothing here weakens a gate: it
 * applies a gate that was written and then never wired up.
 *
 * SCOPE. This is for the `keyword` data-point kind and document mining ONLY.
 * It must never filter a declared `need`, `interest`, `organization` or
 * `assistance` value — those are facts the applicant deliberately asserted, and
 * a person who declares "programs" as a need means it.
 */

/**
 * Ordinary English + grant/admin boilerplate. Historically `DOC_STOPWORDS` in
 * profileHelpers.js; moved here verbatim so the miner and the scorer cannot
 * drift apart.
 */
const ENGLISH_AND_GRANT_BOILERPLATE = [
  'the', 'and', 'for', 'that', 'this', 'with', 'will', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'you', 'your', 'our', 'their', 'they',
  'them', 'his', 'her', 'she', 'him', 'who', 'whom', 'which', 'what', 'when',
  'where', 'how', 'why', 'all', 'any', 'can', 'may', 'must', 'shall', 'should',
  'would', 'could', 'from', 'into', 'over', 'under', 'about', 'above', 'below',
  'than', 'then', 'them', 'these', 'those', 'such', 'each', 'every', 'some',
  'more', 'most', 'other', 'also', 'been', 'being', 'because', 'while', 'during',
  'between', 'within', 'through', 'after', 'before', 'once', 'only', 'very',
  'here', 'there', 'both', 'few', 'many', 'much', 'own', 'same', 'does', 'did',
  'doing', 'done', 'one', 'two', 'three', 'first', 'second', 'page', 'date',
  'name', 'please', 'thank', 'thanks', 'sincerely', 'dear', 'regards',
  'application', 'applicant', 'apply', 'program', 'programs', 'grant', 'grants',
  'funding', 'fund', 'project', 'organization', 'org', 'services', 'service',
  'information', 'provide', 'provided', 'include', 'including', 'support',
  'request', 'requirements', 'eligible', 'eligibility', 'available', 'number',
  'address', 'email', 'phone', 'street', 'city', 'state', 'county', 'zip',
  'across', 'around', 'toward', 'towards', 'upon', 'among', 'amongst', 'per',
  'via', 'onto', 'out', 'down', 'again', 'further', 'against', 'throughout',
  'regarding', 'concerning', 'serve', 'serves', 'serving', 'served', 'focus',
  'focuses', 'focused', 'help', 'helps', 'helping', 'need', 'needs', 'make',
  'makes', 'made', 'get', 'gets', 'got', 'use', 'uses', 'used', 'using',
  'work', 'works', 'working', 'includes', 'provides', 'providing',
]

/** The literal value of an unanswered field. Never a topic. */
const FORM_NOISE = [
  'none', 'n/a', 'n.a.', 'na', 'nil', 'null', 'undefined', 'unknown',
  'not applicable', 'not specified', 'no answer', 'tbd', 'to be determined',
  'yes', 'no',
]

/**
 * Tokens exploded out of administrative registration booleans. They describe
 * paperwork status, never a funding need, and they collide inside sponsor names.
 */
const REGISTRATION_FRAGMENTS = [
  'sam', 'gov', 'era', 'commons', 'account', 'registered', 'registration',
  'federal', 'government', 'agency', 'portal', 'website', 'profile',
]

/** Frozen, inspectable membership. Order-independent; lookups are exact. */
export const NON_EVIDENTIARY_KEYWORDS = new Set([
  ...ENGLISH_AND_GRANT_BOILERPLATE,
  ...FORM_NOISE,
  ...REGISTRATION_FRAGMENTS,
])

/**
 * Does this term carry any evidence that a funder fits this applicant?
 *
 * A bare number carries none — "000", "100" and "$5,000" are fragments of a
 * dollar figure, and the amount question is already scored by its own component.
 *
 * @param {unknown} term
 * @returns {boolean} true when the term may earn data-point credit
 */
export function isEvidentiaryKeyword(term) {
  const t = String(term ?? '').toLowerCase().trim()
  if (!t) return false
  if (!/[a-z]/.test(t)) return false
  return !NON_EVIDENTIARY_KEYWORDS.has(t)
}
