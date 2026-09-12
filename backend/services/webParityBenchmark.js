/**
 * webParityBenchmark.js — the "Google bar" benchmark (owner directive: for each
 * GOLDEN profile, GrantFlow's results must beat what a plain web-search session
 * produces; failures become Amy's work queue; the system must only get better).
 *
 * WHAT IT MEASURES — for each golden profile (system_kv
 * `golden_outcome_expectations`, the same KV the coverage.goldenOutcomes Sam
 * check reads):
 *
 *   1. Derive the profile's funding thesis (needs + state + applicant types)
 *      through the SAME canonical machinery live discovery uses
 *      (buildThesisForProfile → buildWebQueries), then run a BOUNDED web-search
 *      session (≤ MAX_QUERIES_PER_PROFILE queries × ≤ MAX_RESULTS_PER_QUERY
 *      results — the budget an owner-quality Google session would spend).
 *   2. Compare what the web session surfaced against the profile's CURRENT top
 *      stored matches (profile_opportunity_matches JOIN funding_opportunities):
 *        overlap        — web results GrantFlow ALREADY has (canonical URL or
 *                         program-title identity; a shared domain alone is
 *                         never treated as the same opportunity)
 *        web_only       — REAL-looking funding pages the web found that
 *                         GrantFlow lacks (search-engine/placeholder/social/
 *                         aggregator-noise filtered out via the canonical
 *                         urlRules + the web lane's skip list)
 *        grantflow_only — stored top matches the web session did not surface
 *   3. Score:  parity = overlap / (overlap + web_only) × 100.
 *      A session with zero benchmark-eligible web results is UNSCORED. It is
 *      not evidence of 100% parity and is excluded from fleet parity.
 *
 * PERSISTENCE — system_kv `web_parity_benchmark`
 *   { generated_at, runs: [last MAX_RUN_HISTORY compact runs], latest:
 *     { generated_at, fleet_parity, per_profile } }
 * A complete search can still be too small to support a stable trend. Each
 * snapshot therefore carries a semantics version, verified denominator, and
 * `sample_qualified` bit. Consumers must not claim a regression unless the
 * current and comparison samples use the same semantics and both meet the
 * minimum denominator.
 * so Sam's `coverage.webParityBenchmark` check can ratchet REGRESSIONS ("the
 * system only gets better": red when fleet parity drops > REGRESSION_POINTS
 * vs the previous run, is stale > STALE_MS, or never ran).
 *
 * FEEDING FAILURES FORWARD — every web_only find is appended (deduped, capped)
 * to system_kv `web_parity_gap_queue` as an HONEST candidate
 * { url, title, profile_id, need, … } — the shape the url-rescue-style
 * machinery / Amy can later drive through the full upsertFundingOpportunity
 * gate stack. This module NEVER auto-inserts into the catalog: a benchmark
 * observation is provenance-labelled candidate evidence, not a vetted row.
 *
 * Scheduling: a bounded step in runNightlyMaintenanceSweep (env-gated).
 * Gate: WEB_PARITY_BENCHMARK (enabled by default; set =false to disable).
 * Search + thesis + golden loaders are INJECTED so tests run fully offline.
 */

import { searchWeb as defaultSearchWeb } from './shared/webSearchEngine.js'
import { buildWebQueries } from '../crawler-os/webQueries.js'
import { titleIdentityKey } from '../crawler-os/contract.js'
import { canonicalizeUrl, isTrackingParam } from '../crawler-os/urlCanonical.js'
import {
  isSearchEngineUrl,
  isPlaceholderUrl,
  isNonActionableUrl,
  extractHostname,
} from '../config/urlRules.js'
import { isPointerKind } from '../config/opportunityKindClasses.js'
import { detectForeignOpportunity } from '../config/opportunityJurisdiction.js'
import { buildMetricEnvelope } from './observability/metricEnvelope.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('services:webParityBenchmark')

/** system_kv key holding the benchmark history + latest snapshot. */
export const KV_KEY = 'web_parity_benchmark'

/** system_kv key holding the honest web-only candidate queue (Amy's work queue). */
export const GAP_QUEUE_KV_KEY = 'web_parity_gap_queue'

/** system_kv key holding the golden-profile expectations (shared with Sam's coverage.goldenOutcomes). */
export const GOLDEN_KV_KEY = 'golden_outcome_expectations'

/**
 * system_kv key: conditions an ADOPTED source now covers. Read by
 * coverageEvidenceService's overlay so a closed wishlist gap stops re-emitting.
 * Mirrors `CONDITION_COVERAGE_KV_KEY` there — kept as a literal to avoid an import
 * cycle (coverageEvidenceService already imports nothing from this module).
 */
export const CONDITION_COVERAGE_KV_KEY = 'condition_source_coverage'

/** Mandatory search budget per profile — an owner-quality web session, bounded. */
export const MAX_QUERIES_PER_PROFILE = 6
export const MAX_RESULTS_PER_QUERY = 10

/** History ring size (nightly cadence ⇒ ~a month of trend). */
export const MAX_RUN_HISTORY = 30

/** A benchmark older than this is STALE for Sam (nightly cadence + one grace day). */
export const STALE_MS = 48 * 60 * 60 * 1000

/**
 * Bump when eligibility, identity, or denominator semantics change. Historical
 * scores from a different version are not valid regression comparators.
 */
// v3 makes the fleet score a true cohort ratio (total overlap / total verified
// results) instead of giving a one-result profile the same weight as a
// hundred-result profile. It also reserves `fleet_parity` for a complete,
// denominator-qualified measurement; raw per-profile observations remain in
// `per_profile`/`scored_profiles_parity` when the sample is too small.
// v4 (2026-09-12) changes IDENTITY and ELIGIBILITY on both sides: one shared
// URL normalizer (tracking/locale/session params, default port, www, scheme,
// fragment, trailing slash — webparity-1), stored POINTER rows no longer count
// as GrantFlow "found funding" (webparity-2), identity is checked before the
// funding-signal text heuristic (webparity-9). A v3 run is not a valid
// regression comparator for a v4 run; Sam's trailing median restarts.
export const BENCHMARK_SEMANTICS_VERSION = 4

/**
 * Tiny SERP samples move by dozens of points when one result rotates. Require
 * enough verified eligible pages before treating fleet parity as a ratchet.
 */
export const MIN_VERIFIED_DENOMINATOR = 20

/** Fleet parity dropping more than this vs the PREVIOUS run is a regression (points on the 0–100 scale). */
export const REGRESSION_POINTS = 10

/** Top stored matches per profile compared against the web session. */
export const MAX_STORED_MATCHES = 50

/**
 * Cap on the candidate gap queue. Eviction is CLASS-AWARE, never a blind
 * positional slice (webparity-eviction, 2026-09-12): a row carrying a
 * TERMINAL gate verdict (adopted/gated_out/dismissed/not_evaluated:exhausted)
 * or a recorded DISPOSITION is evicted only after every plain pending row
 * (never offered, never dispositioned) is gone — see appendGapCandidates.
 */
export const GAP_QUEUE_CAP = 200

/**
 * Even when the cap must be enforced against an all-dispositioned pending
 * pool, at least this many of a profile's MOST RECENT dispositioned-pending
 * rows are never evicted — the disposition (webparity-3/4) is itself the
 * evidence a consumer reads to see WHY a page is still web-only, and losing
 * every one of them for a profile reproduces the same silent-data-loss shape
 * the terminal-row protection exists to prevent. This can push the queue
 * past GAP_QUEUE_CAP in the (rare) case many profiles are simultaneously at
 * their floor — the guarantee wins over the nominal cap rather than
 * silently deleting evidence below it.
 */
export const GAP_QUEUE_MIN_DISPOSITIONED_PER_PROFILE = 20

/**
 * Seeds handed to ONE discovery run. Each seed costs a fetch + an LLM
 * extraction, so this is bounded like every other lane budget; leftovers stay
 * 'candidate' and are offered to the next run rather than dropped.
 */
export const GAP_SEED_LIMIT_PER_RUN = 8

/**
 * A seed the gates could not EVALUATE (fetch failed, extraction returned
 * nothing because the LLM route was dead) is not a verdict. It stays eligible
 * for re-seeding, but bounded: after this many offers without a verdict it is
 * parked as `not_evaluated:exhausted` (visible, terminal for seeding) so a
 * permanently unreadable page is not re-fetched nightly forever.
 */
export const GAP_SEED_MAX_OFFERS = 3

/** A not-evaluated seed is re-offered only after this cooldown (the LLM route needs time to heal). */
export const NOT_EVALUATED_RESEED_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** Web-only finds carried per profile in `latest` (evidence + owner report). */
const WEB_ONLY_TOP_CAP = 20

/**
 * Bound on the per-result disposition ledger persisted per profile. The web
 * session is itself bounded to MAX_QUERIES_PER_PROFILE × MAX_RESULTS_PER_QUERY
 * results, so this covers EVERY web-only result of a full session.
 */
const WEB_ONLY_DISPOSITION_CAP = MAX_QUERIES_PER_PROFILE * MAX_RESULTS_PER_QUERY

/**
 * The closed vocabulary of per-web-only-result dispositions (issue 4, 2026-09-12).
 * Exactly ONE is persisted per web-only result and mirrored onto the gap-queue
 * candidate. Order here is documentary; precedence lives in disposeWebOnlyHit.
 *
 *   never_generated_capable_query      no planned lane query could have produced the hit
 *   generated_not_executed_cap         planned, but the lane skipped it (budget) or the hit sits
 *                                      at a rank / query position the lane structurally never reaches
 *   provider_failure                   the lane's own search for that query errored / was unavailable
 *   fetch_failed                       the lane tried the page and could not fetch it
 *   extraction_failed                  the page was fetched, extraction produced nothing
 *   canonical_duplicate                GrantFlow already holds the program under another URL
 *   correctly_rejected_at_gate:<gate>  a recorded gate verdict refused it (reality|eligibility|need|apply_target)
 *   incorrectly_lost_qualified_source  none of the above: the true recall gap (queued for seeding)
 *   lane_ledger_unavailable            the lane's per-run ledger is absent, so the miss cannot be attributed
 */
export const GATE_NAMES = Object.freeze(['reality', 'eligibility', 'need', 'apply_target'])
export const WEB_ONLY_DISPOSITIONS = Object.freeze([
  'never_generated_capable_query',
  'generated_not_executed_cap',
  'provider_failure',
  'fetch_failed',
  'extraction_failed',
  'canonical_duplicate',
  ...GATE_NAMES.map((gate) => `correctly_rejected_at_gate:${gate}`),
  'incorrectly_lost_qualified_source',
  'lane_ledger_unavailable',
])

/**
 * The discovery lane's breadth (crawler-os/webLane.js reads the same env names
 * with the same defaults). The benchmark needs them to say which SERP ranks /
 * query positions the lane can structurally never reach (webparity-6); a lane
 * ledger that records its own values overrides these.
 */
function envInt(raw, fallback) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}
export function webLaneDefaults(env = process.env) {
  return {
    maxQueries: envInt(env.WEB_LANE_MAX_QUERIES, 28),
    resultsPerQuery: envInt(env.WEB_LANE_RESULTS_PER_QUERY, 8),
    maxPages: envInt(env.WEB_LANE_MAX_PAGES, 44),
  }
}

/**
 * Paywalled grant directories / listicle farms: a hit on these is the SEARCH
 * SESSION's noise, not a real funder page GrantFlow "missed". The canonical
 * search-engine / social / placeholder rules live in config/urlRules.js and
 * shared/webSearchEngine.js (SKIP_SUBSTRINGS); this list only adds the
 * grant-aggregator class those generic rules cannot know about.
 */
export const AGGREGATOR_NOISE_DOMAINS = Object.freeze(new Set([
  'grantwatch.com',
  'instrumentl.com',
  'grantforward.com',
  'grantstation.com',
  'grantselect.com',
  'opengrants.io',
  'fundsforngos.org',
  'pivot.proquest.com',
  'causeiq.com',
  'wikipedia.org',
  // Consumer-health information sites: articles about conditions, never a
  // funding source. Their homepages kept surfacing as "web-only finds"
  // (2026-07-12: webmd.com counted as a miss against a TN disability profile).
  'webmd.com',
  'healthline.com',
  'medicalnewstoday.com',
  'verywellhealth.com',
  // SEO lead-generation content (law-firm "benefit pay chart" explainers).
  'sslg.com',
  'disabilityguidance.org',
  // Search/listing/referral pages are not direct award opportunities.
  'thegrantportal.com',
  'disability-grants.org',
  'themobilityresource.com',
]))

/**
 * Well-known state benefit portals that live on their own domains (so the
 * `*.{st}.gov` / `*.state.{st}.us` patterns can't attribute them to a state).
 */
export const STATE_PORTAL_DOMAINS = Object.freeze({
  'benefitscal.com': 'ca',
  'mybenefitscalwin.org': 'ca',
  'yourtexasbenefits.com': 'tx',
  'accesshra.nyc.gov': 'ny',
})

/** Two-letter .gov domains that are FEDERAL, not a state (va.gov = Veterans Affairs). */
const FEDERAL_TWO_LETTER_GOV = Object.freeze(new Set(['va.gov']))

/**
 * A hit that is clearly ANOTHER state's government/benefits portal is not a
 * recall miss for this profile — GrantFlow is RIGHT not to surface California
 * Medi-Cal for a Tennessee profile (2026-07-12: dhcs.ca.gov + benefitscal.com
 * counted against Gilbert/TN and cratered the parity score). Detects
 * `*.{st}.gov` and `*.state.{st}.us` domains plus STATE_PORTAL_DOMAINS.
 * Unknown/unattributable domains are NEVER filtered. Pure; exported for tests.
 */
export function isOutOfStateGovHit(url, profileState) {
  const st = String(profileState || '').trim().toLowerCase()
  if (!/^[a-z]{2}$/.test(st)) return false
  const domain = extractHostname(url)
  if (!domain) return false
  const govMatch = domain.match(/(?:^|\.)([a-z]{2})\.gov$/)
  if (govMatch && FEDERAL_TWO_LETTER_GOV.has(`${govMatch[1]}.gov`)) return false
  const stateUsMatch = domain.match(/(?:^|\.)state\.([a-z]{2})\.us$/)
  const domainState = govMatch?.[1] ?? stateUsMatch?.[1] ?? STATE_PORTAL_DOMAINS[domain] ?? null
  return Boolean(domainState && domainState !== st)
}

/** Text signal that a page is about money an applicant can get. */
const FUNDING_SIGNAL_RE =
  /\b(grants?|scholarships?|funding|funds?|assistance|awards?|stipends?|fellowships?|benefits?|relief|financial aid)\b/i

/**
 * Search results that mention money are not automatically funding opportunities
 * for THIS profile. The live 2026-07-29 benchmark counted a Czech government
 * board, a generic Grants.gov search page, an NPS grants index, and a foundation's
 * past-grantee list as recall misses for two Tennessee individuals. Those are
 * search-session noise, not evidence that GrantFlow omitted an actionable match.
 */
