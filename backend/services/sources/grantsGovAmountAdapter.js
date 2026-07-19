/**
 * grantsGovAmountAdapter.js — read a Grants.gov opportunity's award figures from
 * the Grants.gov API instead of its web page.
 *
 * WHY THIS EXISTS. `amountEnrichment.js` acquires per-award dollars by fetching
 * an opportunity's own source page and running the conservative extractor over
 * the copy. That works for a funder's static HTML page. It CANNOT work for
 * grants.gov: www.grants.gov renders its detail pages client-side, so the
 * SSRF-safe fetcher receives a JS shell with no award copy in it and the sweep
 * honestly reports `thin_page`. Measured in prod 2026-07-15: 0 of 10 sampled
 * enrichment failures were fetch failures, and grants.gov was 45 of the 149
 * remaining backlog rows — the single largest slice, permanently unreadable by
 * fetching. More fetching was never going to move pipeline-$ coverage off ~13%.
 *
 * The award figures are not missing; they are in a different place. Grants.gov
 * publishes `awardCeiling` / `awardFloor` over a keyless JSON API, and this repo
 * already speaks to it (`services/shared/grantsGovApiClient.js`). This adapter
 * is the missing link: catalog row → grants.gov opportunity id → award figures.
 *
 * NOT AN SSRF SURFACE. Unlike the page fetcher, this adapter never dereferences
 * a URL carried on the row. It parses an OPPORTUNITY ID out of the row's URL and
 * sends that id to a hardcoded api.grants.gov endpoint, so a poisoned
 * `source_url` can at worst produce a wrong-or-absent id, never an outbound
 * request to an attacker-chosen host. That is why it does not go through the
 * crawler-os fetcher's allowlist.
 *
 * HONESTY CONTRACT. This adapter returns the same shape as
 * `enrichOpportunityAmountFromSource` so the sweep's burn/retry rule is
 * unchanged (see that module's header for why the distinction must live in the
 * RETURN VALUE and not in a catch block):
 *
 *   page_read: true   — the API gave a definitive answer about this row, either
 *                       an award figure or an explicit "no figure published".
 *                       Both are real answers; the sweep should stop asking.
 *   transient: true   — 5xx/429/timeout/transport. The API had a bad night; the
 *                       row keeps its chance.
 *   attempted: false  — this row is not a grants.gov row we can identify, so the
 *                       adapter did nothing and the caller must fall back to the
 *                       page fetcher. NOT an answer about the row.
 *
 * THE `"none"` TRAP. Grants.gov does not omit an absent award figure — it sends
 * the literal STRING "none" (and sometimes "0"). Measured over 16 live rows on
 * 2026-07-16: 9 carried a real figure, 7 said "none"/"0". Any truthiness check
 * (`if (awardCeiling)`) therefore reads "none" as PRESENT and would hand a
 * garbage value downstream — the HUD-Section-4 fabrication class documented in
 * CLAUDE.md, but arriving through a source the plausibility guard deliberately
 * trusts (`isOfficialAmountSource`), so nothing further downstream would catch
 * it. `parseApiAmount` is the choke point: it is the ONLY place these values
 * become numbers, and it rejects every non-positive/non-numeric form.
 */

import { createLogger } from '../../utils/logger.js'
import { AMOUNT_CONFIDENCE_STRUCTURED } from '../awardAmountExtractor.js'
import {
  GRANTS_GOV_SEARCH2_URL,
  GRANTS_GOV_API_KEY_ENV,
} from '../../config/grantsGovEndpoints.js'

const log = createLogger('service:grantsGovAmountAdapter')

/** Grants.gov single-opportunity detail API (award figures live here, not in search2). */
export const GRANTS_GOV_FETCH_OPPORTUNITY_URL = 'https://api.grants.gov/v1/api/fetchOpportunity'

/** Network timeout for one API call. */
const API_TIMEOUT_MS = 20_000

/**
 * Row shapes that are a Grants.gov opportunity. Both spellings are in live use
 * (`grants.gov` from the connectors, `grants_gov` from the crawler-os adapter /
 * record_origin), so match either.
 */
const RE_GRANTS_GOV_SOURCE = /^grants[._]?gov$/i

/** Detail/view URLs carry the numeric opportunity id we need for the API. */
const RE_DETAIL_URL_ID = /grants\.gov\/(?:search-results-detail|view-opportunity)\/(\d+)/i

/** Any grants.gov URL at all (used to decide this row is ours even without an id). */
const RE_GRANTS_GOV_HOST = /(?:^|\/\/|\.)grants\.gov(?:\/|$)/i

/**
 * Parse an award figure out of the Grants.gov API.
 *
 * Returns a positive finite number, or null for EVERY other case — including the
 * literal strings "none"/"null"/"n/a", "0", "", and undefined. Null here means
 * "the API published no figure", which is a real, honest answer; it must never
 * be confused with a number. See "THE `none` TRAP" in the module header.
 *
 * $0 is deliberately not an award figure: grants.gov uses "0" the same way it
 * uses "none" — as a placeholder for unpopulated — and a $0 ceiling is not a
 * fact any applicant can use.
 *
 * Exported for tests.
 */
