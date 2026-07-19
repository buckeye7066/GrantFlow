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
 *        overlap        — web results GrantFlow ALREADY has (url identity →
 *                         title identity → domain fallback)
 *        web_only       — REAL-looking funding pages the web found that
 *                         GrantFlow lacks (search-engine/placeholder/social/
 *                         aggregator-noise filtered out via the canonical
 *                         urlRules + the web lane's skip list)
 *        grantflow_only — stored top matches the web session did not surface
 *   3. Score:  parity = overlap / (overlap + web_only) × 100.
 *      Zero real web-only finds ⇒ parity 100 (GrantFlow covers everything the
 *      session produced — including the zero-web-results case, never NaN).
 *
 * PERSISTENCE — system_kv `web_parity_benchmark`
 *   { generated_at, runs: [last MAX_RUN_HISTORY compact runs], latest:
 *     { generated_at, fleet_parity, per_profile } }
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
const WEB_ONLY_TOP_CAP = 5

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
  if (!domain || AGGREGATOR_NOISE_DOMAINS.has(domain)) return false
  const text = `${hit?.title ?? ''} ${hit?.snippet ?? ''} ${url}`
  return FUNDING_SIGNAL_RE.test(text)
}

/** parity points (0–100). Zero web-only AND zero overlap ⇒ 100 (never NaN). */
export function parityScore(overlapCount, webOnlyCount) {
  const o = Math.max(0, Number(overlapCount) || 0)
  const w = Math.max(0, Number(webOnlyCount) || 0)
  if (o + w === 0) return 100
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

/**
 * Classify a web session's hits against the profile's stored top matches.
 *
 * Identity ladder (strongest first), mirroring canonicalOpportunityKey's
 * spirit for the fields a SERP hit actually has:
 *   1. normalized URL equality against any stored URL field,
 *   2. title-identity equality (titleIdentityKey, title-only — SERP hits have
 *      no reliable sponsor),
 *   3. domain match (acceptable fallback: same funder site ⇒ GrantFlow already
 *      reaches that source).
 *
 * @param {Array<{url,title,snippet}>} webHits   raw session hits (pre-filter)
 * @param {Array<{id,title,sponsor,application_url,apply_url,source_url}>} storedMatches
 * @param {{needs?:string[]}} [opts]
 * @returns {{overlap:Array, web_only:Array, grantflow_only:number, web_real:number}}
 */
export function classifyWebResults(webHits, storedMatches, { needs = [], state = null } = {}) {
  const stored = Array.isArray(storedMatches) ? storedMatches : []
  const storedUrlKeys = new Set()
  const storedTitleKeys = new Set()
  const storedDomains = new Set()
  const storedRows = stored.map((m) => {
    const urls = [m.application_url, m.apply_url, m.source_url]
    const urlKeys = urls.map(normalizeUrlKey).filter(Boolean)
    const domains = urls.map(extractHostname).filter(Boolean)
    const titleKey = titleIdentityKey(m.title) || ''
    for (const k of urlKeys) storedUrlKeys.add(k)
    for (const d of domains) storedDomains.add(d)
    if (titleKey) storedTitleKeys.add(titleKey)
    return { urlKeys: new Set(urlKeys), domains: new Set(domains), titleKey }
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
    webReal += 1

    const titleKey = titleIdentityKey(hit.title) || ''
    const domain = extractHostname(hit.url)
    const item = {
      url: String(hit.url).trim(),
      title: String(hit.title || '').trim().slice(0, 200),
      domain,
      need: needForHit(hit, needs),
    }

    const covers =
      storedUrlKeys.has(urlKey) ||
      (titleKey && storedTitleKeys.has(titleKey)) ||
      (domain && storedDomains.has(domain))

    if (covers) {
      overlap.push(item)
      storedRows.forEach((row, i) => {
        if (
          row.urlKeys.has(urlKey) ||
          (titleKey && row.titleKey === titleKey) ||
          (domain && row.domains.has(domain))
        ) coveredStored.add(i)
      })
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
export async function appendGapCandidates(db, entries = [], { now = new Date() } = {}) {
  if (!db?.prepare) return { appended: 0, total: 0 }
  const incoming = (Array.isArray(entries) ? entries : []).filter((e) => e && e.url && e.profile_id)
  if (incoming.length === 0) {
    const existing0 = await readWebParityGapQueue(db)
    return { appended: 0, total: existing0.length }
  }
  const existing = await readWebParityGapQueue(db)
  const byKey = new Map()
  for (const c of existing) {
    const key = `${c?.profile_id}|${normalizeUrlKey(c?.url)}`
    byKey.set(key, c)
  }
  let appended = 0
  const at = (now instanceof Date ? now : new Date(now)).toISOString()
  for (const e of incoming) {
    const key = `${e.profile_id}|${normalizeUrlKey(e.url)}`
    if (byKey.has(key)) continue
    byKey.set(key, {
      url: String(e.url).trim(),
      title: String(e.title || '').trim().slice(0, 200),
      profile_id: e.profile_id,
      need: e.need ?? null,
      domain: e.domain ?? extractHostname(e.url) ?? null,
      // The queue has more than one producer now (the Google-bar benchmark and the
      // adapter-wishlist condition search). Hardcoding the benchmark here would make
      // the queue misreport its own origin — and provenance is the thing that lets
      // anyone tell which loop is working.
      source: e.source ?? 'web_parity_benchmark',
      status: 'candidate',
      found_at: at,
    })
    appended += 1
  }
  const candidates = [...byKey.values()].slice(-GAP_QUEUE_CAP)
  await kvSet(db, GAP_QUEUE_KV_KEY, { updated_at: at, candidates }, at)
  return { appended, total: candidates.length }
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

/** The profile's CURRENT top stored matches (the thing that must beat the web). */
async function defaultLoadStoredMatches(db, profileId) {
  const order = db?.dialect === 'postgres' ? 'm.match_score DESC NULLS LAST' : 'm.match_score DESC'
  const sql = (withDecision) => `
    SELECT o.id, o.title, o.sponsor, o.application_url, o.apply_url, o.source_url, m.match_score
      FROM profile_opportunity_matches m
      JOIN funding_opportunities o ON o.id = m.opportunity_id
     WHERE m.profile_id = ?
       ${withDecision ? "AND (m.match_decision IS NULL OR m.match_decision <> 'REJECT')" : ''}
     ORDER BY ${order}
     LIMIT ${MAX_STORED_MATCHES}`
  try {
    return await db.prepare(sql(true)).all(profileId)
  } catch {
    // Older shim without match_decision — same read, no decision filter.
    return db.prepare(sql(false)).all(profileId)
  }
}

async function defaultEmitTelemetry(db, event) {
  try {
    const { insertActivityEvent } = await import('./agentTelemetry/agentTelemetryStore.js')
    await insertActivityEvent(db, event)
  } catch {
    /* telemetry is best-effort; never fail a benchmark on it */
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
    for (const q of queries) {
      let results = []
      try {
        results = await searchWeb(q, { count: resultBudget })
      } catch (err) {
        searchErrors += 1
        log.warn('benchmark web search failed (non-fatal)', { query: q, error: err?.message })
        results = []
      }
      for (const h of (Array.isArray(results) ? results : []).slice(0, resultBudget)) {
        const key = normalizeUrlKey(h?.url)
        if (!key || seenUrls.has(key)) continue
        seenUrls.add(key)
        hits.push(h)
      }
    }

    let stored = []
    try {
      stored = await loadStoredMatches(db, g.profile_id)
    } catch (err) {
      log.warn('stored-match load failed for golden profile', { profile_id: g.profile_id, error: err?.message })
      stored = []
    }

    const needs = Array.isArray(thesis.needs) ? thesis.needs : []
    const profileState = thesis?.location?.state ?? null
    const { overlap, web_only, grantflow_only, web_real } = classifyWebResults(hits, stored, { needs, state: profileState })
    const parity = parityScore(overlap.length, web_only.length)

    perProfile.push({
      profile_id: g.profile_id,
      label,
      parity,
      overlap_count: overlap.length,
      web_only_count: web_only.length,
      grantflow_only,
      stored_matches: Array.isArray(stored) ? stored.length : 0,
      web_results: hits.length,
      web_real,
      queries_run: queries.length,
      search_errors: searchErrors,
      // Zero raw hits across every query smells like a provider outage — parity
      // is still 100 by the formula (nothing to beat), but flag it honestly.
      web_outage_suspected: hits.length === 0,
      web_only_top: web_only.slice(0, WEB_ONLY_TOP_CAP),
    })

    for (const w of web_only) {
      gapEntries.push({ url: w.url, title: w.title, profile_id: g.profile_id, need: w.need, domain: w.domain })
    }
  }

  const scored = perProfile.filter((p) => Number.isFinite(p.parity))
  const fleetParity = scored.length
    ? Math.round((scored.reduce((s, p) => s + p.parity, 0) / scored.length) * 10) / 10
    : null

  const result = {
    ran: true,
    generated_at: generatedAt,
    fleet_parity: fleetParity,
    per_profile: perProfile,
    gap_queue: { appended: 0, total: 0 },
  }

  if (persist) {
    try {
      const prior = (await readWebParityBenchmark(db)) || {}
      const runs = Array.isArray(prior.runs) ? prior.runs : []
      runs.push({
        generated_at: generatedAt,
        fleet_parity: fleetParity,
        per_profile: perProfile.map((p) => ({
          profile_id: p.profile_id,
          label: p.label,
          parity: p.parity,
          overlap_count: p.overlap_count ?? 0,
          web_only_count: p.web_only_count ?? 0,
          grantflow_only: p.grantflow_only ?? 0,
        })),
      })
      const store = {
        generated_at: generatedAt,
        runs: runs.slice(-MAX_RUN_HISTORY),
        latest: { generated_at: generatedAt, fleet_parity: fleetParity, per_profile: perProfile },
      }
      await kvSet(db, KV_KEY, store, generatedAt)
    } catch (err) {
      log.warn('benchmark persist failed (result still returned)', { error: err?.message })
    }
    try {
      result.gap_queue = await appendGapCandidates(db, gapEntries, { now })
    } catch (err) {
      log.warn('gap-queue append failed (non-fatal)', { error: err?.message })
    }
  }

  await emitTelemetry(db, {
    agent_name: 'sam',
    event_type: 'sam.web_parity_benchmark',
    status: 'succeeded',
    severity: 'info',
    title: `Google-bar benchmark: fleet parity ${fleetParity ?? 'n/a'} across ${scored.length} golden profile(s)`,
    metric_key: 'fleet_parity',
    metric_value: Number.isFinite(fleetParity) ? fleetParity : null,
    entity_type: 'web_parity_benchmark',
    entity_id: generatedAt,
    details_json: {
      fleet_parity: fleetParity,
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
  parityScore,
  classifyWebResults,
  readWebParityBenchmark,
  readWebParityGapQueue,
  appendGapCandidates,
  runWebParityBenchmark,
}