const HISTORICAL_OR_INDEX_PAGE_RE =
  /\b(our grantees|past grantees|grant recipients|awards made|funded projects|search grants|browse grants|grant search|grants database|grant database|grants overview|funding opportunities search)\b/i
const GENERIC_GRANTS_TITLE_RE = /^(?:search |browse |find )?(?:available )?grants?(?:\s*\([^)]*\))?$/i
const ACTIONABLE_PROGRAM_RE =
  /\b(apply|application|applications open|accepting applications|eligib(?:le|ility)|deadline|financial assistance|scholarship|stipend|voucher|benefit|relief program|assistance program)\b/i
const INDIVIDUAL_SIGNAL_RE =
  /\b(individuals?|famil(?:y|ies)|households?|patients?|students?|veterans?|caregivers?|people|persons?|children|adults?|seniors?|residents?|homeowners?|renters?|workers?|employees?|wheelchair|mobility|medical bills?|utility assistance|rent assistance|home repair|tuition)\b/i
const ORGANIZATION_SIGNAL_RE =
  /\b(nonprofits?|not[- ]for[- ]profits?|organizations?|businesses?|companies|schools?|districts?|municipalities|local governments?|public agencies|institutions?|tribal governments?|fire departments?|churches?|ministries)\b/i
const INDIVIDUAL_APPLICANT_TYPES = new Set([
  'individual', 'family', 'student', 'high_school_student', 'college_student',
  'graduate_student', 'medical_need', 'medical_assistance', 'individual_need',
  'senior', 'veteran', 'disabled_adult', 'homeschool_family',
])

const NEED_SEMANTIC_RULES = Object.freeze([
  { need: /\b(disabil|mobility|wheelchair|accessib|assistive|adaptive)\w*/i, hit: /\b(disabil|mobility|wheelchair|accessib|assistive|adaptive)\w*/i },
  { need: /\b(medical|health|cancer|disease|illness|patient|treatment|medication|hospital)\w*/i, hit: /\b(medical|health|cancer|disease|illness|patient|treatment|medication|hospital|clinical)\w*/i },
  { need: /\b(transport|vehicle|van|car)\w*/i, hit: /\b(transport|vehicle|van|car|mobility)\w*/i },
  { need: /\b(education|school|college|student|tuition|training|scholarship)\w*/i, hit: /\b(education|school|college|student|tuition|training|scholarship|academic)\w*/i },
  { need: /\b(housing|home|rent|mortgage|shelter|utility|repair)\w*/i, hit: /\b(housing|home|rent|mortgage|shelter|utility|repair|weatherization)\w*/i },
  { need: /\b(caregiver|respite|caregiving)\w*/i, hit: /\b(caregiver|respite|caregiving|family care)\w*/i },
  { need: /\b(food|nutrition|meal|pantry)\w*/i, hit: /\b(food|nutrition|meal|pantry|grocer)\w*/i },
  { need: /\b(veteran|military|service member)\w*/i, hit: /\b(veteran|military|service member|armed forces)\w*/i },
  { need: /\b(emergency|hardship|low income|financial|debt|relief|benefit)\w*/i, hit: /\b(emergency|hardship|low income|financial assistance|debt relief|benefit|cash assistance)\w*/i },
  { need: /\b(business|startup|entrepreneur|workforce|employment)\w*/i, hit: /\b(business|startup|entrepreneur|workforce|employment|job training)\w*/i },
  { need: /\b(nonprofit|community|ministry|church|program)\w*/i, hit: /\b(nonprofit|community|ministry|church|program)\w*/i },
])

const NEED_TOKEN_STOPWORDS = new Set([
  'assistance', 'funding', 'grant', 'grants', 'help', 'need', 'needs', 'program',
  'programs', 'service', 'services', 'support', 'individual', 'general',
])

function normalizedHitText(hit) {
  return [hit?.title ?? '', hit?.snippet ?? '', hit?.url ?? '']
    .join(' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Foreign public-sector pages are outside a US-profile benchmark. */
export function isForeignGovernmentHit(url) {
  const domain = extractHostname(url)
  if (!domain || domain.endsWith('.gov') || domain.endsWith('.mil')) return false
  return /(?:^|\.)(?:gov|gob|gouv|go)\.[a-z]{2,3}$/i.test(domain)
}

function needMatchesHit(hit, needs = []) {
  const text = normalizedHitText(hit)
  const normalizedNeeds = (Array.isArray(needs) ? needs : [])
    .map((need) => String(need || '').replace(/[_-]+/g, ' ').trim())
    .filter(Boolean)
  if (normalizedNeeds.length === 0) return true

  // TOKEN BOUNDARY, NOT SUBSTRING, for the whole-phrase branch below. It was a
  // bare `.includes(need)`, which is the 'ssi'-inside-'assistance' shape: the
  // canonical need `legal` matched "illegal", `food` matched "seafood". Its own
  // sibling two lines down already matches tokens with `\b…\b`, so the loose
  // branch contradicted the rule beside it. Punctuation is folded to spaces on
  // BOTH sides first (the haystack carries snippet punctuation and a raw URL),
  // so "…food-assistance/" and "food." still state the need `food`.
  const phraseHaystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `
  for (const need of normalizedNeeds) {
    const phrase = need.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (phrase.length >= 3 && phraseHaystack.includes(` ${phrase} `)) return true
    if (NEED_SEMANTIC_RULES.some((rule) => rule.need.test(need) && rule.hit.test(text))) return true
    const tokens = need
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !NEED_TOKEN_STOPWORDS.has(token))
    if (tokens.some((token) => new RegExp('\\b' + token + '\\b', 'i').test(text))) return true
  }
  return false
}

function applicantMatchesHit(hit, applicantTypes = []) {
  const types = (Array.isArray(applicantTypes) ? applicantTypes : [])
    .map((type) => String(type || '').trim().toLowerCase())
    .filter(Boolean)
  if (types.length === 0) return true

  const text = normalizedHitText(hit)
  const hasIndividual = types.some((type) => INDIVIDUAL_APPLICANT_TYPES.has(type))
  const hasOrganization = types.some((type) => !INDIVIDUAL_APPLICANT_TYPES.has(type))
  if (hasIndividual && hasOrganization) return true

  if (hasIndividual) {
    if (INDIVIDUAL_SIGNAL_RE.test(text)) return true
    if (ORGANIZATION_SIGNAL_RE.test(text)) return false
    return ACTIONABLE_PROGRAM_RE.test(text)
  }

  if (ORGANIZATION_SIGNAL_RE.test(text)) return true
  const typeText = types.join(' ').replace(/_/g, ' ')
  return typeText.split(/\s+/).some((token) => token.length >= 4 && text.toLowerCase().includes(token))
}

/**
 * True only when a non-overlapping web hit is a plausible actionable funding
 * source for the benchmarked profile. Identity-confirmed overlaps are allowed by
 * classifyWebResults before this gate, so sparse snippets never erase proof that
 * GrantFlow already covers a page.
 */
export function isBenchmarkRelevantHit(hit, { needs = [], applicantTypes = [] } = {}) {
  if (!isRealFundingHit(hit)) return false
  if (isForeignGovernmentHit(hit?.url)) return false
  // A registered FOREIGN FUNDER is junk on BOTH sides of the parity ledger.
  // `isForeignGovernmentHit` sees only gov-style ccTLD shapes, so Tata Trusts
  // on .org sailed through ("the ccTLD rule is structurally blind to a foreign
  // funder on .org/.com" — the exact class the 2026-08-03 QA chain registered
  // in FOREIGN_FUNDER_HOSTS/NAMES and purged from the MATCH store). The purge
  // then flipped those rows from "overlap" to "web-only find" here, and the
  // 2026-08-04 run scored the cleanup as a −24.9 parity REGRESSION with
  // tatatrusts.org sitting in web_only_top for BOTH golden profiles. Measure
  // the web side with the SAME canonical detector the product side uses, so a
  // foreign funder can never read as a GrantFlow recall miss.
  if (detectForeignOpportunity({ title: hit?.title, url: hit?.url }).foreign) return false

  const title = String(hit?.title || '').trim()
  const text = normalizedHitText(hit)
  if (HISTORICAL_OR_INDEX_PAGE_RE.test(text)) return false
  if (GENERIC_GRANTS_TITLE_RE.test(title) && !ACTIONABLE_PROGRAM_RE.test(text)) return false
  if (!needMatchesHit(hit, needs)) return false
  return applicantMatchesHit(hit, applicantTypes)
}

const GENERIC_PORTAL_TITLE_RE =
  /^(?:home|search grants|browse grants|find grants|grant search|funding opportunities)(?:\s*[|–—-]\s*grants?\.gov)?$/i
const GENERIC_HOMEPAGE_TITLE_RE = /(?:^|\s[|–—-]\s)home(?:\s[|–—-]\s|$)/i
const GENERIC_GRANTS_GOV_PATH_RE =
  /^\/(?:$|search-grants\/?$|learn-grants(?:\/.*)?$|applicants(?:\/.*)?$|grantors(?:\/.*)?$|support(?:\/.*)?$)/i

/** A portal can contain real opportunities without itself being one. */
export function isGenericFundingPortalHit(hit) {
  const url = String(hit?.url || '').trim()
  const domain = extractHostname(url)
  const title = String(hit?.title || '').trim()
  if (GENERIC_PORTAL_TITLE_RE.test(title)) return true
  // A generic organization homepage is not itself an assistance program. This
  // exact class ("HOME | SPCA Bradley County") was counted as a funding recall
  // miss in the 2026-08-25 owner report even though the result named no grant,
  // application, eligibility, or benefit. Keep an explicit actionable snippet
  // eligible; reject only the evidence-free root homepage.
  try {
    const parsed = new URL(url)
    if ((parsed.pathname === '/' || parsed.pathname === '') &&
        GENERIC_HOMEPAGE_TITLE_RE.test(title) &&
        !ACTIONABLE_PROGRAM_RE.test(normalizedHitText(hit))) return true
  } catch {
    return true
  }
  if (domain !== 'grants.gov') return false
  try {
    return GENERIC_GRANTS_GOV_PATH_RE.test(new URL(url).pathname || '/')
  } catch {
    return true
  }
}

/** Final direct-source gate for a purported web-only recall miss. */
export function isBenchmarkDirectFundingHit(hit, context = {}) {
  return isBenchmarkRelevantHit(hit, context) && !isGenericFundingPortalHit(hit)
}

export function isWebParityBenchmarkEnabled() {
  return String(process.env.WEB_PARITY_BENCHMARK ?? 'true').toLowerCase() !== 'false'
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — identity + filters + parity math
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query params that never distinguish two real pages: locale selectors and
 * server session ids. The tracking families (utm_*, gclid, fbclid, mc_*, …)
 * come from the SHARED `isTrackingParam` in crawler-os/urlCanonical.js — the
 * same allowlist-to-strip the discovery lane uses for its own SERP dedupe, so
 * the benchmark's web side and the lane agree on which SERP URLs are one page.
 * Everything else is PRESERVED: `?id=A` vs `?id=B` are two programs, and
 * collapsing them would manufacture overlap (a parity gain the owner rules
 * forbid). That is also why the catalog's `normalizeUrlForId` (which drops
 * the WHOLE query) is deliberately not used verbatim here: it is the right
 * last-resort tier for a title-less catalog row, but too coarse to compare a
 * SERP hit against a stored URL without inventing coverage.
 */
const IDENTITY_FREE_PARAMS = new Set([
  'ref', 'referrer', 'referer',
  'lang', 'locale', 'hl', 'language',
  'sessionid', 'session_id', 'phpsessid', 'jsessionid', 'sid', 'cfid', 'cftoken',
])
const IDENTITY_FREE_PREFIXES = ['mc_']

function isIdentityFreeParam(name) {
  const n = String(name || '').toLowerCase()
  if (!n) return true
  if (isTrackingParam(n) || IDENTITY_FREE_PARAMS.has(n)) return true
  return IDENTITY_FREE_PREFIXES.some((prefix) => n.startsWith(prefix))
}

/**
 * THE URL identity used on BOTH sides of the benchmark (stored rows, SERP hits,
 * run-level dedupe, gap-queue keys, outcome matching, the replay script):
 * scheme, `www.`, default port, fragment, trailing slash, tracking params
 * (shared allowlist), locale/session params dropped; host lowercased;
 * remaining identity-bearing params kept in sorted order. Built on the shared
 * `canonicalizeUrl` so it can never drift from the lane's own dedupe.
 */
export function normalizeUrlKey(url) {
  const raw = String(url || '').trim()
  if (!/^https?:\/\//i.test(raw)) return ''
  const canon = canonicalizeUrl(raw)
  if (!canon) return ''
  let parsed
  try {
    parsed = new URL(canon)
  } catch {
    return ''
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  // `URL.port` is '' for the scheme's default port already; a non-default port is identity.
  const port = parsed.port ? `:${parsed.port}` : ''
  const path = parsed.pathname.replace(/\/+$/, '').toLowerCase()
  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => !isIdentityFreeParam(name))
    .map(([name, value]) => [name.toLowerCase(), String(value).toLowerCase()])
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
  const query = params.length ? `?${params.map(([name, value]) => `${name}=${value}`).join('&')}` : ''
  const key = `${host}${port}${path}${query}`
  // SSA publishes the same SSDI/SSI program under a program landing page and
  // an application landing page. Search favors `/applyfordisability`; the
  // canonical source registry uses `/disability`. Treating them as unrelated
  // made a program GrantFlow already carried appear web-only every night.
  if (/^ssa\.gov\/(?:disability|applyfordisability|benefits\/disability)(?:\/.*)?$/i.test(key)) {
    return 'ssa.gov/disability'
  }
  return key
}

/**
 * "Real-looking funding page" filter for a web hit ({url,title,snippet}):
 *   - http(s), NOT a search-engine results page (canonical isSearchEngineUrl),
 *   - NOT a placeholder / social / non-actionable URL (canonical urlRules),
 *   - NOT a known grant-aggregator noise domain,
 *   - carries a funding signal in its title/snippet/url.
 * Pure; exported for tests.
 */
export function isRealFundingHit(hit) {
  const url = String(hit?.url || '').trim()
  if (isExcludedNoiseUrl(url)) return false
  const text = `${hit?.title ?? ''} ${hit?.snippet ?? ''} ${url}`
  return FUNDING_SIGNAL_RE.test(text)
}

/**
 * The URL-shape exclusions of isRealFundingHit WITHOUT the funding-signal text
 * heuristic: non-http, search-engine results pages, placeholders, social /
 * non-actionable hosts, grant-aggregator noise. These are applied on BOTH
 * sides of the ledger (an aggregator page is not an award anywhere); the text
 * heuristic is applied only to a purported NEW miss (webparity-9). Pure.
 */
export function isExcludedNoiseUrl(url) {
  const s = String(url || '').trim()
  if (!/^https?:\/\//i.test(s)) return true
  if (isSearchEngineUrl(s) || isPlaceholderUrl(s) || isNonActionableUrl(s)) return true
  const domain = extractHostname(s)
  if (!domain) return true
  return [...AGGREGATOR_NOISE_DOMAINS].some(
    (noiseDomain) => domain === noiseDomain || domain.endsWith('.' + noiseDomain),
  )
}

/** parity points (0–100). No measured web denominator is unscored, not 100. */
export function parityScore(overlapCount, webOnlyCount) {
  const o = Math.max(0, Number(overlapCount) || 0)
  const w = Math.max(0, Number(webOnlyCount) || 0)
  if (o + w === 0) return null
  return Math.round((o / (o + w)) * 1000) / 10
}

/**
 * First profile need the hit's text actually STATES (honest attribution; may
 * be null). Token-bounded, never a bare substring — `ssi` sat inside
 * "assistance" and mis-attributed every assistance page to an SSI need, and
 * that label travelled onto the seed snippet and condition-coverage credit
 * (webparity-8). Same three rungs as needMatchesHit: whole phrase, semantic
 * rule, distinctive token.
 */
function needForHit(hit, needs = []) {
  const text = normalizedHitText({ title: hit?.title, snippet: hit?.snippet, url: '' })
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `
  for (const n of Array.isArray(needs) ? needs : []) {
    const need = String(n || '').replace(/[_-]+/g, ' ').trim().toLowerCase()
    if (!need) continue
    const phrase = need.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (phrase.length >= 3 && haystack.includes(` ${phrase} `)) return need
    if (NEED_SEMANTIC_RULES.some((rule) => rule.need.test(need) && rule.hit.test(text))) return need
    const tokens = need.split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !NEED_TOKEN_STOPWORDS.has(token))
    if (tokens.some((token) => new RegExp('\\b' + token + '\\b', 'i').test(text))) return need
  }
  return null
}

const SPONSOR_IDENTITY_STOPWORDS = new Set([
  'and', 'association', 'charity', 'community', 'company', 'corporation', 'foundation',
  'fund', 'funding', 'grant', 'grants', 'inc', 'initiative', 'organization', 'program',
  'services', 'society', 'the', 'trust',
])

function sponsorIdentityTerms(sponsor) {
  return String(sponsor || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !SPONSOR_IDENTITY_STOPWORDS.has(token))
}

function titleSponsorIdentityMatches(storedRow, hit, hitTitleKey, hitDomain) {
  if (!hitTitleKey || storedRow.titleKey !== hitTitleKey) return false
  if (hitDomain && storedRow.domains.has(hitDomain)) return true
  const sponsorTerms = sponsorIdentityTerms(storedRow.sponsor)
  if (sponsorTerms.length === 0) return false
  const hitText = normalizedHitText(hit).toLowerCase()
  return sponsorTerms.some((term) => new RegExp(`\\b${term}\\b`, 'i').test(hitText))
}

/**
 * Classify a web session's hits against the profile's stored top matches.
 *
 * Identity ladder (strongest first), mirroring canonicalOpportunityKey's
 * spirit for the fields a SERP hit actually has:
 *   1. normalized URL equality against any stored URL field,
 *   2. program-title identity plus sponsor/site corroboration. SERP hits have
 *      no reliable structured sponsor, so the stored sponsor must appear in
 *      the hit text or the exact title must be on the same host.
 *
 * Domain is retained as provenance on the result, but never proves overlap:
 * one funder site commonly hosts several distinct programs.
 *
 * @param {Array<{url,title,snippet}>} webHits   raw session hits (pre-filter)
 * @param {Array<{id,title,sponsor,application_url,apply_url,source_url}>} storedMatches
 * @param {{needs?:string[]}} [opts]
 * @returns {{overlap:Array, web_only:Array, grantflow_only:number, web_real:number}}
 */
export function classifyWebResults(webHits, storedMatches, { needs = [], state = null, applicantTypes = [] } = {}) {
  const stored = Array.isArray(storedMatches) ? storedMatches : []
  const storedRows = stored.map((m) => {
    const urls = [m.application_url, m.apply_url, m.source_url, m.final_url, m.evidence_url]
    const urlKeys = urls.map(normalizeUrlKey).filter(Boolean)
    const domains = urls.map(extractHostname).filter(Boolean)
    const titleKey = titleIdentityKey(m.title) || ''
    // A POINTER (directory / referral / school_portal / past_award_intel) is
    // not "found funding": its contract is to send you somewhere else, and the
    // locator rule already forbids it an award. It is kept as EVIDENCE (the
    // catalog has judged the page) but never as coverage (webparity-2).
    const kindRaw = [m.opportunity_kind, m.result_kind, m.kind].find((value) => value !== null && value !== undefined && String(value).trim() !== '')
    const pointer = isPointerKind(kindRaw)
    return {
      id: m.id ?? null,
      urlKeys: new Set(urlKeys),
      domains: new Set(domains),
      titleKey,
      sponsor: m.sponsor,
      pointer,
      kind: pointer ? String(kindRaw).trim().toLowerCase() : null,
    }
  })
  const storedPointerRows = storedRows.filter((row) => row.pointer).length

  const overlap = []
  const web_only = []
  const seen = new Set()
  const coveredStored = new Set()
  const dropped = { noise_url: 0, out_of_state: 0, duplicate: 0, no_funding_signal: 0, not_direct_funding: 0 }
  let webReal = 0

  for (const hit of Array.isArray(webHits) ? webHits : []) {
    // URL-shape exclusions apply to BOTH sides: a search-results page, a
    // placeholder, a social host or an aggregator is not an award anywhere.
    if (isExcludedNoiseUrl(hit?.url)) { dropped.noise_url += 1; continue }
    // Another state's government portal is ineligible for THIS profile on
    // either side — counting it as overlap would admit an ineligible program.
    if (isOutOfStateGovHit(hit.url, state)) { dropped.out_of_state += 1; continue }
    const urlKey = normalizeUrlKey(hit.url)
    if (!urlKey) { dropped.noise_url += 1; continue }
    if (seen.has(urlKey)) { dropped.duplicate += 1; continue }
    seen.add(urlKey)

    const titleKey = titleIdentityKey(hit.title) || ''
    const domain = extractHostname(hit.url)
    const item = {
      url: String(hit.url).trim(),
      canonical_key: urlKey,
      title: String(hit.title || '').trim().slice(0, 200),
      domain,
      need: needForHit(hit, needs),
    }
    // Provenance the run attaches when it collects the SERP (query text,
    // 0-based query index, 1-based rank) — the disposition machinery needs it
    // to say whether the lane could ever have reached this hit (webparity-6).
    if (Number.isFinite(Number(hit.query_index))) item.query_index = Number(hit.query_index)
    if (Number.isFinite(Number(hit.rank))) item.rank = Number(hit.rank)
    if (hit.query) item.query = String(hit.query)

    // Identity FIRST (webparity-9): whether GrantFlow already holds the page
    // is a fact about the URL/title, not about how the SERP snippet reads.
    const matchingStoredIndexes = []
    const pointerMatches = []
    storedRows.forEach((row, index) => {
      const matches = row.urlKeys.has(urlKey) || titleSponsorIdentityMatches(row, hit, titleKey, domain)
      if (!matches) return
      if (row.pointer) pointerMatches.push(row)
      else matchingStoredIndexes.push(index)
    })
    const covers = matchingStoredIndexes.length > 0

    // A confirmed overlap is evidence GrantFlow already covers the web page,
    // even when the search snippet is sparse. Only a purported NEW miss must
    // carry a funding signal and prove it is relevant and actionable for this
    // profile. A hit matching ONLY pointer rows is classified exactly as if
    // those rows did not exist — admitting a directory can never move parity.
    if (!covers) {
      if (!isRealFundingHit(hit)) { dropped.no_funding_signal += 1; continue }
      if (!isBenchmarkDirectFundingHit(hit, { needs, applicantTypes })) { dropped.not_direct_funding += 1; continue }
    }
    webReal += 1

    if (covers) {
      overlap.push(item)
      for (const index of matchingStoredIndexes) coveredStored.add(index)
    } else {
      if (pointerMatches.length) {
        const [first] = pointerMatches
        item.catalog_pointer = { kind: first.kind, opportunity_id: first.id, matches: pointerMatches.length }
      }
      web_only.push(item)
    }
  }

  const storedFundingRows = storedRows.length - storedPointerRows
  return {
    overlap,
    web_only,
    grantflow_only: Math.max(0, storedFundingRows - coveredStored.size),
    web_real: webReal,
    stored_pointer_rows: storedPointerRows,
    dropped,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence (system_kv; UPDATE-then-INSERT — shim-safe, mirrors
// coverageGapScoreboard / enforceInvariants' observability record)
// ─────────────────────────────────────────────────────────────────────────────

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

async function kvSet(db, key, obj, at) {
  await ensureKv(db)
  const now = at || new Date().toISOString()
  const value = JSON.stringify(obj)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, key)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now)
  }
}

async function kvGetJson(db, key) {
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(key)
    return row?.value ? JSON.parse(row.value) : null
  } catch {
    return null
  }
}