export function parseApiAmount(value) {
  if (value === null || value === undefined) return null
  const raw = String(value).trim().toLowerCase()
  if (raw === '' || raw === 'none' || raw === 'null' || raw === 'n/a' || raw === 'na') return null
  // Strip formatting ($, commas) but NOT digits/decimal — a value that is not a
  // clean number after this is not something we are willing to guess about.
  const cleaned = raw.replace(/[$,\s]/g, '')
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null
  const num = Number.parseFloat(cleaned)
  if (!Number.isFinite(num) || num <= 0) return null
  return num
}

/** Is this catalog row a Grants.gov opportunity? Pure; exported for tests. */
export function isGrantsGovRow(row) {
  const source = String(row?.source ?? '').trim()
  if (RE_GRANTS_GOV_SOURCE.test(source)) return true
  const origin = String(row?.record_origin ?? '').trim()
  if (RE_GRANTS_GOV_SOURCE.test(origin)) return true
  for (const url of [row?.source_url, row?.application_url, row?.evidence_url]) {
    if (url && RE_GRANTS_GOV_HOST.test(String(url))) return true
  }
  return false
}

/**
 * Pull the numeric grants.gov opportunity id straight out of a row's URLs.
 * Null when no URL carries one (the row may still be resolvable by its
 * opportunity NUMBER — see resolveOpportunityId). Pure; exported for tests.
 */
export function extractOpportunityIdFromUrl(row) {
  for (const url of [row?.source_url, row?.application_url, row?.evidence_url]) {
    const m = String(url ?? '').match(RE_DETAIL_URL_ID)
    if (m) return m[1]
  }
  return null
}

function apiHeaders() {
  const key = process.env[GRANTS_GOV_API_KEY_ENV] || ''
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(key ? { 'X-API-Key': key } : {}),
  }
}

/**
 * POST a JSON body to a Grants.gov API endpoint.
 *
 * Returns { ok, data, status, transient }. Never throws: like the rest of the
 * enrichment path, failures are REPORTED so the caller's burn/retry rule can see
 * them (a thrown error would be invisible to the sweep's decision).
 */
