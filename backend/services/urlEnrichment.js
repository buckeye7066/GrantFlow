/**
 * urlEnrichment.js — application-URL rescue lane.
 *
 * PROBLEM: docs/email/LLM-extracted candidates frequently carry a real title +
 * sponsor but NO application URL, so the opportunityInserter url gate rejects
 * them (reason `missing_application_url`) and the candidate is lost even though
 * the program is real and its page exists on the live web.
 *
 * HONESTY RULE (docs/canonical_rules.md G0 — never invent data): this module
 * finds a REAL, LIVE page for a KNOWN title+sponsor via a bounded web search
 * plus a liveness probe. It NEVER fabricates, guesses, or synthesizes a URL —
 * if no plausible live page is found, the answer is honestly `null` and the
 * candidate stays rejected.
 *
 * Consumed by the `enforceApplicationUrlRescue` boot sweep in
 * backend/startup/enforceInvariants.js.
 */

import { searchWeb } from './shared/webSearchEngine.js'
import { checkUrl } from './linkVerificationService.js'
import { isSearchEngineUrl } from '../config/urlRules.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('urlEnrichment')

/**
 * Words that carry no identity for a funding-program title. Kept as a module
 * const (not inline) so the tokenizer and its tests share one definition.
 */
export const TITLE_STOPWORDS = Object.freeze(new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'with',
  'grant', 'grants', 'program', 'fund', 'funding',
]))

/** Minimum length for a token to be considered significant. */
export const MIN_TOKEN_LENGTH = 3

/** A candidate title must yield at least this many significant tokens. */
export const MIN_SIGNIFICANT_TOKENS = 2

/** Fraction of the candidate's significant tokens a hit must contain. */
export const TOKEN_OVERLAP_THRESHOLD = 0.6

/** Max SERP hits to fetch per rescue attempt. */
export const MAX_SEARCH_HITS = 6

/** Max liveness probes per rescue attempt (network budget). */
export const MAX_LIVENESS_PROBES = 3

/** Per-search network budget (ms). */
export const SEARCH_TIMEOUT_MS = 8000

/** Per-probe network budget (ms). */
export const PROBE_TIMEOUT_MS = 8000

/**
 * Tokenize a title into its significant, deduplicated, lowercase tokens:
 * split on non-alphanumerics, drop stopwords and tokens shorter than
 * MIN_TOKEN_LENGTH. Pure.
 *
 * @param {string} title
 * @returns {string[]}
 */
export function significantTitleTokens(title) {
  if (typeof title !== 'string' || !title.trim()) return []
  const seen = new Set()
  const out = []
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < MIN_TOKEN_LENGTH) continue
    if (TITLE_STOPWORDS.has(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
}

/** Combined lowercase text of a SERP hit (title + snippet + url). */
function combinedHitText(hit) {
  return `${hit?.title ?? ''} ${hit?.snippet ?? ''} ${hit?.url ?? ''}`.toLowerCase()
}

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim())
}

/**
 * Decide whether a search hit plausibly IS the official page for a known
 * candidate (never a fuzzy "close enough" guess — the liveness probe and the
 * full insert gate stack still run after this). Pure.
 *
 * Requirements (all must hold):
 *   - the candidate title has ≥ MIN_SIGNIFICANT_TOKENS significant tokens;
 *   - ≥ TOKEN_OVERLAP_THRESHOLD of them appear in the hit's title+snippet+url;
 *   - the hit URL is http(s) and NOT a search-engine results page.
 *
 * Sponsor tokens, when present, add confidence (the caller prefers
 * sponsor-matching hits when ordering probes) but are NOT required — SERP
 * snippets often omit the sponsor even on the official page.
 *
 * @param {{title?: string, sponsor?: string}} candidate
 * @param {{url?: string, title?: string, snippet?: string}} hit
 * @returns {boolean}
 */