/** Read the persisted benchmark store (Sam check / Anya digest / admin). */
export async function readWebParityBenchmark(db) {
  if (!db?.prepare) return null
  return kvGetJson(db, KV_KEY)
}

/** Read the candidate gap queue (Amy's work queue; honest provenance). */
export async function readWebParityGapQueue(db) {
  if (!db?.prepare) return []
  const parsed = await kvGetJson(db, GAP_QUEUE_KV_KEY)
  return Array.isArray(parsed?.candidates) ? parsed.candidates : Array.isArray(parsed) ? parsed : []
}

/**
 * Append web_only findings to the candidate queue: deduped by
 * (profile_id, normalized url), newest kept, bounded to GAP_QUEUE_CAP.
 * Candidate entries carry the shape the url-rescue-style machinery can later
 * drive through upsertFundingOpportunity — this module never inserts to the
 * catalog itself.
 */
const NOT_EVALUATED_PREFIX = 'not_evaluated:'
const NOT_EVALUATED_EXHAUSTED = `${NOT_EVALUATED_PREFIX}exhausted`

function normalizeGapStatus(value) {
  return String(value || 'candidate').trim().toLowerCase() || 'candidate'
}

function isNotEvaluatedGapStatus(value) {
  return normalizeGapStatus(value).startsWith(NOT_EVALUATED_PREFIX)
}

/**
 * Terminal = the gates have SPOKEN (adopted / gated_out / dismissed) or the
 * page has had every bounded chance (`not_evaluated:exhausted`). A plain
 * `not_evaluated:<class>` is NOT terminal: the page was never judged, only
 * unreadable at the time, and stays eligible for re-seeding after a cooldown.
 */
function isTerminalGapStatus(value) {
  const status = normalizeGapStatus(value)
  return status === 'adopted' || status === 'gated_out' || status === 'dismissed' || status === NOT_EVALUATED_EXHAUSTED
}

/**
 * Pending = the gates have NOT spoken: a fresh `candidate`, or a bounded
 * `not_evaluated:<class>` page still eligible for re-seeding. THE read-side
 * predicate for "how much of the owner rule's backlog is open" (admin status,
 * seed loader) — never re-derive it from a status string at a call site.
 */
export function isPendingGapStatus(value) {
  const status = normalizeGapStatus(value)
  return status === 'candidate' || (isNotEvaluatedGapStatus(status) && !isTerminalGapStatus(status))
}

function gapCandidateKey(candidate) {
  const profileId = String(candidate?.profile_id || '').trim()
  const urlKey = normalizeUrlKey(candidate?.url)
  return profileId && urlKey ? profileId + '|' + urlKey : ''
}

/** Most-recent-touch timestamp for a gap-queue row, for age-based eviction WITHIN a class. */
function gapCandidateRecencyMs(row) {
  const fields = ['resolved_at', 'disposition_at', 'not_refound_at', 'last_refound_at', 'found_at', 'first_found_at']
  let best = 0
  for (const f of fields) {
    const t = Date.parse(row?.[f])
    if (Number.isFinite(t) && t > best) best = t
  }
  return best
}

/**
 * Bound the gap queue to GAP_QUEUE_CAP with a CLASS-AWARE eviction order,
 * never a blind positional slice (webparity-eviction, 2026-09-12 — a HIGH
 * finding against the prior `.slice(-GAP_QUEUE_CAP)`, which let the newest
 * rows always win regardless of status and let a single night's blind trim
 * evict an already-saturated queue's entire terminal gate-verdict history).
 *
 * Three classes, evicted in this priority order (lowest first):
 *   1. plain pending   — never offered, no disposition recorded yet
 *   2. dispositioned pending — carries a `disposition` (webparity-3/4
 *      evidence for WHY it is still web-only), except the most recent
 *      GAP_QUEUE_MIN_DISPOSITIONED_PER_PROFILE per profile, which are NEVER
 *      evicted (a floor, not a preference — see the constant's doc)
 *   3. terminal — a real gate verdict (adopted/gated_out/dismissed/
 *      not_evaluated:exhausted); evicted only once classes 1 and 2 are
 *      exhausted
 * Within a class, the OLDEST row (by gapCandidateRecencyMs) is evicted first.
 * Original relative order is preserved among survivors.
 */
function trimGapQueue(rows, cap = GAP_QUEUE_CAP) {
  if (!Array.isArray(rows) || rows.length <= cap) return rows
  const indexed = rows.map((row, i) => ({ row, i, ts: gapCandidateRecencyMs(row) }))
  const terminal = []
  const dispositionedPending = []
  const plainPending = []
  for (const item of indexed) {
    if (isTerminalGapStatus(item.row?.status)) terminal.push(item)
    else if (item.row?.disposition) dispositionedPending.push(item)
    else plainPending.push(item)
  }

  const protectedIndexes = new Set()
  const byProfile = new Map()
  for (const item of dispositionedPending) {
    const profileId = String(item.row?.profile_id || '')
    if (!byProfile.has(profileId)) byProfile.set(profileId, [])
    byProfile.get(profileId).push(item)
  }
  for (const items of byProfile.values()) {
    items.sort((a, b) => b.ts - a.ts) // newest first
    for (const item of items.slice(0, GAP_QUEUE_MIN_DISPOSITIONED_PER_PROFILE)) protectedIndexes.add(item.i)
  }

  const byAgeAscending = (a, b) => a.ts - b.ts
  plainPending.sort(byAgeAscending)
  const evictableDispositioned = dispositionedPending.filter((item) => !protectedIndexes.has(item.i)).sort(byAgeAscending)
  terminal.sort(byAgeAscending)

  const evictionOrder = [...plainPending, ...evictableDispositioned, ...terminal]
  const toEvict = Math.min(rows.length - cap, evictionOrder.length)
  const evictedIndexes = new Set(evictionOrder.slice(0, toEvict).map((item) => item.i))

  return indexed.filter((item) => !evictedIndexes.has(item.i)).map((item) => item.row)
}

