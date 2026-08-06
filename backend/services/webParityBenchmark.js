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
 * `fleet_parity` is omitted from a partial/unscored persisted snapshot; the
 * measured subset remains labeled as `scored_profiles_parity` with counts.
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
import {
  isSearchEngineUrl,
  isPlaceholderUrl,
  isNonActionableUrl,
  extractHostname,
} from '../config/urlRules.js'
import { detectForeignOpportunity } from '../config/opportunityJurisdiction.js'
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

/** A benchmark older than this is STALE for Sam (nightly cadence; 8 days = a week of misses). */
export const STALE_MS = 8 * 24 * 60 * 60 * 1000

/** Fleet parity dropping more than this vs the PREVIOUS run is a regression (points on the 0–100 scale). */
export const REGRESSION_POINTS = 10

/** Top stored matches per profile compared against the web session. */
export const MAX_STORED_MATCHES = 50

/** Cap on the candidate gap queue (oldest entries beyond the cap are dropped). */
export const GAP_QUEUE_CAP = 200

/**
 * Seeds handed to ONE discovery run. Each seed costs a fetch + an LLM
 * extraction, so this is bounded like every other lane budget; leftovers stay
 * 'candidate' and are offered to the next run rather than dropped.
 */
export const GAP_SEED_LIMIT_PER_RUN = 8

