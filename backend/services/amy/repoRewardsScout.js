/**
 * repoRewardsScout.js — Amy's Repo Rewards search lane.
 *
 * OWNER DIRECTIVE (2026-07-25): teach Amy to use Repo Rewards (the owner's
 * safety-gated repo search engine) and the FlexFactor "Scout a Program" tool
 * to improve the crawlers, their gap coverage, and their use of profile
 * information — and to find other repos with a more optimal approach to
 * surfacing real, relatable sources for the needs of the profile.
 *
 * WHAT IT DOES
 *   1. Derives repo-search queries from Amy's OWN latest training report: the
 *      finding types her synthetic profiles tripped most (hyperlocal recall,
 *      amount recall, false positives, …) each map to a query for code that
 *      fixes that gap, and the most-affected archetype contributes a
 *      needs-of-the-profile query. Falls back to base queries when no report.
 *   2. Runs those queries against the Repo Rewards `/api/search` endpoint
 *      (prod by default; REPO_REWARDS_URL to override). Every result is
 *      already safety-gated (`search_state='ready'`) and scored
 *      (relevance/safety/trust/quality) by Repo Rewards itself.
 *   3. Returns hits in the same `{url,title,snippet}` shape the competitive
 *      research web lane uses, tagged `via:'repo_rewards'` + `is_repo:true`,
 *      so `runCrawlerCompetitiveResearch` merges them into ONE candidate pool
 *      for the same skeptical "is it actually more optimal?" LLM comparison.
 *
 * DOCTRINE — same as the rest of Amy's research: ADVISORY ONLY. This lane
 * never changes code or the catalog; findings land in the persisted research
 * snapshot that Anya's morning owner email surfaces. The local FlexFactor
 * scout (weekly, Sunday 02:00, report-only — see docs/AMY_REPO_SCOUT.md) is
 * the deep-inspection twin of this lane and is equally advisory by default.
 *
 * Gate: AMY_REPO_REWARDS (enabled by default; set =false to disable).
 * fetch is INJECTED so tests run fully offline.
 */

import { createLogger } from '../../utils/logger.js'
import { FINDING_TYPES } from './amyConstants.js'

const log = createLogger('services:amy:repoRewardsScout')

/** Production Repo Rewards deployment (Railway). Override via REPO_REWARDS_URL. */
export const DEFAULT_REPO_REWARDS_URL = 'https://web-production-d7db7.up.railway.app'

/** Bounded budget — a focused repo scan, not a crawl. */
export const MAX_REPO_QUERIES = 4
export const MAX_RESULTS_PER_QUERY = 6
/** Repo Rewards fans out to providers + AI; its route allows 120s. */
export const SEARCH_TIMEOUT_MS = 90_000

export function isRepoRewardsEnabled() {
  const raw = String(process.env.AMY_REPO_REWARDS ?? '').trim().toLowerCase()
  if (raw === 'false') return false
  if (raw === 'true') return true
  // Unset: ON in prod, OFF under a test runner. Unlike the web lane (which is
  // unconfigured in tests and fails fast), this lane's default base URL is
  // ALWAYS reachable, so without this guard any test that exercises the real
  // nightly sweep would hit the live service (selfHealObservability timed out
  // exactly that way). Tests that want the lane set AMY_REPO_REWARDS=true.
  return !process.env.VITEST
}

export function repoRewardsBaseUrl() {
  const raw = String(process.env.REPO_REWARDS_URL || '').trim()
  return (raw || DEFAULT_REPO_REWARDS_URL).replace(/\/+$/, '')
}

/**
 * Finding type → the repo-search query that hunts code addressing THAT gap.
 * Phrased as natural-language Repo Rewards queries (it expands them itself).
 * Only gap classes where external code plausibly transfers get an entry —
 * config-tuning findings (scoring floor, field mapping) stay with the
 * existing editors and are deliberately absent.
 */
export const GAP_QUERY_OF_FINDING = Object.freeze({
  [FINDING_TYPES.HYPERLOCAL_RECALL_MISS]:
    'crawler that discovers local community foundation and municipal grant programs',
  [FINDING_TYPES.INSTITUTION_RECALL_MISS]:
    'scraper indexing university and institutional scholarship listings',
  [FINDING_TYPES.AMOUNT_RECALL_MISS]:
    'extract structured award amounts from grant and scholarship pages',
  [FINDING_TYPES.FALSE_POSITIVE]:
    'relevance ranking precision for matching grants to applicant profiles',
  [FINDING_TYPES.BAD_MATCH]:
    'eligibility rules engine for matching applicants to funding programs',
  [FINDING_TYPES.ZERO_RESULT]:
    'aggregate funding opportunities from many government and foundation feeds',
  [FINDING_TYPES.SOURCE_FETCH_FAILED]:
    'resilient web scraping framework retry javascript rendered pages',
  [FINDING_TYPES.GEO_RADIUS_ISSUE]:
    'geographic eligibility filtering for local grant and assistance programs',
})