/**
 * Refresh the benchmark-owned pending queue to the latest scoped run.
 *
 * Terminal decisions and candidates owned by other producers are retained.
 * A pending web-parity candidate that the latest run did NOT re-find is also
 * RETAINED (with `not_refound_at` / `not_refound_runs` bookkeeping): it was
 * never handed to the gates, so deleting it lost the owner rule's evidence
 * and the disposition (webparity-7 — the SERP rotates nightly and seeding
 * consumes at most GAP_SEED_LIMIT_PER_RUN per discovery run). "Re-seeded
 * forever" is prevented by the OUTCOME side instead: every offered candidate
 * becomes terminal or bounded `not_evaluated`. Scoped profile ids keep
 * partial/manual runs from touching other profiles' rows; the cap still holds.
 */
export async function appendGapCandidates(
  db,
  entries = [],
  { now = new Date(), profileIds = null } = {},
) {
  if (!db?.prepare) return { appended: 0, refreshed: 0, retained_not_refound: 0, total: 0 }

  const incoming = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.url && entry.profile_id)
  const explicitScope = Array.isArray(profileIds)
    ? profileIds.map(String).filter(Boolean)
    : []
  const inferredScope = [...new Set(incoming.map((entry) => String(entry.profile_id)))]
  const scope = new Set(explicitScope.length ? explicitScope : inferredScope)
  const existing = await readWebParityGapQueue(db)
  const currentKeys = new Set(incoming.map(gapCandidateKey).filter(Boolean))
  const previousPending = new Map()
  const byKey = new Map()
  const at = (now instanceof Date ? now : new Date(now)).toISOString()

  let retainedNotRefound = 0
  let refreshed = 0
  let appended = 0

  for (const candidate of existing) {
    const key = gapCandidateKey(candidate)
    if (!key) continue
    const sourceName = String(candidate?.source || 'web_parity_benchmark')
    const terminal = isTerminalGapStatus(candidate?.status)
    const inScope = scope.has(String(candidate?.profile_id || ''))

    if (sourceName === 'web_parity_benchmark' && !terminal && inScope) {
      previousPending.set(key, candidate)
      if (currentKeys.has(key)) {
        refreshed += 1
        continue // re-created below from the fresh entry, carrying bookkeeping
      }
      retainedNotRefound += 1
      byKey.set(key, {
        ...candidate,
        not_refound_at: at,
        not_refound_runs: (Number(candidate.not_refound_runs) || 0) + 1,
      })
      continue
    }
    byKey.set(key, candidate)
  }

  for (const entry of incoming) {
    const key = gapCandidateKey(entry)
    if (!key || byKey.has(key)) continue
    const prev = previousPending.get(key) || null
    if (!prev) appended += 1
    const row = {
      ...(prev || {}),
      url: String(entry.url).trim(),
      title: String(entry.title || '').trim().slice(0, 200),
      profile_id: entry.profile_id,
      need: entry.need ?? null,
      domain: entry.domain ?? extractHostname(entry.url) ?? null,
      source: entry.source ?? prev?.source ?? 'web_parity_benchmark',
      status: prev?.status ?? 'candidate',
      first_found_at: prev?.first_found_at ?? prev?.found_at ?? at,
      found_at: at,
      last_refound_at: at,
    }
    if (entry.canonical_key) row.canonical_key = entry.canonical_key
    else if (!row.canonical_key) row.canonical_key = normalizeUrlKey(entry.url) || null
    if (entry.disposition) {
      row.disposition = entry.disposition
      row.disposition_at = at
      if (entry.disposition_evidence !== undefined) row.disposition_evidence = entry.disposition_evidence
    }
    delete row.not_refound_at
    delete row.not_refound_runs
    byKey.set(key, row)
  }

  const candidates = trimGapQueue([...byKey.values()], GAP_QUEUE_CAP)
  await kvSet(db, GAP_QUEUE_KV_KEY, { updated_at: at, candidates }, at)
  return {
    appended,
    refreshed,
    retained_not_refound: retainedNotRefound,
    total: candidates.length,
    scoped_profiles: scope.size,
  }
}

/**
 * Stamp the benchmark's per-result disposition onto the matching gap-queue
 * candidates (profile-scoped, identity-keyed). Only `disposition`,
 * `disposition_at`, `disposition_evidence` and `canonical_key` are touched —
 * never `status`: a disposition explains WHY a page is still web-only; the
 * gates' verdict is recorded by markGapCandidateOutcomes.
 */
export async function recordGapCandidateDispositions(db, dispositions = [], { now = new Date() } = {}) {
  if (!db?.prepare || !Array.isArray(dispositions) || dispositions.length === 0) return { updated: 0 }
  const at = (now instanceof Date ? now : new Date(now)).toISOString()
  const byKey = new Map()
  for (const d of dispositions) {
    const key = gapCandidateKey(d)
    if (key && d?.disposition) byKey.set(key, d)
  }
  if (byKey.size === 0) return { updated: 0 }
  const queue = await readWebParityGapQueue(db)
  let updated = 0
  const next = queue.map((candidate) => {
    const d = byKey.get(gapCandidateKey(candidate))
    if (!d) return candidate
    updated += 1
    return {
      ...candidate,
      canonical_key: candidate.canonical_key ?? d.canonical_key ?? normalizeUrlKey(candidate.url) ?? null,
      disposition: d.disposition,
      disposition_at: at,
      disposition_evidence: d.evidence ?? d.disposition_evidence ?? null,
    }
  })
  if (updated) await kvSet(db, GAP_QUEUE_KV_KEY, { updated_at: at, candidates: next }, at)
  return { updated }
}

/**
 * Seed pages for ONE profile's next discovery run — the consumer side of the
 * owner's standing rule: "if a funding source is found that meets the needs of a
 * profile, ADD that funding source."
 *
 * Until this existed the gap queue was write-only. The benchmark found real
 * funding pages GrantFlow lacked, filed them honestly as candidates, and nothing
 * ever read the file — so the same pages were re-found and re-filed every night
 * and the owner was asked to adjudicate them by hand ("candidate queue — nothing
 * auto-added", 2026-07-15). The queue was a record of the gap, not a fix for it.
 *
 * These URLs are handed to the web lane as seed pages, where they are fetched,
 * LLM-extracted, reality-gated, deduped and scored by the canonical match engine
 * exactly like a search hit. So "auto-add" never means "trust the benchmark": it
 * means the gates get to SEE a page they were previously never handed. A seed
 * that is a directory, a stub, out of scope, or simply not a match is rejected
 * by the same rules as everything else — which is why this can be automatic
 * without lowering any bar.
 *
 * `pending_only` (default) skips candidates already resolved, so a page the
 * gates have judged is not re-fetched on every crawl.
 *
 * @returns {Promise<Array<{url,title,snippet}>>} bounded, oldest-first
 */