export function isPlausibleOfficialHit(candidate, hit) {
  if (!candidate || !hit) return false
  if (!isHttpUrl(hit.url) || isSearchEngineUrl(hit.url)) return false

  const tokens = significantTitleTokens(candidate.title)
  if (tokens.length < MIN_SIGNIFICANT_TOKENS) return false

  const text = combinedHitText(hit)
  const present = tokens.filter((t) => text.includes(t))
  return present.length / tokens.length >= TOKEN_OVERLAP_THRESHOLD
}

/**
 * True when the hit's text mentions any significant sponsor token — used only
 * to prioritize probe order (confidence booster, never a requirement).
 */
function hitMentionsSponsor(sponsor, hit) {
  const sponsorTokens = significantTitleTokens(sponsor)
  if (sponsorTokens.length === 0) return false
  const text = combinedHitText(hit)
  return sponsorTokens.some((t) => text.includes(t))
}

/**
 * Find a REAL, LIVE official page for a known opportunity (title + sponsor).
 *
 * HONESTY CONTRACT: the returned URL is always a page that (a) came back from
 * a live web search for the candidate's own title+sponsor, (b) passed the
 * token-overlap plausibility check, and (c) answered a liveness probe with
 * ok/redirect. This function NEVER fabricates or guesses a URL; when nothing
 * real is found it returns { url: null } with honest search telemetry so the
 * caller can distinguish "provider outage" from "genuinely not found".
 *
 * Never throws.
 *
 * @param {{title?: string, sponsor?: string}} candidate
 * @param {object} [deps] Test injection points.
 * @param {Function} [deps.searchWebImpl] Replaces searchWeb.
 * @param {Function} [deps.checkUrlImpl]  Replaces checkUrl.
 * @returns {Promise<{
 *   url: string|null,
 *   searched: boolean,
 *   hits?: number,
 *   hit?: object,
 *   probe?: object,
 *   error?: string,
 * }>}
 */
export async function findOfficialUrlForOpportunity({ title, sponsor } = {}, deps = {}) {
  const searchWebImpl = deps.searchWebImpl ?? searchWeb
  const checkUrlImpl = deps.checkUrlImpl ?? checkUrl
  try {
    const cleanTitle = typeof title === 'string' ? title.trim() : ''
    const cleanSponsor = typeof sponsor === 'string' ? sponsor.trim() : ''
    const query = `"${cleanTitle}" ${cleanSponsor}`.trim()

    const raw = await searchWebImpl(query, { count: MAX_SEARCH_HITS, timeoutMs: SEARCH_TIMEOUT_MS })
    const hits = Array.isArray(raw) ? raw.slice(0, MAX_SEARCH_HITS) : []
    if (hits.length === 0) {
      // Distinguishable "provider returned nothing" outcome — the caller's
      // outage guard uses hits===0 to avoid burning candidates.
      return { url: null, searched: true, hits: 0 }
    }

    const plausible = hits.filter((h) => isPlausibleOfficialHit({ title: cleanTitle, sponsor: cleanSponsor }, h))
    // Sponsor mention = extra confidence: probe those hits first.
    plausible.sort((a, b) =>
      Number(hitMentionsSponsor(cleanSponsor, b)) - Number(hitMentionsSponsor(cleanSponsor, a)))

    let probes = 0
    for (const hit of plausible) {
      if (probes >= MAX_LIVENESS_PROBES) break
      probes += 1
      const probe = await checkUrlImpl(hit.url, { timeoutMs: PROBE_TIMEOUT_MS })
      if (probe && (probe.status === 'ok' || probe.status === 'redirect')) {
        return { url: probe.finalUrl || hit.url, hit, probe, searched: true, hits: hits.length }
      }
    }
    return { url: null, searched: true, hits: hits.length }
  } catch (err) {
    // Never throws — the rescue sweep treats searched:false as a provider
    // failure (candidate is preserved for a later attempt).
    const message = String(err?.message || err)
    log.warn('findOfficialUrlForOpportunity failed (non-fatal)', { error: message })
    return { url: null, searched: false, error: message }
  }
}
