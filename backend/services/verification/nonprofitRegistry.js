/**
 * nonprofitRegistry.js
 *
 * FREE, KEYLESS org verification against the ProPublica Nonprofit Explorer API
 * (IRS Form 990 data). Confirms a tax-exempt org is REAL and currently
 * tax-exempt, and surfaces its NTEE classification + revenue band.
 *
 *   Docs:  https://projects.propublica.org/nonprofits/api/
 *   Search:        https://projects.propublica.org/nonprofits/api/v2/search.json?q=<name>
 *   Organization:  https://projects.propublica.org/nonprofits/api/v2/organizations/<EIN>.json
 *
 * CONTRACT (mission "honest data" rule):
 *   - REAL data only — we assert ONLY what the API confirms. A row is reported
 *     `verified: true` ONLY when ProPublica actually returned a matching, tax-
 *     exempt organization. If the API is down/slow/rate-limited we return
 *     `apiAnswered: false` and NEVER assert verified/unverified — the caller
 *     must treat that as NEUTRAL (never penalize on API failure).
 *   - NEVER throws — every network error is caught and degraded to a neutral
 *     result. This module must never block discovery or hard-reject an opp.
 *   - Cached by EIN and by normalized name so a discovery run does not hammer
 *     the API for the same sponsor.
 */

import { createLogger } from '../../utils/logger.js'
import { createTtlCache, timedFetch } from './verificationCache.js'
import {
  isRegistryVerificationEnabled,
  registryTimeoutMs,
  verificationCacheTtlMs,
} from './verificationConfig.js'

const log = createLogger('nonprofitRegistry')

export const REGISTRY_SOURCE = 'propublica_nonprofit_explorer'
const API_BASE = 'https://projects.propublica.org/nonprofits/api/v2'

// One shared cache for both EIN and name lookups (namespaced keys).
const cache = createTtlCache()

// 501(c) subsection code → human label (the buckets that matter for grant
// eligibility). subseccd === 3 is the 501(c)(3) public charity / private
// foundation that most ORGANIZATION-targeted grants require.
const SUBSECTION_LABELS = {
  3: '501(c)(3)',
  4: '501(c)(4)',
  6: '501(c)(6)',
  7: '501(c)(7)',
}

/**
 * Revenue → coarse band aligned with the GrantFlow tier taxonomy
 * (Individual / Small <250k / Mid / Large). Mid/Large boundary at $5M mirrors
 * the profile-taxonomy buckets so a verified org's revenue can feed the tier.
 * @param {number|null} revenue
 * @returns {'unknown'|'micro'|'small'|'mid'|'large'}
 */
export function revenueBand(revenue) {
  const n = Number(revenue)
  if (!Number.isFinite(n) || n <= 0) return 'unknown'
  if (n < 50000) return 'micro'
  if (n < 250000) return 'small'
  if (n < 5000000) return 'mid'
  return 'large'
}

/** Normalize an org name to a stable cache/match key. */
export function normalizeOrgName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,'"()]/g, ' ')
    // Drop common legal/structural suffixes that don't affect identity.
    .replace(/\b(inc|incorporated|llc|corp|corporation|co|ltd|the|a|of|for)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Strip an EIN to 9 digits, or null if it isn't a plausible EIN. */
export function normalizeEin(ein) {
  const digits = String(ein || '').replace(/\D/g, '')
  return digits.length === 9 ? digits : null
}

/**
 * Levenshtein-based similarity (0..1). Tiny local implementation — no new dep.
 * Used to confirm a search hit actually corresponds to the org we asked about
 * (ProPublica search is fuzzy and returns near-misses).
 */
export function nameSimilarity(a, b) {
  const s1 = normalizeOrgName(a)
  const s2 = normalizeOrgName(b)
  if (!s1 || !s2) return 0
  if (s1 === s2) return 1
  const m = s1.length
  const n = s2.length
  const dp = new Array(n + 1)
  for (let j = 0; j <= n; j += 1) dp[j] = j
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j]
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (s1[i - 1] === s2[j - 1] ? 0 : 1),
      )
      prev = tmp
    }
  }
  const dist = dp[n]
  return 1 - dist / Math.max(m, n)
}

/** Neutral result used whenever the API did not actually answer. */
function neutral(reason) {
  return {
    source: REGISTRY_SOURCE,
    apiAnswered: false,
    verified: null,
    reason,
  }
}

/**
 * Map a ProPublica organization object (+ optional latest filing revenue) to
 * the structured signal we surface. Pure function — easy to unit test.
 */
export function mapOrganization(org, revenue = null) {
  if (!org || typeof org !== 'object') return neutral('no_org')
  const subseccd = Number(org.subseccd)
  const isTaxExempt = Number.isFinite(subseccd) && subseccd > 0
  const is501c3 = subseccd === 3
  const ein = normalizeEin(org.ein ?? org.strein)
  return {
    source: REGISTRY_SOURCE,
    apiAnswered: true,
    // "verified" means: a real, currently-listed tax-exempt entity.
    verified: isTaxExempt,
    ein,
    name: org.name ?? null,
    is501c3,
    subsection: Number.isFinite(subseccd) ? subseccd : null,
    subsectionLabel: SUBSECTION_LABELS[subseccd] ?? (isTaxExempt ? `501(c)(${subseccd})` : null),
    ntee: org.ntee_code ?? null,
    state: org.state ?? null,
    city: org.city ?? null,
    revenue: Number.isFinite(Number(revenue)) ? Number(revenue) : null,
    revenue_band: revenueBand(revenue),
  }
}