/** Web-only finds carried per profile in `latest` (evidence + owner report). */
const WEB_ONLY_TOP_CAP = 20

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

  for (const need of normalizedNeeds) {
    if (need.length >= 3 && text.toLowerCase().includes(need.toLowerCase())) return true
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
const GENERIC_GRANTS_GOV_PATH_RE =
  /^\/(?:$|search-grants\/?$|learn-grants(?:\/.*)?$|applicants(?:\/.*)?$|grantors(?:\/.*)?$|support(?:\/.*)?$)/i

/** A portal can contain real opportunities without itself being one. */
export function isGenericFundingPortalHit(hit) {
  const url = String(hit?.url || '').trim()
  const domain = extractHostname(url)
  const title = String(hit?.title || '').trim()
  if (GENERIC_PORTAL_TITLE_RE.test(title)) return true
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

/** Normalized URL identity: protocol/www/hash/trailing-slash insensitive. */
export function normalizeUrlKey(url) {
  const s = String(url || '').trim().toLowerCase()
  if (!/^https?:\/\//.test(s)) return ''
  return s
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
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
  if (!/^https?:\/\//i.test(url)) return false
  if (isSearchEngineUrl(url) || isPlaceholderUrl(url) || isNonActionableUrl(url)) return false
  const domain = extractHostname(url)
  if (
    !domain ||
    [...AGGREGATOR_NOISE_DOMAINS].some(
      (noiseDomain) => domain === noiseDomain || domain.endsWith('.' + noiseDomain),
    )
  ) return false
  const text = `${hit?.title ?? ''} ${hit?.snippet ?? ''} ${url}`
  return FUNDING_SIGNAL_RE.test(text)
}

/** parity points (0–100). No measured web denominator is unscored, not 100. */
export function parityScore(overlapCount, webOnlyCount) {
  const o = Math.max(0, Number(overlapCount) || 0)
  const w = Math.max(0, Number(webOnlyCount) || 0)
  if (o + w === 0) return null
  return Math.round((o / (o + w)) * 1000) / 10
}

/** First profile need mentioned in the hit's text (honest attribution; may be null). */
function needForHit(hit, needs = []) {
  const text = `${hit?.title ?? ''} ${hit?.snippet ?? ''}`.toLowerCase()
  for (const n of Array.isArray(needs) ? needs : []) {
    const h = String(n || '').replace(/_/g, ' ').trim().toLowerCase()
    if (h && text.includes(h)) return h
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
  const storedUrlKeys = new Set()
  const storedRows = stored.map((m) => {
    const urls = [m.application_url, m.apply_url, m.source_url, m.final_url, m.evidence_url]
    const urlKeys = urls.map(normalizeUrlKey).filter(Boolean)
    const domains = urls.map(extractHostname).filter(Boolean)
    const titleKey = titleIdentityKey(m.title) || ''
    for (const k of urlKeys) storedUrlKeys.add(k)
    return { urlKeys: new Set(urlKeys), domains: new Set(domains), titleKey, sponsor: m.sponsor }
  })

  const overlap = []
  const web_only = []
  const seen = new Set()
  const coveredStored = new Set()
  let webReal = 0

  for (const hit of Array.isArray(webHits) ? webHits : []) {
    if (!isRealFundingHit(hit)) continue
    // Another state's government portal is not a miss for THIS profile.
    if (isOutOfStateGovHit(hit.url, state)) continue
    const urlKey = normalizeUrlKey(hit.url)
    if (!urlKey || seen.has(urlKey)) continue
    seen.add(urlKey)

    const titleKey = titleIdentityKey(hit.title) || ''
    const domain = extractHostname(hit.url)
    const item = {
      url: String(hit.url).trim(),
      title: String(hit.title || '').trim().slice(0, 200),
      domain,
      need: needForHit(hit, needs),
    }

    const matchingStoredIndexes = []
    storedRows.forEach((row, index) => {
      if (
        row.urlKeys.has(urlKey) ||
        titleSponsorIdentityMatches(row, hit, titleKey, domain)
      ) matchingStoredIndexes.push(index)
    })
    const covers = storedUrlKeys.has(urlKey) || matchingStoredIndexes.length > 0

    // A confirmed overlap is evidence GrantFlow already covers the web page,
    // even when the search snippet is sparse. Only a purported NEW miss must
    // prove that it is relevant and actionable for this profile.
    if (!covers && !isBenchmarkDirectFundingHit(hit, { needs, applicantTypes })) continue
    webReal += 1

    if (covers) {
      overlap.push(item)
      for (const index of matchingStoredIndexes) coveredStored.add(index)
    } else {
      web_only.push(item)
    }
  }

  return { overlap, web_only, grantflow_only: storedRows.length - coveredStored.size, web_real: webReal }
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
function isTerminalGapStatus(value) {
  return new Set(['adopted', 'gated_out', 'dismissed']).has(
    String(value || '').trim().toLowerCase(),
  )
}

function gapCandidateKey(candidate) {
  const profileId = String(candidate?.profile_id || '').trim()
  const urlKey = normalizeUrlKey(candidate?.url)
  return profileId && urlKey ? profileId + '|' + urlKey : ''
}

/**
 * Refresh the benchmark-owned pending queue to the latest scoped run.
 *
 * Terminal decisions and candidates owned by other producers are retained.
 * Pending web-parity candidates that disappeared from the latest run are pruned,
 * preventing generic portals and previously filtered noise from being re-seeded
 * forever. Scoped profile ids make partial/manual runs non-destructive.
 */
export async function appendGapCandidates(
  db,
  entries = [],
  { now = new Date(), profileIds = null } = {},
) {
  if (!db?.prepare) return { appended: 0, refreshed: 0, pruned: 0, total: 0 }

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

  let pruned = 0
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
      if (currentKeys.has(key)) refreshed += 1
      else pruned += 1
      continue
    }
    byKey.set(key, candidate)
  }

  const at = (now instanceof Date ? now : new Date(now)).toISOString()
  for (const entry of incoming) {
    const key = gapCandidateKey(entry)
    if (!key || byKey.has(key)) continue
    if (!previousPending.has(key)) appended += 1
    byKey.set(key, {
      url: String(entry.url).trim(),
      title: String(entry.title || '').trim().slice(0, 200),
      profile_id: entry.profile_id,
      need: entry.need ?? null,
      domain: entry.domain ?? extractHostname(entry.url) ?? null,
      source: entry.source ?? 'web_parity_benchmark',
      status: 'candidate',
      found_at: at,
    })
  }

  const candidates = [...byKey.values()].slice(-GAP_QUEUE_CAP)
  await kvSet(db, GAP_QUEUE_KV_KEY, { updated_at: at, candidates }, at)
  return {
    appended,
    refreshed,
    pruned,
    total: candidates.length,
    scoped_profiles: scope.size,
  }
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
export async function loadGapSeedPagesForProfile(db, profileId, { limit = GAP_SEED_LIMIT_PER_RUN, pendingOnly = true } = {}) {
  if (!db?.prepare || !profileId) return []
  const queue = await readWebParityGapQueue(db)
  return queue
    .filter((c) => String(c?.profile_id) === String(profileId))
    .filter((c) => (pendingOnly ? (c?.status ?? 'candidate') === 'candidate' : true))
    .filter((c) => /^https?:\/\//i.test(String(c?.url || '')))
    .slice(0, Math.max(0, limit))
    .map((c) => ({ url: c.url, title: c.title ?? null, snippet: c.need ? `need: ${c.need}` : null }))
}

/**
 * Record what the gates decided about seeded candidates, so the queue stops
 * re-offering a page that has already had its chance and the owner report can
 * show the rule WORKING (adopted) or honestly not (gated_out) instead of an
 * ever-growing pile of unjudged links.
 *
 * `adoptedUrls` are the seeds that became catalog rows this run; every other
 * seed offered this run was seen by the gates and refused. Both are terminal:
 * re-fetching a page the reality gate rejected cannot produce a different
 * answer, and leaving it 'candidate' would rebuild the write-only queue.
 */
export async function markGapCandidateOutcomes(db, { offeredUrls = [], adoptedUrls = [], profileId = null, now = new Date() } = {}) {
  if (!db?.prepare || offeredUrls.length === 0) return { adopted: 0, gated_out: 0 }
  const adopted = new Set(adoptedUrls.map(normalizeUrlKey).filter(Boolean))
  const offered = new Set(offeredUrls.map(normalizeUrlKey).filter(Boolean))
  const at = (now instanceof Date ? now : new Date(now)).toISOString()

  const queue = await readWebParityGapQueue(db)
  let adoptedCount = 0
  let gatedCount = 0
  // Conditions whose gap an ADOPTED source just closed — see creditConditionCoverage.
  const coveredConditions = new Set()
  const next = queue.map((c) => {
    if (profileId !== null && String(c?.profile_id) !== String(profileId)) return c
    const key = normalizeUrlKey(c?.url)
    if (!key || !offered.has(key)) return c
    if (adopted.has(key)) {
      adoptedCount += 1
      if (c?.source === 'condition_source_search' && c?.need) coveredConditions.add(String(c.need))
      return { ...c, status: 'adopted', resolved_at: at }
    }
    gatedCount += 1
    return { ...c, status: 'gated_out', resolved_at: at }
  })
  await kvSet(db, GAP_QUEUE_KV_KEY, { updated_at: at, candidates: next }, at)
  if (coveredConditions.size) await creditConditionCoverage(db, [...coveredConditions], { now })
  return { adopted: adoptedCount, gated_out: gatedCount, conditions_covered: coveredConditions.size }
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
  const sql = `
    SELECT o.id,
           ${selectOpportunityField('title')},
           ${selectOpportunityField('sponsor')},
           ${selectOpportunityField('application_url')},
           ${selectOpportunityField('apply_url')},
           ${selectOpportunityField('source_url')},
           ${selectOpportunityField('final_url')},
           ${selectOpportunityField('evidence_url')},
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
  maxQueriesPerProfile = MAX_QUERIES_PER_PROFILE,
  maxResultsPerQuery = MAX_RESULTS_PER_QUERY,
  persist = true,
  now = new Date(),
} = {}) {
  if (!isWebParityBenchmarkEnabled()) return { ran: false, reason: 'disabled' }
  if (!db?.prepare) return { ran: false, reason: 'no_db' }

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
      for (const h of (Array.isArray(results) ? results : []).slice(0, resultBudget)) {
        const key = normalizeUrlKey(h?.url)
        if (!key || seenUrls.has(key)) continue
        seenUrls.add(key)
        hits.push(h)
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
      for (const w of web_only) {
        gapEntries.push({ url: w.url, title: w.title, profile_id: g.profile_id, need: w.need, domain: w.domain })
      }
    }
  }

  const scored = perProfile.filter((p) => Number.isFinite(p.parity))
  const unscored = perProfile.length - scored.length
  const scoredProfilesParity = scored.length
    ? Math.round((scored.reduce((s, p) => s + p.parity, 0) / scored.length) * 10) / 10
    : null
  const measurementStatus = scored.length === perProfile.length
    ? 'scored'
    : (scored.length > 0 ? 'partial' : 'unscored')
  // A fleet score represents the whole selected golden cohort. Publishing the
  // measured subset as "fleet parity" would let an outage silently remove hard
  // profiles and inflate the headline.
  const fleetParity = measurementStatus === 'scored' ? scoredProfilesParity : null

  const result = {
    ran: true,
    generated_at: generatedAt,
    fleet_parity: fleetParity,
    scored_profiles_parity: scoredProfilesParity,
    measurement_status: measurementStatus,
    profiles_total: perProfile.length,
    profiles_scored: scored.length,
    profiles_unscored: unscored,
    per_profile: perProfile,
    gap_queue: { appended: 0, total: 0 },
  }

  if (persist) {
    try {
      const prior = (await readWebParityBenchmark(db)) || {}
      const runs = Array.isArray(prior.runs) ? prior.runs : []
      const compactRun = {
        generated_at: generatedAt,
        measurement_status: measurementStatus,
        profiles_total: perProfile.length,
        profiles_scored: scored.length,
        profiles_unscored: unscored,
        scored_profiles_parity: scoredProfilesParity,
        per_profile: perProfile.map((p) => ({
          profile_id: p.profile_id,
          label: p.label,
          parity: p.parity,
          measurement_status: p.measurement_status,
          error: p.error ?? null,
          overlap_count: p.overlap_count ?? null,
          web_only_count: p.web_only_count ?? null,
          grantflow_only: p.grantflow_only ?? null,
        })),
      }
      if (Number.isFinite(fleetParity)) compactRun.fleet_parity = fleetParity
      runs.push(compactRun)
      const latest = {
        generated_at: generatedAt,
        measurement_status: measurementStatus,
        profiles_total: perProfile.length,
        profiles_scored: scored.length,
        profiles_unscored: unscored,
        scored_profiles_parity: scoredProfilesParity,
        per_profile: perProfile,
      }
      if (Number.isFinite(fleetParity)) latest.fleet_parity = fleetParity
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
        // which to prune its prior candidates.
        profileIds: scored.map((profile) => profile.profile_id),
      })
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
      ? `Google-bar benchmark: fleet parity ${fleetParity} across ${perProfile.length} golden profile(s)`
      : (measurementStatus === 'partial'
          ? `Google-bar benchmark partial: ${scored.length}/${perProfile.length} profile(s) scored (measured subset ${scoredProfilesParity}; no fleet score)`
          : `Google-bar benchmark unscored: 0/${perProfile.length} golden profile(s) produced a valid comparison`),
    metric_key: 'fleet_parity',
    metric_value: Number.isFinite(fleetParity) ? fleetParity : null,
    entity_type: 'web_parity_benchmark',
    entity_id: generatedAt,
    details_json: {
      fleet_parity: fleetParity,
      measurement_status: measurementStatus,
      profiles_total: perProfile.length,
      profiles_scored: scored.length,
      profiles_unscored: unscored,
      scored_profiles_parity: scoredProfilesParity,
      profiles: perProfile.map((p) => ({ profile_id: p.profile_id, parity: p.parity, web_only: p.web_only_count ?? 0 })),
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
  REGRESSION_POINTS,
  AGGREGATOR_NOISE_DOMAINS,
  isWebParityBenchmarkEnabled,
  normalizeUrlKey,
  isRealFundingHit,
  isForeignGovernmentHit,
  isBenchmarkRelevantHit,
  isGenericFundingPortalHit,
  isBenchmarkDirectFundingHit,
  parityScore,
  classifyWebResults,
  readWebParityBenchmark,
  readWebParityGapQueue,
  appendGapCandidates,
  runWebParityBenchmark,
}