async function postJson(url, body, { fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const status = res?.status ?? null
    if (!res?.ok) {
      // 4xx is grants.gov telling us something stable about this id; 5xx/429 is a
      // bad night. Mirrors isTransientFetchFailure in amountEnrichment.js.
      const code = Number(status)
      const transient = !Number.isFinite(code) || code === 408 || code === 429 || code >= 500
      return { ok: false, data: null, status, transient }
    }
    const data = await res.json()
    // errorcode != 0 is an application-level refusal (bad id, malformed request)
    // delivered inside an HTTP 200 — stable, not a bad night.
    if (data && Number(data.errorcode) !== 0) {
      return { ok: false, data: null, status, transient: false, apiError: data?.msg ?? 'errorcode' }
    }
    return { ok: true, data, status, transient: false }
  } catch (err) {
    // Abort/DNS/TLS/socket — transport, not a fact about the opportunity.
    return { ok: false, data: null, status: null, transient: true, error: String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve a row to a grants.gov numeric opportunity id.
 *
 * Ladder: the id in the row's own URL (free, exact) → a search2 lookup by the
 * row's opportunity NUMBER (`source_id`, e.g. "PA-FPH-27-001"). The number
 * lookup costs a request, so it only runs when the URL has no id.
 *
 * Returns { id, transient } — `transient` true means we could not resolve
 * because the lookup itself failed, which must NOT be recorded as "this row has
 * no amount".
 */
export async function resolveOpportunityId(row, { fetchImpl = fetch } = {}) {
  const fromUrl = extractOpportunityIdFromUrl(row)
  if (fromUrl) return { id: fromUrl, transient: false }

  const oppNum = String(row?.source_id ?? '').trim()
  if (!oppNum) return { id: null, transient: false }

  const res = await postJson(
    GRANTS_GOV_SEARCH2_URL,
    {
      rows: 2,
      // Include closed: an opportunity in an active pipeline may have closed
      // since ingest, and its award figures are still the honest historical fact.
      oppStatuses: 'forecasted|posted|closed',
      oppNum,
      startRecordNum: 0,
      keyword: '',
    },
    { fetchImpl },
  )
  if (!res.ok) return { id: null, transient: res.transient }

  const node = res.data?.data ?? res.data
  const hits = Array.isArray(node?.oppHits) ? node.oppHits : []
  // Require an EXACT opportunity-number match. search2 is a search endpoint: a
  // near-miss hit is a different program, and taking hits[0] unconditionally is
  // the sort-without-a-floor class that attached strangers' emails to Yana leads.
  const exact = hits.find((h) => String(h?.number ?? '').trim().toLowerCase() === oppNum.toLowerCase())
  const id = exact?.id ?? null
  return { id: id ? String(id) : null, transient: false }
}

/**
 * Fetch award figures for a grants.gov opportunity id.
 *
 * Award data lives on `data.synopsis` for posted opportunities and on
 * `data.forecast` for forecasted ones — a forecasted row has NO synopsis node at
 * all (verified live 2026-07-16 against id 334092), so reading only `synopsis`
 * would silently return "no amount" for every forecasted opportunity.
 *
 * Returns { ok, transient, amount_min, amount_max } where ok:true with both
 * amounts null is the honest "grants.gov publishes no figure for this one".
 */
export async function fetchGrantsGovAward(opportunityId, { fetchImpl = fetch } = {}) {
  const id = Number.parseInt(String(opportunityId), 10)
  if (!Number.isFinite(id)) return { ok: false, transient: false, amount_min: null, amount_max: null }

  const res = await postJson(GRANTS_GOV_FETCH_OPPORTUNITY_URL, { opportunityId: id }, { fetchImpl })
  if (!res.ok) return { ok: false, transient: res.transient, amount_min: null, amount_max: null }

  const data = res.data?.data ?? null
  const node = data?.synopsis ?? data?.forecast ?? null
  if (!node) return { ok: false, transient: false, amount_min: null, amount_max: null, reason: 'no_synopsis_or_forecast' }

  return {
    ok: true,
    transient: false,
    amount_min: parseApiAmount(node.awardFloor),
    amount_max: parseApiAmount(node.awardCeiling),
  }
}

/**
 * enrichAmountViaGrantsGovApi — the adapter entry point.
 *
 * Contract-compatible with `enrichOpportunityAmountFromSource` so the sweep's
 * burn/retry decision needs no special-casing.
 *
 * @param {object} row catalog row (source/source_id/source_url/application_url)
 * @param {object} deps injectable { fetchImpl }
 * @returns {Promise<{attempted:boolean, page_read:boolean, transient:boolean, found:boolean, reason?:string, amounts?:object}>}
 */
export async function enrichAmountViaGrantsGovApi(row, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const miss = (reason) => ({ attempted: false, page_read: false, transient: false, found: false, reason })

  if (!isGrantsGovRow(row)) return miss('not_grants_gov')

  try {
    const { id, transient: resolveTransient } = await resolveOpportunityId(row, { fetchImpl })
    if (!id) {
      // Could not resolve. If the LOOKUP failed we must say so as a transient
      // ATTEMPT (the row is ours, we just could not read it tonight); if there
      // was simply nothing to resolve from, the adapter does not apply and the
      // caller falls back to the page fetcher.
      return resolveTransient
        ? { attempted: true, page_read: false, transient: true, found: false, reason: 'grants_gov_id_lookup_failed' }
        : miss('grants_gov_id_unresolvable')
    }

    const award = await fetchGrantsGovAward(id, { fetchImpl })
    if (!award.ok) {
      return {
        attempted: true,
        page_read: false,
        transient: award.transient === true,
        found: false,
        reason: `grants_gov_api_failed:${award.reason ?? 'unknown'}`,
      }
    }

    const { amount_min, amount_max } = award
    if (amount_min === null && amount_max === null) {
      // A REAL answer: grants.gov itself publishes no award figure for this
      // opportunity ("none"/"0"). page_read:true so the sweep stops asking —
      // re-reading an authoritative API nightly cannot change this.
      return {
        attempted: true,
        page_read: true,
        transient: false,
        found: false,
        reason: 'no_award_amount_published',
      }
    }

    const status = amount_min !== null && amount_max !== null && amount_min === amount_max ? 'known' : 'range'
    return {
      attempted: true,
      page_read: true,
      transient: false,
      found: true,
      reason: 'grants_gov_api',
      amounts: {
        amount_min,
        amount_max,
        amount_text: null,
        amount_status: status,
        // Structured figures straight from the official API — the SAME numeric
        // confidence resolveOpportunityAmounts assigns a source's own
        // structured fields. `amount_confidence` is a REAL column, so this must
        // be a number: shipping the string 'high' here typechecked, passed every
        // unit test (SQLite is typeless), and threw `invalid input syntax for
        // type real: "high"` on Postgres in prod — after the sweep had already
        // marked the row attempted. Never hand-write this value.
        amount_confidence: AMOUNT_CONFIDENCE_STRUCTURED,
      },
    }
  } catch (err) {
    // Defence in depth: this module is "never throws" like its sibling, so a
    // throw reaching here is a bug, not a fact about the row → retryable.
    log.warn(`[grantsGovAmountAdapter] failed for "${row?.title ?? '?'}": ${err?.message ?? err}`)
    return { attempted: true, page_read: false, transient: true, found: false, reason: `error:${err?.message ?? 'unknown'}` }
  }
}

export default {
  enrichAmountViaGrantsGovApi,
  isGrantsGovRow,
  parseApiAmount,
  extractOpportunityIdFromUrl,
  resolveOpportunityId,
  fetchGrantsGovAward,
  GRANTS_GOV_FETCH_OPPORTUNITY_URL,
}