export async function loadGapSeedPagesForProfile(db, profileId, {
  limit = GAP_SEED_LIMIT_PER_RUN,
  pendingOnly = true,
  now = new Date(),
  reseedCooldownMs = NOT_EVALUATED_RESEED_COOLDOWN_MS,
} = {}) {
  if (!db?.prepare || !profileId) return []
  const queue = await readWebParityGapQueue(db)
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime()
  const forProfile = queue
    .filter((c) => String(c?.profile_id) === String(profileId))
    .filter((c) => /^https?:\/\//i.test(String(c?.url || '')))
  const toSeed = (c) => ({ url: c.url, title: c.title ?? null, snippet: c.need ? `need: ${c.need}` : null })
  if (!pendingOnly) return forProfile.slice(0, Math.max(0, limit)).map(toSeed)

  // Fresh candidates first (never offered), then not-evaluated pages whose
  // cooldown has elapsed — an unreadable page gets another LOOK once the LLM
  // route has had time to heal, but never crowds out a page never yet offered
  // and never past GAP_SEED_MAX_OFFERS (that is `not_evaluated:exhausted`,
  // which is terminal for seeding).
  const fresh = forProfile.filter((c) => normalizeGapStatus(c?.status) === 'candidate')
  const cooled = forProfile.filter((c) => {
    if (!isNotEvaluatedGapStatus(c?.status) || !isPendingGapStatus(c?.status)) return false
    if ((Number(c?.offer_count) || 0) >= GAP_SEED_MAX_OFFERS) return false
    const offeredMs = Date.parse(c?.offered_at || '')
    return !Number.isFinite(offeredMs) || nowMs - offeredMs >= reseedCooldownMs
  })
  return [...fresh, ...cooled].slice(0, Math.max(0, limit)).map(toSeed)
}

/**
 * Map a lane rejection (gate name and/or free-text reason) onto the four
 * canonical gates. An explicit canonical gate wins; otherwise the reason's
 * vocabulary decides; the reality gate is the default because the web lane's
 * `enforceReality` is where most seeds die. Exported for the replay script.
 */
export function gateFromReason(gate, reason) {
  const g = String(gate || '').trim().toLowerCase()
  if (GATE_NAMES.includes(g)) return g
  const text = `${g} ${String(reason || '')}`.toLowerCase()
  if (/apply[_ -]?target|application[_ -]?url|apply[_ -]?url|actionable|no[_ -]?url|missing[_ -]?url/.test(text)) return 'apply_target'
  if (/eligib|applicant|geo|state|scope|jurisdiction|foreign|stage|ceiling|profession/.test(text)) return 'eligibility'
  if (/\bneed|relev|topical/.test(text)) return 'need'
  return 'reality'
}

const SEED_OUTCOME_GATE_REJECTED = new Set([
  'gate_rejected', 'rejected', 'reality_rejected', 'eligibility_rejected', 'need_rejected', 'apply_target_rejected',
  'reality', 'eligibility', 'need', 'apply_target',
])
const SEED_OUTCOME_FETCH_FAILED = new Set(['fetch_failed', 'unfetchable', 'fetch_error', 'not_fetched'])
const SEED_OUTCOME_EXTRACTION_FAILED = new Set(['extraction_failed', 'extracted_nothing', 'no_candidates', 'extractor_empty'])
const SEED_OUTCOME_ADOPTED = new Set(['adopted', 'stored', 'deduped'])

function seedOutcomeIndex(seedOutcomes) {
  const index = new Map()
  for (const entry of Array.isArray(seedOutcomes) ? seedOutcomes : []) {
    const key = normalizeUrlKey(entry?.url)
    if (key) index.set(key, entry)
  }
  return index
}

/**
 * Decide one offered-but-not-adopted seed's status from the evidence the lane
 * actually recorded. Returns { status, gate?, gate_reason?, evidence }.
 *
 *   gated_out                       ONLY on a recorded gate verdict (per-seed ledger)
 *   not_evaluated:fetch_failed      the page could not be fetched
 *   not_evaluated:extraction_failed fetched, extractor produced nothing (per-seed,
 *                                   or run-wide when the lane fetched pages and
 *                                   extracted ZERO — the dead-LLM signature)
 *   not_evaluated:outcome_unknown   a ledger entry with an unrecognised outcome
 *   not_evaluated:lane_ledger_unavailable  no per-seed ledger and no run totals
 */
function decideUnadoptedSeedStatus(entry, laneRun) {
  if (entry) {
    const outcome = String(entry.outcome || entry.stage || entry.status || '').trim().toLowerCase()
    if (SEED_OUTCOME_GATE_REJECTED.has(outcome)) {
      const gate = gateFromReason(entry.gate ?? outcome, entry.reason)
      return { status: 'gated_out', gate, gate_reason: entry.reason ?? null, evidence: { source: 'seed_ledger', outcome } }
    }
    if (SEED_OUTCOME_FETCH_FAILED.has(outcome) || entry.fetched === false) {
      return { status: `${NOT_EVALUATED_PREFIX}fetch_failed`, gate_reason: entry.reason ?? null, evidence: { source: 'seed_ledger', outcome } }
    }
    if (SEED_OUTCOME_EXTRACTION_FAILED.has(outcome) || (entry.fetched === true && Number(entry.extracted) === 0)) {
      return { status: `${NOT_EVALUATED_PREFIX}extraction_failed`, gate_reason: entry.reason ?? null, evidence: { source: 'seed_ledger', outcome } }
    }
    return { status: `${NOT_EVALUATED_PREFIX}outcome_unknown`, gate_reason: entry.reason ?? null, evidence: { source: 'seed_ledger', outcome: outcome || null } }
  }
  if (laneRun && typeof laneRun === 'object') {
    const fetched = Number(laneRun.fetched)
    const extracted = Number(laneRun.extracted)
    if (Number.isFinite(fetched) && fetched === 0) {
      return { status: `${NOT_EVALUATED_PREFIX}fetch_failed`, evidence: { source: 'lane_run_totals', fetched, extracted: Number.isFinite(extracted) ? extracted : null } }
    }
    if (Number.isFinite(fetched) && fetched > 0 && Number.isFinite(extracted) && extracted === 0) {
      return { status: `${NOT_EVALUATED_PREFIX}extraction_failed`, evidence: { source: 'lane_run_totals', fetched, extracted } }
    }
    if (laneRun.extraction_available === false) {
      return { status: `${NOT_EVALUATED_PREFIX}extraction_failed`, evidence: { source: 'lane_run_flag', extraction_available: false } }
    }
  }
  return { status: `${NOT_EVALUATED_PREFIX}lane_ledger_unavailable`, evidence: { source: 'none' } }
}

/**
 * Record what the gates decided about seeded candidates, so the queue stops
 * re-offering a page that has already had its chance and the owner report can
 * show the rule WORKING (adopted) or honestly not (gated_out) instead of an
 * ever-growing pile of unjudged links.
 *
 * `adoptedUrls` are the seeds that became catalog rows this run. An offered
 * seed that was NOT adopted is `gated_out` ONLY when a gate verdict is on
 * record (`seedOutcomes`, the lane's per-seed ledger). Without one, "not
 * adopted" is NOT a verdict: during the two weeks every LLM provider was dead
 * the lane extracted ZERO candidates from every fetched page, so a seed could
 * only ever be marked gated_out — a fetch/extraction failure wearing a gate
 * verdict's costume, indistinguishable from a real rejection and never
 * retried (webparity-3/4). Those become `not_evaluated:<class>` and stay
 * eligible for re-seeding (cooldown + GAP_SEED_MAX_OFFERS bound).
 *
 * @param {object} db
 * @param {object} args
 * @param {string[]} args.offeredUrls   every seed handed to the lane this run
 * @param {string[]} args.adoptedUrls   seeds that produced/deduped onto a catalog row
 * @param {string|null} [args.profileId]
 * @param {Array<{url, outcome, gate?, reason?, fetched?, extracted?}>} [args.seedOutcomes]
 *        the lane's per-seed ledger (outcome: gate_rejected|fetch_failed|
 *        extraction_failed|stored|deduped); absent until the lane exports it
 * @param {{fetched?:number, extracted?:number, extraction_available?:boolean}} [args.laneRun]
 *        the lane's run totals (run.web_lane) — the run-wide dead-LLM signature
 */
export async function markGapCandidateOutcomes(db, {
  offeredUrls = [],
  adoptedUrls = [],
  profileId = null,
  now = new Date(),
  seedOutcomes = null,
  laneRun = null,
} = {}) {
  if (!db?.prepare || offeredUrls.length === 0) return { adopted: 0, gated_out: 0, not_evaluated: 0 }
  const adopted = new Set(adoptedUrls.map(normalizeUrlKey).filter(Boolean))
  const offered = new Set(offeredUrls.map(normalizeUrlKey).filter(Boolean))
  const outcomes = seedOutcomeIndex(seedOutcomes)
  const at = (now instanceof Date ? now : new Date(now)).toISOString()

  const queue = await readWebParityGapQueue(db)
  let adoptedCount = 0
  let gatedCount = 0
  let notEvaluatedCount = 0
  // Conditions whose gap an ADOPTED source just closed — see creditConditionCoverage.
  const coveredConditions = new Set()
  const next = queue.map((c) => {
    if (profileId !== null && String(c?.profile_id) !== String(profileId)) return c
    const key = normalizeUrlKey(c?.url)
    if (!key || !offered.has(key)) return c
    const offerCount = (Number(c?.offer_count) || 0) + 1
    const base = { ...c, offered_at: at, offer_count: offerCount }
    const ledgerEntry = outcomes.get(key) || null
    const ledgerOutcome = String(ledgerEntry?.outcome || ledgerEntry?.stage || '').trim().toLowerCase()
    if (adopted.has(key) || SEED_OUTCOME_ADOPTED.has(ledgerOutcome)) {
      adoptedCount += 1
      if (c?.source === 'condition_source_search' && c?.need) coveredConditions.add(String(c.need))
      return { ...base, status: 'adopted', resolved_at: at, gate: null, gate_reason: null }
    }
    const decided = decideUnadoptedSeedStatus(ledgerEntry, laneRun)
    if (decided.status === 'gated_out') {
      gatedCount += 1
      return { ...base, status: 'gated_out', gate: decided.gate, gate_reason: decided.gate_reason ?? null, resolved_at: at, outcome_evidence: decided.evidence }
    }
    notEvaluatedCount += 1
    // Bounded: the last permitted offer without a verdict parks the page.
    const status = offerCount >= GAP_SEED_MAX_OFFERS ? NOT_EVALUATED_EXHAUSTED : decided.status
    return {
      ...base,
      status,
      not_evaluated_class: decided.status.slice(NOT_EVALUATED_PREFIX.length),
      gate: null,
      gate_reason: decided.gate_reason ?? null,
      outcome_evidence: decided.evidence,
      ...(status === NOT_EVALUATED_EXHAUSTED ? { resolved_at: at } : {}),
    }
  })
  await kvSet(db, GAP_QUEUE_KV_KEY, { updated_at: at, candidates: next }, at)
  if (coveredConditions.size) await creditConditionCoverage(db, [...coveredConditions], { now })
  return { adopted: adoptedCount, gated_out: gatedCount, not_evaluated: notEvaluatedCount, conditions_covered: coveredConditions.size }
}

/**
 * Credit a condition as COVERED because a real source for it was adopted.
 *
 * THIS IS WHAT MAKES THE ADAPTER WISHLIST CONVERGE. `conditionCoveredBySource`
 * matches against the STATIC sourceRegistry, but an adopted source lands in
 * `funding_opportunities`, which that registry never sees. Without this credit, the
 * wishlist consumer could find and adopt a real epilepsy source and the scoreboard
 * would STILL report "No disease-specific source lane exists for epilepsy" every
 * night forever — permanently holding one of the 10 wishlist slots and starving new
 * gaps. That is not convergence; it is the same finding with a footnote, and it
 * fails the rule that discovered sources RETIRE wishlist items.
 *
 * Only conditions whose candidate survived the FULL gate stack (fetch → LLM extract
 * → reality gate → dedupe → canonical match engine → a real catalog row) reach here,
 * so this can never manufacture coverage the system does not have (G0).
 */
export async function creditConditionCoverage(db, conditions = [], { now = new Date() } = {}) {
  if (!db?.prepare || !conditions.length) return { credited: 0 }
  const at = (now instanceof Date ? now : new Date(now)).toISOString()
  const key = (c) => String(c || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const existing = await kvGetJson(db, CONDITION_COVERAGE_KV_KEY)
  const set = new Set(Array.isArray(existing?.conditions) ? existing.conditions : [])
  let credited = 0
  for (const c of conditions) {
    const k = key(c)
    if (!k || set.has(k)) continue
    set.add(k)
    credited += 1
  }
  if (credited) await kvSet(db, CONDITION_COVERAGE_KV_KEY, { updated_at: at, conditions: [...set] }, at)
  return { credited, total: set.size }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default loaders (all injectable)
// ─────────────────────────────────────────────────────────────────────────────

/** Golden expectations: [{profile_id, label, require_sources[]}] (same KV as coverage.goldenOutcomes). */
async function defaultLoadGolden(db) {
  const parsed = await kvGetJson(db, GOLDEN_KV_KEY)
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.expectations)
      ? parsed.expectations
      : Array.isArray(parsed?.profiles)
        ? parsed.profiles
        : []
  return list.filter((e) => e && e.profile_id)
}

/** Canonical thesis for one live profile (needs + state + applicant types). */
async function defaultBuildThesis(db, profileId) {
  const { buildThesisForProfile } = await import('./crawlerOsService.js')
  return buildThesisForProfile(db, profileId)
}

async function tableColumnSet(db, tableName) {
  const safeTable = new Set(['funding_opportunities', 'profile_opportunity_matches'])
  if (!safeTable.has(tableName)) throw new Error(`unsupported benchmark table: ${tableName}`)
  const rows = db?.dialect === 'postgres'
    ? await db.prepare(
      `SELECT column_name AS name
         FROM information_schema.columns
        WHERE table_schema = ANY (current_schemas(false)) AND table_name = ?`,
    ).all(tableName)
    : await db.prepare(`PRAGMA table_info(${tableName})`).all()
  return new Set((Array.isArray(rows) ? rows : []).map((row) => String(row?.name ?? row?.column_name ?? '').toLowerCase()).filter(Boolean))
}

function attachStoredSelectionMeta(rows, meta) {
  if (!Array.isArray(rows)) return rows
  Object.defineProperty(rows, 'selectionMeta', {
    value: Object.freeze(meta),
    enumerable: false,
    configurable: true,
  })
  return rows
}

/**
 * The profile's CURRENT top stored matches (the thing that must beat the web).
 *
 * The match store is a rolling snapshot, but the joined catalog row can still
 * carry an independent lifecycle kill switch. Build the predicate from the
 * columns that actually exist in this database and fail closed if schema
 * introspection is unavailable; silently benchmarking inactive/quarantined
 * rows would manufacture overlap.
 */
async function defaultLoadStoredMatches(db, profileId) {
  const [opportunityColumns, matchColumns] = await Promise.all([
    tableColumnSet(db, 'funding_opportunities'),
    tableColumnSet(db, 'profile_opportunity_matches'),
  ])
  if (!opportunityColumns.has('id') || !matchColumns.has('profile_id') || !matchColumns.has('opportunity_id')) {
    throw new Error('stored match lifecycle schema is unavailable')
  }

  const order = db?.dialect === 'postgres' ? 'm.match_score DESC NULLS LAST' : 'm.match_score DESC'
  const selectOpportunityField = (name) => opportunityColumns.has(name) ? `o.${name}` : `NULL AS ${name}`
  const where = ['m.profile_id = ?']
  const appliedFilters = []

  if (matchColumns.has('match_decision')) {
    where.push("LOWER(TRIM(COALESCE(m.match_decision, ''))) <> 'reject'")
    appliedFilters.push('match_decision_not_reject')
  }
  if (opportunityColumns.has('is_active')) {
    where.push('COALESCE(o.is_active, TRUE) = TRUE')
    appliedFilters.push('active_only')
  }
  if (opportunityColumns.has('is_hidden')) {
    where.push('COALESCE(o.is_hidden, FALSE) = FALSE')
    appliedFilters.push('visible_only')
  }
  if (opportunityColumns.has('status')) {
    where.push("LOWER(TRIM(COALESCE(o.status, 'active'))) NOT IN ('paused', 'expired', 'retired', 'quarantined')")
    appliedFilters.push('live_status_only')
  }
  if (opportunityColumns.has('link_status')) {
    where.push("LOWER(TRIM(COALESCE(o.link_status, 'unverified'))) NOT IN ('broken', 'retired', 'quarantined')")
    appliedFilters.push('usable_link_only')
  }
  if (opportunityColumns.has('verification_status')) {
    where.push("LOWER(TRIM(COALESCE(o.verification_status, 'needs_review'))) NOT IN ('suspected_dead', 'broken', 'retired', 'quarantined', 'rejected')")
    appliedFilters.push('verification_not_dead')
  }
  if (opportunityColumns.has('reality_status')) {
    where.push("LOWER(TRIM(COALESCE(o.reality_status, 'unknown'))) <> 'rejected'")
    appliedFilters.push('reality_not_rejected')
  }
  if (opportunityColumns.has('deadline_status')) {
    where.push("LOWER(TRIM(COALESCE(o.deadline_status, 'unknown'))) NOT IN ('expired', 'closed', 'retired')")
    appliedFilters.push('deadline_status_open')
  }
  if (opportunityColumns.has('deadline')) {
    const rolling = opportunityColumns.has('deadline_type')
      ? "LOWER(TRIM(COALESCE(o.deadline_type, 'fixed'))) IN ('rolling', 'ongoing') OR "
      : ''
    where.push(`(o.deadline IS NULL OR TRIM(CAST(o.deadline AS TEXT)) = '' OR ${rolling}DATE(o.deadline) >= CURRENT_DATE)`)
    appliedFilters.push('deadline_not_past')
  } else if (opportunityColumns.has('deadline_at')) {
    where.push("(o.deadline_at IS NULL OR TRIM(CAST(o.deadline_at AS TEXT)) = '' OR DATE(o.deadline_at) >= CURRENT_DATE)")
    appliedFilters.push('deadline_not_past')
  }
  if (opportunityColumns.has('link_status') && opportunityColumns.has('verification_error')) {
    where.push("NOT (LOWER(TRIM(COALESCE(o.link_status, ''))) = 'skipped' AND LOWER(COALESCE(o.verification_error, '')) LIKE 'retired_after_definitive_recheck:%')")
    appliedFilters.push('not_permanently_retired')
  }

  const from = `FROM profile_opportunity_matches m
      JOIN funding_opportunities o ON o.id = m.opportunity_id`
  const predicate = where.join('\n       AND ')
  // opportunity_kind / result_kind travel with the row so the classifier can
  // tell a POINTER (directory/referral/school_portal/past_award_intel) from
  // found funding (webparity-2). Absent columns read NULL → not a pointer.
  const sql = `
    SELECT o.id,
           ${selectOpportunityField('title')},
           ${selectOpportunityField('sponsor')},
           ${selectOpportunityField('application_url')},
           ${selectOpportunityField('apply_url')},
           ${selectOpportunityField('source_url')},
           ${selectOpportunityField('final_url')},
           ${selectOpportunityField('evidence_url')},
           ${selectOpportunityField('opportunity_kind')},
           ${selectOpportunityField('result_kind')},
           m.match_score
      ${from}
     WHERE ${predicate}
     ORDER BY ${order}
     LIMIT ${MAX_STORED_MATCHES}`

  const [rows, rawCountRow, eligibleCountRow] = await Promise.all([
    db.prepare(sql).all(profileId),
    db.prepare(`SELECT COUNT(*) AS n ${from} WHERE m.profile_id = ?`).get(profileId),
    db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${predicate}`).get(profileId),
  ])
  const rawCount = Math.max(0, Number(rawCountRow?.n ?? 0) || 0)
  const eligibleCount = Math.max(0, Number(eligibleCountRow?.n ?? 0) || 0)
  const lifecycleFields = [
    'is_active', 'is_hidden', 'status', 'link_status', 'verification_status',
    'reality_status', 'deadline_status', 'deadline', 'deadline_at', 'verification_error',
  ]
  return attachStoredSelectionMeta(rows, {
    raw_candidate_count: rawCount,
    eligible_candidate_count: eligibleCount,
    excluded_candidate_count: Math.max(0, rawCount - eligibleCount),
    returned_count: rows.length,
    truncated_count: Math.max(0, eligibleCount - rows.length),
    applied_filters: appliedFilters,
    unavailable_lifecycle_fields: lifecycleFields.filter((name) => !opportunityColumns.has(name)),
    match_decision_available: matchColumns.has('match_decision'),
  })
}

async function defaultEmitTelemetry(db, event) {
  try {
    const { insertActivityEvent } = await import('./agentTelemetry/agentTelemetryStore.js')
    await insertActivityEvent(db, event)
  } catch {
    /* telemetry is best-effort; never fail a benchmark on it */
  }
}

function searchProvenanceFor(results, queryIndex, thrown = false) {
  const meta = results?.searchMeta && typeof results.searchMeta === 'object'
    ? results.searchMeta
    : null
  const searxngMeta = results?.searxngMeta && typeof results.searxngMeta === 'object'
    ? results.searxngMeta
    : null
  const resultCount = Array.isArray(results) ? results.length : 0
  const hasCacheAge = meta?.cache_age_ms !== null && meta?.cache_age_ms !== undefined && Number.isFinite(Number(meta.cache_age_ms))
  return {
    query_index: queryIndex,
    result_count: resultCount,
    provider: String(meta?.provider || (searxngMeta ? 'searxng' : 'unknown')),
    provenance: String(meta?.provenance || (meta?.provider === 'cache' ? 'cache' : 'unknown')),
    status: String(meta?.status || (thrown ? 'error' : (resultCount > 0 ? 'ok' : 'empty'))),
    cache_age_ms: hasCacheAge ? Math.max(0, Number(meta.cache_age_ms)) : null,
    cache_age_known: hasCacheAge,
    provider_mode: meta?.provider_mode ?? null,
    provenance_reason: meta?.reason ?? null,
    result_engines: Array.isArray(searxngMeta?.result_engines) ? searxngMeta.result_engines : [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-result dispositions (issue 4): WHY is a web-only result still web-only?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The profile's last discovery-lane ledger, read through
 * coverageAudit/webLaneHealth.getLastWebLaneRun(db, profileId) (added by a
 * concurrent lane). Imported lazily and TOLERANTLY: when the export or the
 * record is absent the benchmark still runs and every affected web-only
 * result carries `lane_ledger_unavailable` with the reason — never a guess.
 */
async function defaultLoadLaneLedger(db, profileId) {
  let mod
  try {
    mod = await import('./coverageAudit/webLaneHealth.js')
  } catch (err) {
    return { available: false, reason: `web_lane_health_module_unavailable:${err?.message || err}` }
  }
  if (typeof mod?.getLastWebLaneRun !== 'function') {
    return { available: false, reason: 'getLastWebLaneRun_not_exported' }
  }
  try {
    const run = await mod.getLastWebLaneRun(db, profileId)
    if (!run || typeof run !== 'object') return { available: false, reason: 'no_lane_run_for_profile' }
    return { available: true, run }
  } catch (err) {
    return { available: false, reason: `lane_ledger_load_failed:${err?.message || err}` }
  }
}

/**
 * The lane's planned query set for this thesis. Prefers
 * webQueries.buildWebQueryPlan (added by a concurrent lane); until it exists,
 * falls back to the lane's own builder at lane breadth with seed 0 — labelled
 * `inferred`, because the lane rotates its broadening pool by wall clock, so
 * the fallback is the plan's fixed head plus one rotation, not the whole pool.
 */
async function defaultBuildQueryPlan(thesis) {
  try {
    const mod = await import('../crawler-os/webQueries.js')
    if (typeof mod?.buildWebQueryPlan === 'function') {
      return { ...normalizeQueryPlan(mod.buildWebQueryPlan(thesis)), source: 'buildWebQueryPlan', inferred: false }
    }
  } catch { /* fall through to the inferred plan */ }
  const { maxQueries } = webLaneDefaults()
  return {
    queries: buildWebQueries(thesis, { max: maxQueries, seed: 0 }),
    source: 'buildWebQueries_seed0_fallback',
    inferred: true,
  }
}

function queryKey(q) {
  return String(q || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeQueryPlan(plan) {
  if (Array.isArray(plan)) {
    return { queries: plan.map((q) => (typeof q === 'string' ? q : q?.query ?? q?.text ?? '')).filter(Boolean) }
  }
  if (plan && typeof plan === 'object') {
    const list = Array.isArray(plan.queries) ? plan.queries : (Array.isArray(plan.plan) ? plan.plan : [])
    return {
      ...plan,
      queries: list.map((q) => (typeof q === 'string' ? q : q?.query ?? q?.text ?? '')).filter(Boolean),
    }
  }
  return { queries: [] }
}

/**
 * Does the catalog already hold this program under ANOTHER URL? Looks up the
 * canonical identity's title tier (`t:<title>` or `t:<sponsor>::<title>` —
 * contract.canonicalOpportunityKey) for the hit's title; a SERP hit has no
 * structured sponsor so the sponsor-qualified form is matched by suffix.
 * Tolerant: a catalog without the column answers null (unknown), never false.
 */
async function defaultLookupCanonicalDuplicate(db, hit) {
  if (!db?.prepare) return null
  const titleKey = titleIdentityKey(hit?.title)
  if (!titleKey) return null
  const hitUrlKey = normalizeUrlKey(hit?.url)
  try {
    const columns = await tableColumnSet(db, 'funding_opportunities')
    if (!columns.has('canonical_opportunity_key')) return null
    const urlColumns = ['application_url', 'apply_url', 'source_url', 'final_url', 'evidence_url'].filter((c) => columns.has(c))
    const select = ['id', 'canonical_opportunity_key', ...urlColumns].join(', ')
    const rows = await db.prepare(
      `SELECT ${select} FROM funding_opportunities
        WHERE canonical_opportunity_key = ? OR canonical_opportunity_key LIKE ?
        LIMIT 5`,
    ).all(`t:${titleKey}`, `t:%::${titleKey}`)
    for (const row of Array.isArray(rows) ? rows : []) {
      const urls = urlColumns.map((c) => row[c]).filter(Boolean)
      const keys = urls.map(normalizeUrlKey).filter(Boolean)
      // Same URL would have been overlap already; a duplicate is the SAME key under a DIFFERENT url.
      if (keys.length === 0 || keys.some((k) => k !== hitUrlKey)) {
        return { opportunity_id: row.id, canonical_key: row.canonical_opportunity_key, url: urls.find((u) => normalizeUrlKey(u) !== hitUrlKey) ?? null }
      }
    }
    return null
  } catch {
    return null
  }
}

/** Tolerant reader for whatever shape the lane ledger records. */
function readLaneLedger(laneLedger, laneDefaults) {
  const available = laneLedger?.available === true && laneLedger.run && typeof laneLedger.run === 'object'
  const run = available ? laneLedger.run : null
  const asQueryList = (value) => (Array.isArray(value) ? value : [])
    .map((q) => (typeof q === 'string' ? q : q?.query ?? q?.text ?? ''))
    .filter(Boolean)
  // The REAL producer (coverageAudit/webLaneHealth.js buildWebLaneRunRecord)
  // nests these under query_ledger — `run.queries` is executed-only strings,
  // `run.skipped_budget` never exists at the top level. The bare top-level
  // guesses are kept as a tolerant fallback for other/legacy ledger shapes.
  const executed = new Set(asQueryList(run?.queries ?? run?.executed_queries ?? run?.queries_executed ?? run?.query_ledger?.executed).map(queryKey))
  const skipped = new Set(asQueryList(run?.skipped_budget ?? run?.query_ledger?.skipped_budget ?? run?.queries_skipped_budget ?? run?.skipped_queries).map(queryKey))
  for (const q of Array.isArray(run?.queries) ? run.queries : []) {
    if (q && typeof q === 'object' && /skipped/i.test(String(q.status || ''))) {
      skipped.add(queryKey(q.query ?? q.text))
      executed.delete(queryKey(q.query ?? q.text))
    }
  }
  const provenance = new Map()
  for (const entry of Array.isArray(run?.search_provenance) ? run.search_provenance : []) {
    const key = queryKey(entry?.query ?? entry?.text)
    if (key) provenance.set(key, entry)
  }
  const pages = new Map()
  const pageList = Array.isArray(run?.pages) ? run.pages : (Array.isArray(run?.page_ledger) ? run.page_ledger : (Array.isArray(run?.per_page) ? run.per_page : []))
  for (const page of pageList) {
    const key = normalizeUrlKey(page?.url ?? page?.final_url)
    if (key) pages.set(key, page)
    const finalKey = normalizeUrlKey(page?.final_url)
    if (finalKey && !pages.has(finalKey)) pages.set(finalKey, page)
  }
  const resultsPerQuery = envInt(run?.results_per_query ?? run?.resultsPerQuery, laneDefaults.resultsPerQuery)
  const maxPages = envInt(run?.max_pages ?? run?.maxPages, laneDefaults.maxPages)
  const fetched = Number(run?.fetched)
  const extracted = Number(run?.extracted)
  return {
    available,
    reason: available ? null : (laneLedger?.reason || 'lane_ledger_unavailable'),
    executedQueries: executed,
    skippedBudgetQueries: skipped,
    hasQueryList: executed.size > 0 || skipped.size > 0,
    provenance,
    pages,
    hasPageLedger: pageList.length > 0,
    resultsPerQuery,
    maxPages,
    // The lane's page queue fills after ~maxPages/resultsPerQuery queries;
    // a query positioned beyond that head is structurally never fetched.
    executedHeadQueries: Math.max(1, Math.floor(maxPages / Math.max(1, resultsPerQuery))),
    fetched: Number.isFinite(fetched) ? fetched : null,
    extracted: Number.isFinite(extracted) ? extracted : null,
    extractionDead: Number.isFinite(fetched) && fetched > 0 && Number.isFinite(extracted) && extracted === 0,
    at: run?.at ?? run?.recorded_at ?? null,
  }
}

function pageStatus(page) {
  const stage = String(page?.stage ?? page?.status ?? page?.outcome ?? '').trim().toLowerCase()
  if (page?.gate || /reject/.test(stage)) return { kind: 'gate_rejected', gate: gateFromReason(page?.gate ?? stage, page?.reason) }
  if (page?.fetched === false || SEED_OUTCOME_FETCH_FAILED.has(stage)) return { kind: 'fetch_failed' }
  if (SEED_OUTCOME_ADOPTED.has(stage) || page?.stored === true || page?.deduped === true) return { kind: 'in_catalog' }
  if (SEED_OUTCOME_EXTRACTION_FAILED.has(stage) || (page?.fetched === true && Number(page?.extracted) === 0)) return { kind: 'extraction_failed' }
  if (page?.fetched === true) return { kind: 'fetched_unresolved' }
  return { kind: 'unknown' }
}

/**
 * PURE: assign exactly one disposition to a web-only result from the evidence
 * available. Precedence (first match wins):
 *   1. the LANE's own search for the originating query failed         → provider_failure
 *   2. the originating query is outside the lane's plan                → never_generated_capable_query
 *   3. planned but skipped for budget, or at a rank / query position
 *      the lane structurally never reaches (webparity-6)               → generated_not_executed_cap
 *   4. the lane's per-page ledger names the page                       → fetch_failed | extraction_failed |
 *                                                                        correctly_rejected_at_gate:<g> | canonical_duplicate
 *   5. the gap queue records a VERDICT for the page                    → canonical_duplicate (adopted) |
 *                                                                        correctly_rejected_at_gate:<g> (gated_out WITH a gate)
 *      a legacy gated_out with NO gate record is NOT a verdict (noted in evidence)
 *   6. the lane fetched pages and extracted NOTHING this run           → extraction_failed (inferred, run-wide)
 *      then a queue `not_evaluated:*` class                            → fetch_failed / extraction_failed
 *   7. the catalog already holds the title under another URL           → canonical_duplicate
 *   8. the catalog holds the page as a POINTER                         → correctly_rejected_at_gate:apply_target
 *   9. no lane ledger                                                  → lane_ledger_unavailable
 *  10. otherwise                                                       → incorrectly_lost_qualified_source
 *
 * @param {{url, canonical_key?, query?, query_index?, rank?, catalog_pointer?}} item
 * @param {{plan?, laneLedger?, laneDefaults?, queueEntry?, catalogDuplicate?}} ctx
 * @returns {{disposition:string, evidence:object, structural:{rank_beyond_lane_head:boolean, query_beyond_page_budget:boolean|null}}}
 */
export function disposeWebOnlyHit(item, ctx = {}) {
  const laneDefaults = { ...webLaneDefaults(), ...(ctx.laneDefaults || {}) }
  const ledger = readLaneLedger(ctx.laneLedger, laneDefaults)
  const plan = ctx.plan && typeof ctx.plan === 'object' ? normalizeQueryPlan(ctx.plan) : null
  const planKeys = plan ? new Set(plan.queries.map(queryKey)) : null
  const qKey = queryKey(item?.query)
  const rank = Number.isFinite(Number(item?.rank)) ? Number(item.rank) : null
  const queryIndex = Number.isFinite(Number(item?.query_index)) ? Number(item.query_index) : null
  const urlKey = item?.canonical_key || normalizeUrlKey(item?.url)

  const rankBeyondHead = rank !== null && rank > ledger.resultsPerQuery
  const queryBeyondBudget = queryIndex !== null ? queryIndex >= ledger.executedHeadQueries : null
  const structural = { rank_beyond_lane_head: rankBeyondHead, query_beyond_page_budget: queryBeyondBudget }
  const evidence = {
    query: item?.query ?? null,
    query_index: queryIndex,
    rank,
    lane_results_per_query: ledger.resultsPerQuery,
    lane_max_pages: ledger.maxPages,
    lane_ledger_available: ledger.available,
    lane_ledger_reason: ledger.reason,
    plan_source: plan?.source ?? null,
    plan_inferred: plan?.inferred ?? null,
    structural,
  }
  const done = (disposition, extra = {}) => ({ disposition, evidence: { ...evidence, ...extra }, structural })

  // 1. the lane's own search failed for this query
  const laneProv = qKey ? ledger.provenance.get(qKey) : null
  if (laneProv && ['error', 'unavailable', 'not_attempted'].includes(String(laneProv.status || '').toLowerCase())) {
    return done('provider_failure', { lane_search_status: laneProv.status, lane_search_provider: laneProv.provider ?? null })
  }
  // 2. never planned
  if (planKeys && qKey && !planKeys.has(qKey)) {
    return done('never_generated_capable_query', { plan_size: planKeys.size })
  }
  // 3. planned but not executed / structurally unreachable
  if (ledger.available && ledger.hasQueryList && qKey && (ledger.skippedBudgetQueries.has(qKey) || !ledger.executedQueries.has(qKey))) {
    return done('generated_not_executed_cap', { skipped_budget: ledger.skippedBudgetQueries.has(qKey), lane_executed_queries: ledger.executedQueries.size })
  }
  if (rankBeyondHead) return done('generated_not_executed_cap', { skipped_budget: false, reason: 'rank_beyond_lane_head' })
  if (queryBeyondBudget === true && !(ledger.available && ledger.hasQueryList)) {
    return done('generated_not_executed_cap', { skipped_budget: false, reason: 'query_beyond_page_budget' })
  }
  // 4. the per-page ledger names the page
  const page = urlKey ? ledger.pages.get(urlKey) : null
  if (page) {
    const status = pageStatus(page)
    if (status.kind === 'fetch_failed') return done('fetch_failed', { lane_page: page.reason ?? page.status ?? 'fetch_failed' })
    if (status.kind === 'gate_rejected') return done(`correctly_rejected_at_gate:${status.gate}`, { gate: status.gate, gate_reason: page.reason ?? null, source: 'lane_page_ledger' })
    if (status.kind === 'in_catalog') return done('canonical_duplicate', { reason: 'stored_under_other_url', lane_page: page.stage ?? page.status ?? null })
    if (status.kind === 'extraction_failed') return done('extraction_failed', { source: 'lane_page_ledger' })
  }
  // 5. the queue's RECORDED verdict for this page (per-URL evidence outranks
  //    the run-wide inference below; a legacy gated_out with no gate does not)
  const queueEntry = ctx.queueEntry && typeof ctx.queueEntry === 'object' ? ctx.queueEntry : null
  const queueStatus = queueEntry ? normalizeGapStatus(queueEntry.status) : null
  let legacyGatedOut = false
  if (queueEntry) {
    if (queueStatus === 'adopted') {
      return done('canonical_duplicate', {
        reason: 'adopted_under_other_url',
        queue_resolved_at: queueEntry.resolved_at ?? null,
        catalog_confirmed: Boolean(ctx.catalogDuplicate),
        ...(ctx.catalogDuplicate ? { catalog: ctx.catalogDuplicate } : {}),
      })
    }
    if (queueStatus === 'gated_out') {
      const gate = GATE_NAMES.includes(String(queueEntry.gate || '').toLowerCase()) ? String(queueEntry.gate).toLowerCase() : null
      if (gate) return done(`correctly_rejected_at_gate:${gate}`, { gate, gate_reason: queueEntry.gate_reason ?? null, source: 'gap_queue', queue_resolved_at: queueEntry.resolved_at ?? null })
      legacyGatedOut = true
    }
  }
  // 6. run-wide dead extraction: the lane fetched pages and extracted NOTHING
  if (ledger.available && ledger.extractionDead) {
    return done('extraction_failed', {
      inferred_from: 'lane_run_totals',
      fetched: ledger.fetched,
      extracted: ledger.extracted,
      lane_run_at: ledger.at,
      queue_status: queueStatus,
      ...(legacyGatedOut ? { legacy_gated_out_without_gate_record: true } : {}),
    })
  }
  if (queueEntry) {
    if (queueStatus && queueStatus.startsWith(NOT_EVALUATED_PREFIX)) {
      const cls = queueEntry.not_evaluated_class || queueStatus.slice(NOT_EVALUATED_PREFIX.length)
      if (cls === 'fetch_failed') return done('fetch_failed', { source: 'gap_queue', offered_at: queueEntry.offered_at ?? null })
      if (cls === 'extraction_failed') return done('extraction_failed', { source: 'gap_queue', offered_at: queueEntry.offered_at ?? null })
    }
  }
  // 7. the catalog already holds the program under another URL
  if (ctx.catalogDuplicate && typeof ctx.catalogDuplicate === 'object') {
    return done('canonical_duplicate', { reason: 'catalog_title_identity', catalog: ctx.catalogDuplicate })
  }
  // 8. the catalog holds the page as a pointer: no apply target of its own
  if (item?.catalog_pointer && typeof item.catalog_pointer === 'object') {
    return done('correctly_rejected_at_gate:apply_target', { gate: 'apply_target', source: 'catalog_pointer_kind', catalog_pointer: item.catalog_pointer })
  }
  // 9. no ledger — the miss cannot be attributed
  if (!ledger.available) {
    return done('lane_ledger_unavailable', {
      reason: ledger.reason,
      queue_status: queueStatus,
      ...(legacyGatedOut ? { legacy_gated_out_without_gate_record: true } : {}),
    })
  }
  // 10. the true recall gap
  return done('incorrectly_lost_qualified_source', {
    queue_status: queueStatus,
    ...(legacyGatedOut ? { legacy_gated_out_without_gate_record: true } : {}),
  })
}

function tallyDispositions(items) {
  const counts = {}
  for (const item of Array.isArray(items) ? items : []) {
    const d = item?.disposition || 'undisposed'
    counts[d] = (counts[d] || 0) + 1
  }
  return counts
}

/**
 * Provider health for the run's metric envelope, from the per-query search
 * provenance of every profile plus each profile's lane-ledger availability.
 * "All cache at unknown age" is a FLAG: the run measured a replayed SERP whose
 * age nothing recorded, so it cannot be read as tonight's web.
 */
export function buildProviderHealth(perProfile = [], { laneLedgers = [] } = {}) {
  const entries = (Array.isArray(perProfile) ? perProfile : [])
    .flatMap((p) => (Array.isArray(p?.search_provenance) ? p.search_provenance : []))
  const total = entries.length
  const failed = entries.filter((e) => ['error', 'unavailable', 'not_attempted'].includes(String(e?.status || '').toLowerCase())).length
  const cached = entries.filter((e) => String(e?.provenance || '').toLowerCase() === 'cache').length
  const cacheUnknownAge = entries.filter((e) => String(e?.provenance || '').toLowerCase() === 'cache' && e?.cache_age_known !== true).length
  const providers = {}
  for (const e of entries) providers[String(e?.provider || 'unknown')] = (providers[String(e?.provider || 'unknown')] || 0) + 1
  const flags = []
  let search = 'unknown'
  if (total > 0) {
    if (failed === total) search = 'unavailable'
    else if (failed > 0) search = 'degraded'
    else search = 'healthy'
    if (cached === total) {
      flags.push('search_all_cache')
      if (search === 'healthy') search = 'degraded'
    }
    if (cached > 0 && cacheUnknownAge === cached) flags.push('search_all_cache_unknown_age')
    else if (cacheUnknownAge > 0) flags.push('search_cache_age_partially_unknown')
  }
  const ledgers = Array.isArray(laneLedgers) ? laneLedgers : []
  const ledgerAvailable = ledgers.filter((l) => l?.available === true).length
  const laneLedger = ledgers.length === 0 ? 'unknown' : (ledgerAvailable === ledgers.length ? 'available' : (ledgerAvailable === 0 ? 'unavailable' : 'partial'))
  if (laneLedger === 'unavailable') flags.push('lane_ledger_unavailable')
  const dead = ledgers.filter((l) => l?.available === true && readLaneLedger(l, webLaneDefaults()).extractionDead).length
  let extraction = 'unknown'
  if (ledgerAvailable > 0) extraction = dead === ledgerAvailable ? 'unavailable' : (dead > 0 ? 'degraded' : 'healthy')
  if (extraction === 'unavailable') flags.push('extraction_unavailable')
  return {
    search,
    extraction,
    lane_ledger: laneLedger,
    flags,
    detail: {
      queries: total,
      failed_queries: failed,
      cache_queries: cached,
      cache_unknown_age_queries: cacheUnknownAge,
      providers,
      lane_ledgers: ledgers.length,
      lane_ledgers_available: ledgerAvailable,
      lane_ledger_reasons: [...new Set(ledgers.filter((l) => l?.available !== true).map((l) => l?.reason).filter(Boolean))].slice(0, 4),
    },
  }
}

/**
 * Fold profile-level observations into the versioned fleet sample contract.
 * Exported so the weighting/qualification boundary can be regression-tested
 * without a network search.
 */
export function computeFleetParitySample(perProfile = []) {
  const profiles = Array.isArray(perProfile) ? perProfile : []
  const scored = profiles.filter((profile) => Number.isFinite(profile?.parity))
  const profilesUnscored = profiles.length - scored.length
  const scoredProfilesParity = scored.length
    ? Math.round((scored.reduce((sum, profile) => sum + profile.parity, 0) / scored.length) * 10) / 10
    : null
  const measurementStatus = profiles.length > 0 && scored.length === profiles.length
    ? 'scored'
    : (scored.length > 0 ? 'partial' : 'unscored')
  const verifiedDenominator = scored.reduce(
    (total, profile) => total + Number(profile.overlap_count || 0) + Number(profile.web_only_count || 0),
    0,
  )
  const sampleQualified = measurementStatus === 'scored' && verifiedDenominator >= MIN_VERIFIED_DENOMINATOR
  const overlapTotal = scored.reduce((total, profile) => total + Number(profile.overlap_count || 0), 0)
  const weightedFleetParity = verifiedDenominator > 0
    ? Math.round((overlapTotal / verifiedDenominator) * 1000) / 10
    : null

  return {
    scored,
    profiles_unscored: profilesUnscored,
    scored_profiles_parity: scoredProfilesParity,
    measurement_status: measurementStatus,
    verified_denominator: verifiedDenominator,
    sample_qualified: sampleQualified,
    // A fleet number exists only when it is safe to publish as a fleet number.
    fleet_parity: sampleQualified ? weightedFleetParity : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The benchmark run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the Google-bar benchmark for the golden profiles.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string[]} [opts.profileIds]   restrict to these golden profile ids
 * @param {Function} [opts.searchWeb]    injectable (query,{count}) → [{url,title,snippet}]
 * @param {Function} [opts.loadGolden]   injectable db → [{profile_id,label,require_sources}]
 * @param {Function} [opts.buildThesis]  injectable (db,profileId) → thesis|null
 * @param {Function} [opts.loadStoredMatches] injectable (db,profileId) → rows
 * @param {Function} [opts.emitTelemetry]
 * @param {number}   [opts.maxQueriesPerProfile] clamped to ≤ MAX_QUERIES_PER_PROFILE
 * @param {number}   [opts.maxResultsPerQuery]   clamped to ≤ MAX_RESULTS_PER_QUERY
 * @param {boolean}  [opts.persist=true]
 * @param {Date}     [opts.now]
 * @returns {Promise<object>} run summary { ran, fleet_parity, per_profile, gap_queue, … }
 */
export async function runWebParityBenchmark(db, {
  profileIds = null,
  searchWeb = defaultSearchWeb,
  loadGolden = defaultLoadGolden,
  buildThesis = defaultBuildThesis,
  loadStoredMatches = defaultLoadStoredMatches,
  emitTelemetry = defaultEmitTelemetry,
  loadLaneLedger = defaultLoadLaneLedger,
  buildQueryPlan = defaultBuildQueryPlan,
  lookupCanonicalDuplicate = defaultLookupCanonicalDuplicate,
  maxQueriesPerProfile = MAX_QUERIES_PER_PROFILE,
  maxResultsPerQuery = MAX_RESULTS_PER_QUERY,
  persist = true,
  now = new Date(),
} = {}) {
  if (!isWebParityBenchmarkEnabled()) return { ran: false, reason: 'disabled' }
  if (!db?.prepare) return { ran: false, reason: 'no_db' }
  const laneDefaults = webLaneDefaults()

  // Budget bounds are MANDATORY — a caller can narrow them, never widen them.
  const queryBudget = Math.max(1, Math.min(MAX_QUERIES_PER_PROFILE, Number(maxQueriesPerProfile) || MAX_QUERIES_PER_PROFILE))
  const resultBudget = Math.max(1, Math.min(MAX_RESULTS_PER_QUERY, Number(maxResultsPerQuery) || MAX_RESULTS_PER_QUERY))

  let golden = []
  try {
    golden = await loadGolden(db)
  } catch (err) {
    return { ran: false, reason: 'golden_load_failed', error: String(err?.message || err) }
  }
  if (Array.isArray(profileIds) && profileIds.length) {
    const want = new Set(profileIds.map(String))
    golden = golden.filter((g) => want.has(String(g.profile_id)))
  }
  if (golden.length === 0) {
    // HONEST: no golden profiles means the benchmark cannot measure anything —
    // do not persist a hollow "green" run; Sam's never-run alert points here.
    return { ran: false, reason: 'no_golden_profiles' }
  }

  const generatedAt = (now instanceof Date ? now : new Date(now)).toISOString()
  const perProfile = []
  const gapEntries = []
  const laneLedgers = []

  for (const g of golden) {
    const label = g.label || g.profile_id
    let thesis = null
    try {
      thesis = await buildThesis(db, g.profile_id)
    } catch (err) {
      log.warn('thesis build failed for golden profile', { profile_id: g.profile_id, error: err?.message })
    }
    if (!thesis) {
      perProfile.push({ profile_id: g.profile_id, label, parity: null, error: 'profile_not_discoverable' })
      continue
    }

    // "<need> grants <state> 2026"-class queries via the canonical machinery
    // (buildWebQueries CORE tier = the highest-signal need/geo queries).
    const queries = buildWebQueries(thesis, { max: queryBudget, seed: 0 }).slice(0, queryBudget)

    const hits = []
    const seenUrls = new Set()
    let searchErrors = 0
    const searchProvenance = []
    for (const [queryIndex, q] of queries.entries()) {
      let results = []
      let threw = false
      try {
        results = await searchWeb(q, { count: resultBudget })
      } catch (err) {
        searchErrors += 1
        threw = true
        log.warn('benchmark web search failed (non-fatal)', { query: q, error: err?.message })
        results = []
      }
      searchProvenance.push(searchProvenanceFor(results, queryIndex, threw))
      const page = (Array.isArray(results) ? results : []).slice(0, resultBudget)
      for (const [rankIndex, h] of page.entries()) {
        const key = normalizeUrlKey(h?.url)
        if (!key || seenUrls.has(key)) continue
        seenUrls.add(key)
        // Provenance for the disposition machinery: which query surfaced the
        // page and at what rank (webparity-6: ranks past the lane's per-query
        // head are structurally unreachable by discovery).
        hits.push({ ...h, query: q, query_index: queryIndex, rank: rankIndex + 1 })
      }
    }

    let stored = []
    let storedSelection = null
    let storedLoadError = null
    try {
      const loaded = await loadStoredMatches(db, g.profile_id)
      if (Array.isArray(loaded)) {
        stored = loaded
        storedSelection = loaded.selectionMeta ?? null
      } else if (Array.isArray(loaded?.rows)) {
        stored = loaded.rows
        storedSelection = loaded.meta ?? null
      } else {
        throw new Error('stored-match loader returned a non-array result')
      }
    } catch (err) {
      log.warn('stored-match load failed for golden profile', { profile_id: g.profile_id, error: err?.message })
      stored = []
      storedLoadError = 'stored_match_load_failed'
    }

    const needs = Array.isArray(thesis.needs) ? thesis.needs : []
    const applicantTypes = Array.isArray(thesis.applicant_types)
      ? thesis.applicant_types
      : (Array.isArray(thesis.applicantTypes) ? thesis.applicantTypes : [])
    const profileState = thesis?.location?.state ?? null
    const classification = classifyWebResults(hits, stored, {
      needs,
      state: profileState,
      applicantTypes,
    })
    const { overlap, web_only, grantflow_only, web_real } = classification
    const providerUnavailable = searchProvenance.length > 0 && searchProvenance.every(
      (entry) => ['error', 'unavailable', 'not_attempted'].includes(entry.status),
    )
    let measurementError = storedLoadError
    if (!measurementError && queries.length === 0) measurementError = 'no_search_queries'
    if (!measurementError && web_real === 0) {
      measurementError = hits.length === 0
        ? (providerUnavailable ? 'web_search_provider_unavailable' : 'web_search_returned_zero_results')
        : 'web_search_returned_no_eligible_results'
    }
    const parity = measurementError ? null : parityScore(overlap.length, web_only.length)
    const providerCounts = searchProvenance.reduce((counts, entry) => {
      counts[entry.provider] = (counts[entry.provider] || 0) + 1
      return counts
    }, {})
    const storedRawCount = storedSelection?.raw_candidate_count ?? null
    const storedEligibleCount = storedSelection?.eligible_candidate_count ?? null
    const storedExcludedCount = storedSelection?.excluded_candidate_count ?? null

    // ── Dispositions: WHY is each web-only result still web-only? ─────────
    // Evidence: the lane's last ledger for this profile (tolerant), the lane's
    // planned query set, the gap queue's recorded verdicts, and the catalog's
    // canonical identity. Every failure to load evidence degrades to an
    // honest `lane_ledger_unavailable` / null, never to a guess.
    let laneLedger = { available: false, reason: 'lane_ledger_not_loaded' }
    try {
      laneLedger = (await loadLaneLedger(db, g.profile_id)) || { available: false, reason: 'lane_ledger_loader_returned_nothing' }
    } catch (err) {
      laneLedger = { available: false, reason: `lane_ledger_load_failed:${err?.message || err}` }
    }
    laneLedgers.push(laneLedger)
    let plan = null
    try {
      plan = normalizeQueryPlan(await buildQueryPlan(thesis))
      if (plan && !plan.source) plan.source = 'injected'
    } catch (err) {
      log.warn('query plan build failed for golden profile (dispositions degrade)', { profile_id: g.profile_id, error: err?.message })
      plan = null
    }
    let queueByKey = new Map()
    try {
      const queue = await readWebParityGapQueue(db)
      queueByKey = new Map(queue
        .filter((c) => String(c?.profile_id) === String(g.profile_id))
        .map((c) => [normalizeUrlKey(c?.url), c])
        .filter(([key]) => key))
    } catch { queueByKey = new Map() }
    const webOnlyDisposed = []
    for (const item of web_only.slice(0, WEB_ONLY_DISPOSITION_CAP)) {
      let catalogDuplicate = null
      try {
        catalogDuplicate = await lookupCanonicalDuplicate(db, item)
      } catch { catalogDuplicate = null }
      const decided = disposeWebOnlyHit(item, {
        plan,
        laneLedger,
        laneDefaults,
        queueEntry: queueByKey.get(item.canonical_key) || null,
        catalogDuplicate,
      })
      webOnlyDisposed.push({ ...item, disposition: decided.disposition, evidence: decided.evidence })
    }
    const dispositionCounts = tallyDispositions(webOnlyDisposed)
    const structurallyUnreachable = {
      rank_beyond_lane_head: webOnlyDisposed.filter((w) => w.evidence?.structural?.rank_beyond_lane_head === true).length,
      query_beyond_page_budget: webOnlyDisposed.filter((w) => w.evidence?.structural?.query_beyond_page_budget === true).length,
      lane_results_per_query: readLaneLedger(laneLedger, laneDefaults).resultsPerQuery,
      benchmark_results_per_query: resultBudget,
    }

    perProfile.push({
      profile_id: g.profile_id,
      label,
      parity,
      measurement_status: Number.isFinite(parity) ? 'scored' : 'unscored',
      error: Number.isFinite(parity) ? null : (measurementError || 'no_measured_denominator'),
      overlap_count: storedLoadError ? null : overlap.length,
      web_only_count: storedLoadError ? null : web_only.length,
      grantflow_only: storedLoadError ? null : grantflow_only,
      stored_matches: Array.isArray(stored) ? stored.length : 0,
      stored_pointer_rows: classification.stored_pointer_rows ?? 0,
      web_dropped: classification.dropped ?? null,
      // Per-result dispositions (bounded to the session budget) + their tally.
      web_only: storedLoadError ? [] : webOnlyDisposed,
      disposition_counts: storedLoadError ? {} : dispositionCounts,
      structurally_unreachable: structurallyUnreachable,
      lane_ledger: { available: laneLedger.available === true, reason: laneLedger.available === true ? null : (laneLedger.reason ?? null), at: laneLedger.run?.at ?? null },
      query_plan: plan ? { source: plan.source ?? null, inferred: plan.inferred ?? null, size: plan.queries.length } : null,
      stored_candidates_total: storedRawCount,
      stored_candidates_eligible: storedEligibleCount,
      stored_candidates_excluded: storedExcludedCount,
      stored_candidates_truncated: storedSelection?.truncated_count ?? null,
      stored_selection_unknown: storedSelection === null,
      stored_filter_fields: storedSelection?.applied_filters ?? [],
      stored_unavailable_lifecycle_fields: storedSelection?.unavailable_lifecycle_fields ?? [],
      web_results: hits.length,
      web_real,
      queries_run: queries.length,
      search_errors: searchErrors,
      search_queries_with_results: searchProvenance.filter((entry) => entry.result_count > 0).length,
      search_empty_queries: searchProvenance.filter((entry) => entry.status === 'empty').length,
      search_unavailable_queries: searchProvenance.filter((entry) => ['error', 'unavailable', 'not_attempted'].includes(entry.status)).length,
      search_provider_counts: providerCounts,
      search_unknown_provenance_count: searchProvenance.filter((entry) => entry.provider === 'unknown').length,
      search_cache_hits: searchProvenance.filter((entry) => entry.provenance === 'cache').length,
      search_provenance: searchProvenance,
      // Retained for existing reports. Unlike the old behavior, this condition
      // now makes the profile unscored and cannot inflate fleet parity.
      web_outage_suspected: hits.length === 0,
      web_provider_unavailable: providerUnavailable,
      web_only_top: storedLoadError ? [] : web_only.slice(0, WEB_ONLY_TOP_CAP),
    })

    if (Number.isFinite(parity)) {
      for (const w of webOnlyDisposed) {
        gapEntries.push({
          url: w.url,
          title: w.title,
          profile_id: g.profile_id,
          need: w.need,
          domain: w.domain,
          canonical_key: w.canonical_key,
          disposition: w.disposition,
          disposition_evidence: w.evidence,
        })
      }
      for (const w of web_only.slice(WEB_ONLY_DISPOSITION_CAP)) {
        gapEntries.push({ url: w.url, title: w.title, profile_id: g.profile_id, need: w.need, domain: w.domain, canonical_key: w.canonical_key })
      }
    }
  }

  const fleetSample = computeFleetParitySample(perProfile)
  const scored = fleetSample.scored
  const unscored = fleetSample.profiles_unscored
  const scoredProfilesParity = fleetSample.scored_profiles_parity
  const measurementStatus = fleetSample.measurement_status
  const verifiedDenominator = fleetSample.verified_denominator
  const sampleQualified = fleetSample.sample_qualified
  // Weight the fleet by the evidence behind each profile. An arithmetic mean
  // lets a one-result profile move the headline as much as a deeply measured
  // profile and is therefore not a stable fleet statistic. `fleet_parity` is
  // deliberately null until the complete cohort also clears the denominator
  // floor, so no consumer can accidentally publish an underpowered number.
  const fleetParity = fleetSample.fleet_parity
  const sampleStatus = measurementStatus === 'scored' && !sampleQualified
    ? 'insufficient_sample'
    : measurementStatus

  // Fleet-level disposition tally + the metric envelope every owner-facing
  // benchmark number must carry (window = this run, population = the golden
  // profiles, provider health incl. SERP-cache provenance, code version).
  const fleetDispositionCounts = tallyDispositions(perProfile.flatMap((p) => (Array.isArray(p.web_only) ? p.web_only : [])))
  const providerHealth = buildProviderHealth(perProfile, { laneLedgers })
  const envelope = buildMetricEnvelope({
    window: { kind: 'run', start: generatedAt, end: generatedAt, label: 'web-parity benchmark run' },
    population: {
      kind: 'golden_profiles',
      description: `golden_outcome_expectations profiles (N=${perProfile.length})`,
      selector: GOLDEN_KV_KEY,
    },
    evaluated: scored.length,
    unevaluated: unscored,
    sampleSize: verifiedDenominator,
    providerHealth,
    freshnessAt: generatedAt,
    extra: {
      semantics_version: BENCHMARK_SEMANTICS_VERSION,
      minimum_verified_denominator: MIN_VERIFIED_DENOMINATOR,
      regression_points: REGRESSION_POINTS,
      queries_per_profile: queryBudget,
      results_per_query: resultBudget,
      disposition_counts: fleetDispositionCounts,
    },
  })

  const result = {
    ran: true,
    generated_at: generatedAt,
    semantics_version: BENCHMARK_SEMANTICS_VERSION,
    fleet_parity: fleetParity,
    qualified_fleet_parity: fleetParity,
    scored_profiles_parity: scoredProfilesParity,
    measurement_status: measurementStatus,
    sample_status: sampleStatus,
    sample_qualified: sampleQualified,
    verified_denominator: verifiedDenominator,
    minimum_verified_denominator: MIN_VERIFIED_DENOMINATOR,
    profiles_total: perProfile.length,
    profiles_scored: scored.length,
    profiles_unscored: unscored,
    disposition_counts: fleetDispositionCounts,
    envelope,
    per_profile: perProfile,
    gap_queue: { appended: 0, total: 0 },
  }

  if (persist) {
    try {
      const prior = (await readWebParityBenchmark(db)) || {}
      const runs = Array.isArray(prior.runs) ? prior.runs : []
      const compactRun = {
        generated_at: generatedAt,
        semantics_version: BENCHMARK_SEMANTICS_VERSION,
        measurement_status: measurementStatus,
        sample_status: sampleStatus,
        sample_qualified: sampleQualified,
        verified_denominator: verifiedDenominator,
        minimum_verified_denominator: MIN_VERIFIED_DENOMINATOR,
        profiles_total: perProfile.length,
        profiles_scored: scored.length,
        profiles_unscored: unscored,
        scored_profiles_parity: scoredProfilesParity,
        disposition_counts: fleetDispositionCounts,
        envelope,
        per_profile: perProfile.map((p) => ({
          profile_id: p.profile_id,
          label: p.label,
          parity: p.parity,
          measurement_status: p.measurement_status,
          error: p.error ?? null,
          overlap_count: p.overlap_count ?? null,
          web_only_count: p.web_only_count ?? null,
          grantflow_only: p.grantflow_only ?? null,
          stored_pointer_rows: p.stored_pointer_rows ?? 0,
          disposition_counts: p.disposition_counts ?? {},
        })),
      }
      if (Number.isFinite(fleetParity)) compactRun.fleet_parity = fleetParity
      if (Number.isFinite(fleetParity)) compactRun.qualified_fleet_parity = fleetParity
      runs.push(compactRun)
      const latest = {
        generated_at: generatedAt,
        semantics_version: BENCHMARK_SEMANTICS_VERSION,
        measurement_status: measurementStatus,
        sample_status: sampleStatus,
        sample_qualified: sampleQualified,
        verified_denominator: verifiedDenominator,
        minimum_verified_denominator: MIN_VERIFIED_DENOMINATOR,
        profiles_total: perProfile.length,
        profiles_scored: scored.length,
        profiles_unscored: unscored,
        scored_profiles_parity: scoredProfilesParity,
        disposition_counts: fleetDispositionCounts,
        envelope,
        per_profile: perProfile,
      }
      if (Number.isFinite(fleetParity)) latest.fleet_parity = fleetParity
      if (Number.isFinite(fleetParity)) latest.qualified_fleet_parity = fleetParity
      const store = {
        generated_at: generatedAt,
        runs: runs.slice(-MAX_RUN_HISTORY),
        latest,
      }
      await kvSet(db, KV_KEY, store, generatedAt)
    } catch (err) {
      log.warn('benchmark persist failed (result still returned)', { error: err?.message })
    }
    try {
      result.gap_queue = await appendGapCandidates(db, gapEntries, {
        now,
        // An unscored/provider-outage profile has no current evidence with
        // which to refresh its prior candidates.
        profileIds: scored.map((profile) => profile.profile_id),
      })
      // Terminal rows (adopted / gated_out / exhausted) are kept verbatim by
      // appendGapCandidates; stamp this run's disposition onto EVERY queued
      // web-only candidate so the queue can tell a real gate rejection from
      // an extraction failure or an identity loss.
      const stamped = await recordGapCandidateDispositions(
        db,
        gapEntries.filter((entry) => entry.disposition).map((entry) => ({
          profile_id: entry.profile_id,
          url: entry.url,
          canonical_key: entry.canonical_key,
          disposition: entry.disposition,
          evidence: entry.disposition_evidence ?? null,
        })),
        { now },
      )
      result.gap_queue = { ...result.gap_queue, dispositions_recorded: stamped.updated }
    } catch (err) {
      log.warn('gap-queue append failed (non-fatal)', { error: err?.message })
    }
  }

  await emitTelemetry(db, {
    agent_name: 'sam',
    event_type: 'sam.web_parity_benchmark',
    status: measurementStatus === 'scored' ? 'succeeded' : 'failed',
    severity: measurementStatus === 'unscored' ? 'high' : (measurementStatus === 'partial' ? 'medium' : 'info'),
    title: measurementStatus === 'scored'
      ? (sampleQualified
          ? `Google-bar benchmark: qualified fleet parity ${fleetParity} across ${verifiedDenominator} verified result(s)`
          : `Google-bar benchmark measured but below trend threshold: ${verifiedDenominator}/${MIN_VERIFIED_DENOMINATOR} verified result(s)`)
      : (measurementStatus === 'partial'
          ? `Google-bar benchmark partial: ${scored.length}/${perProfile.length} profile(s) scored (measured subset ${scoredProfilesParity}; no fleet score)`
          : `Google-bar benchmark unscored: 0/${perProfile.length} golden profile(s) produced a valid comparison`),
    metric_key: 'fleet_parity',
    metric_value: Number.isFinite(fleetParity) ? fleetParity : null,
    entity_type: 'web_parity_benchmark',
    entity_id: generatedAt,
    details_json: {
      fleet_parity: fleetParity,
      qualified_fleet_parity: fleetParity,
      measurement_status: measurementStatus,
      sample_status: sampleStatus,
      sample_qualified: sampleQualified,
      semantics_version: BENCHMARK_SEMANTICS_VERSION,
      verified_denominator: verifiedDenominator,
      minimum_verified_denominator: MIN_VERIFIED_DENOMINATOR,
      profiles_total: perProfile.length,
      profiles_scored: scored.length,
      profiles_unscored: unscored,
      scored_profiles_parity: scoredProfilesParity,
      disposition_counts: fleetDispositionCounts,
      provider_health: providerHealth,
      profiles: perProfile.map((p) => ({ profile_id: p.profile_id, parity: p.parity, web_only: p.web_only_count ?? 0, disposition_counts: p.disposition_counts ?? {} })),
      gap_queue: result.gap_queue,
    },
  })

  return result
}

export default {
  KV_KEY,
  GAP_QUEUE_KV_KEY,
  GOLDEN_KV_KEY,
  MAX_QUERIES_PER_PROFILE,
  MAX_RESULTS_PER_QUERY,
  MAX_RUN_HISTORY,
  STALE_MS,
  BENCHMARK_SEMANTICS_VERSION,
  MIN_VERIFIED_DENOMINATOR,
  GAP_SEED_MAX_OFFERS,
  NOT_EVALUATED_RESEED_COOLDOWN_MS,
  WEB_ONLY_DISPOSITIONS,
  GATE_NAMES,
  computeFleetParitySample,
  REGRESSION_POINTS,
  AGGREGATOR_NOISE_DOMAINS,
  isWebParityBenchmarkEnabled,
  normalizeUrlKey,
  isExcludedNoiseUrl,
  isRealFundingHit,
  isForeignGovernmentHit,
  isBenchmarkRelevantHit,
  isGenericFundingPortalHit,
  isBenchmarkDirectFundingHit,
  parityScore,
  classifyWebResults,
  disposeWebOnlyHit,
  gateFromReason,
  buildProviderHealth,
  webLaneDefaults,
  readWebParityBenchmark,
  readWebParityGapQueue,
  appendGapCandidates,
  recordGapCandidateDispositions,
  markGapCandidateOutcomes,
  loadGapSeedPagesForProfile,
  isPendingGapStatus,
  runWebParityBenchmark,
}