/** Always-relevant fallback queries (used when the report offers no signal). */
export const BASE_REPO_QUERIES = Object.freeze([
  'grant discovery crawler aggregating funding opportunities',
  'match scholarships and grants to a user profile',
])

/**
 * Build the bounded query list from Amy's latest training report. Pure.
 *
 * @param {{report?:object|null, max?:number}} [opts]
 *   report — the stored Amy report (readLatestAmyReport shape: findings[] each
 *   {type, archetype?}). Absent/empty → BASE_REPO_QUERIES.
 * @returns {string[]} deduped, capped queries — most-tripped gaps first.
 */
export function buildRepoQueries({ report = null, max = MAX_REPO_QUERIES } = {}) {
  const queries = []
  const findings = Array.isArray(report?.findings) ? report.findings : []

  // Count findings per type; walk types by frequency so the queries chase the
  // gaps Amy's synthetic profiles actually tripped most.
  const countByType = new Map()
  const countByArchetype = new Map()
  for (const f of findings) {
    const type = String(f?.type || '').trim()
    if (type) countByType.set(type, (countByType.get(type) || 0) + 1)
    const arche = String(f?.archetype || '').trim()
    if (arche) countByArchetype.set(arche, (countByArchetype.get(arche) || 0) + 1)
  }
  const rankedTypes = [...countByType.entries()].sort((a, b) => b[1] - a[1])
  for (const [type] of rankedTypes) {
    const q = GAP_QUERY_OF_FINDING[type]
    if (q && !queries.includes(q)) queries.push(q)
  }

  // Needs-of-the-profile query: the archetype tripping the most findings is
  // the profile shape the crawlers serve worst right now.
  const topArchetype = [...countByArchetype.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (topArchetype) {
    const humanized = topArchetype.replace(/_/g, ' ')
    const q = `find funding sources and assistance programs for ${humanized} applicants`
    if (!queries.includes(q)) queries.push(q)
  }

  for (const q of BASE_REPO_QUERIES) {
    if (queries.length >= max) break
    if (!queries.includes(q)) queries.push(q)
  }
  return queries.slice(0, Math.max(1, max))
}

/**
 * Search Repo Rewards and return competitive-research-shaped hits.
 * Results arrive pre-scored and safety-gated (only `ready` repos are ever
 * returned by the read path). Throws on transport/HTTP failure — the caller
 * (runCrawlerCompetitiveResearch) already treats a failed source as non-fatal.
 *
 * @param {string} query
 * @param {{count?:number, baseUrl?:string, fetchImpl?:Function, sessionId?:string}} [opts]
 * @returns {Promise<Array<{url:string,title:string,snippet:string,via:'repo_rewards',is_repo:true}>>}
 */
export async function searchRepoRewards(query, {
  count = MAX_RESULTS_PER_QUERY,
  baseUrl = repoRewardsBaseUrl(),
  fetchImpl = globalThis.fetch,
  sessionId = 'amy-crawler-research',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  let outcome
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: String(query || '').slice(0, 500), lens: 'best', sessionId }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`repo rewards search failed: HTTP ${res.status}`)
    outcome = await res.json()
  } finally {
    clearTimeout(timer)
  }

  const results = Array.isArray(outcome?.results) ? outcome.results : []
  const hits = []
  for (const r of results) {
    const repo = r?.repo
    const url = String(repo?.htmlUrl || '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    const name = String(repo?.fullName || repo?.name || '').trim()
    if (!name) continue
    const purpose = String(r?.ai?.purposeSummary || repo?.description || '').trim()
    const scoreBits = [
      Number.isFinite(r?.finalScore) ? `score ${Math.round(r.finalScore)}` : null,
      r?.safety?.verdict ? `safety ${r.safety.verdict}` : null,
      Number.isFinite(repo?.stars) ? `${repo.stars}★` : null,
      repo?.primaryLanguage || null,
    ].filter(Boolean).join(' · ')
    hits.push({
      url,
      title: name,
      snippet: [purpose, scoreBits].filter(Boolean).join(' — ').slice(0, 320),
      via: 'repo_rewards',
      is_repo: true,
    })
    if (hits.length >= Math.max(1, count)) break
  }
  log.info('repo rewards search', { query: String(query).slice(0, 80), hits: hits.length })
  return hits
}

export default {
  DEFAULT_REPO_REWARDS_URL,
  MAX_REPO_QUERIES,
  MAX_RESULTS_PER_QUERY,
  GAP_QUERY_OF_FINDING,
  BASE_REPO_QUERIES,
  isRepoRewardsEnabled,
  repoRewardsBaseUrl,
  buildRepoQueries,
  searchRepoRewards,
}