/** Extract the most-recent total revenue from a /organizations response. */
function latestRevenue(payload) {
  const filings = Array.isArray(payload?.filings_with_data) ? payload.filings_with_data : []
  let best = null
  let bestYear = -Infinity
  for (const f of filings) {
    const year = Number(f?.tax_prd_yr)
    const rev = Number(f?.totrevenue)
    if (Number.isFinite(rev) && Number.isFinite(year) && year > bestYear) {
      bestYear = year
      best = rev
    }
  }
  return best
}

/**
 * Look up an organization by EIN. Returns the structured signal (apiAnswered
 * true only when ProPublica responded with a usable org).
 * @param {string} ein
 * @returns {Promise<object>}
 */
export async function lookupByEin(ein) {
  if (!isRegistryVerificationEnabled()) return neutral('disabled')
  const norm = normalizeEin(ein)
  if (!norm) return neutral('invalid_ein')

  const key = `ein:${norm}`
  const ttl = verificationCacheTtlMs()
  const cached = cache.get(key, ttl)
  if (cached !== undefined) return cached

  let result
  try {
    const res = await timedFetch(`${API_BASE}/organizations/${norm}.json`, {
      timeoutMs: registryTimeoutMs(),
    })
    if (res.status === 404) {
      // The API answered: this EIN is NOT a listed tax-exempt org.
      result = { source: REGISTRY_SOURCE, apiAnswered: true, verified: false, ein: norm, reason: 'not_found' }
    } else if (!res.ok) {
      result = neutral(`http_${res.status}`)
    } else {
      const payload = await res.json()
      result = mapOrganization(payload?.organization, latestRevenue(payload))
    }
  } catch (err) {
    // Timeout / network / parse error → NEUTRAL (never penalize on API failure).
    log.warn('lookupByEin.failed', { ein: norm, error: err?.message })
    result = neutral('api_error')
  }

  // Only cache definitive answers; a transient API error must be retryable.
  if (result.apiAnswered) cache.set(key, result)
  return result
}

/**
 * Look up an organization by name (optionally state-scoped). Confirms the top
 * search hit actually matches the requested name (fuzzy guard) before asserting
 * verification, then hydrates revenue via lookupByEin.
 * @param {string} name
 * @param {object} [opts]
 * @param {string} [opts.state] two-letter state to narrow the search
 * @param {number} [opts.minSimilarity=0.82] name-match floor
 * @returns {Promise<object>}
 */
export async function lookupByName(name, { state = null, minSimilarity = 0.82 } = {}) {
  if (!isRegistryVerificationEnabled()) return neutral('disabled')
  const normName = normalizeOrgName(name)
  if (!normName || normName.length < 3) return neutral('invalid_name')

  const key = `name:${normName}|${String(state || '').toUpperCase()}`
  const ttl = verificationCacheTtlMs()
  const cached = cache.get(key, ttl)
  if (cached !== undefined) return cached

  let result
  try {
    const params = new URLSearchParams({ q: name })
    if (state) params.set('state%5Bid%5D', String(state).toUpperCase())
    const res = await timedFetch(`${API_BASE}/search.json?${params.toString()}`, {
      timeoutMs: registryTimeoutMs(),
    })
    if (!res.ok) {
      result = neutral(`http_${res.status}`)
    } else {
      const payload = await res.json()
      const orgs = Array.isArray(payload?.organizations) ? payload.organizations : []
      // Pick the best fuzzy match above the floor (ProPublica search is loose).
      let best = null
      let bestScore = 0
      for (const o of orgs) {
        const score = nameSimilarity(name, o?.name)
        if (score > bestScore) { bestScore = score; best = o }
      }
      if (!best || bestScore < minSimilarity) {
        // The API answered, but nothing confidently matches → not verified by name.
        result = { source: REGISTRY_SOURCE, apiAnswered: true, verified: false, reason: 'no_confident_match', bestScore }
      } else {
        // Hydrate revenue/subsection via the org endpoint when we have an EIN.
        const ein = normalizeEin(best.ein ?? best.strein)
        if (ein) {
          const byEin = await lookupByEin(ein)
          result = byEin.apiAnswered ? { ...byEin, nameMatchScore: bestScore } : mapOrganization(best)
        } else {
          result = { ...mapOrganization(best), nameMatchScore: bestScore }
        }
      }
    }
  } catch (err) {
    log.warn('lookupByName.failed', { name: normName, error: err?.message })
    result = neutral('api_error')
  }

  if (result.apiAnswered) cache.set(key, result)
  return result
}

/** Test/maintenance helper. */
export function _clearCache() {
  cache.clear()
}

export default {
  REGISTRY_SOURCE,
  lookupByEin,
  lookupByName,
  mapOrganization,
  revenueBand,
  normalizeOrgName,
  normalizeEin,
  nameSimilarity,
}
