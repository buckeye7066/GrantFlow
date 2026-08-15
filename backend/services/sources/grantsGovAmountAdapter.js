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
 *   environment: true — 401/403/429: OUR egress is blocked (WAF, missing key,
 *                       rate limit), which is a fact about the deploy
 *                       environment and NEVER about the row. Always also
 *                       transient; the sweep additionally exempts it from the
 *                       out-of-retries burn, because a blocked environment
 *                       fails every row identically until an owner fixes it
 *                       (registering GRANTS_GOV_API_KEY may bypass the WAF).
 *   attempted: false  — this row is not a grants.gov row we can identify, so the
 *                       adapter did nothing and the caller must fall back to the
 *                       page fetcher. NOT an answer about the row.
 *
 *   `status` (HTTP) and `reason` ride along on failures so the sweep's failure
 *   telemetry (system_kv `amount_enrich_failure_log`) can name the outage class
 *   without a prod DB spelunk.
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
  SIMPLER_GRANTS_OPPORTUNITY_URL,
  SIMPLER_GRANTS_API_KEY_ENV,
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
      // Most 4xx (404 above all) is grants.gov telling us something stable about
      // THIS id; 5xx/408 is a bad night. But 401/403/429 are facts about OUR
      // EGRESS — a WAF block, missing/invalid API key, or rate limiting — not
      // about the opportunity. Prod 2026-07-21: the identical keyless call
      // succeeds from a residential machine while every Railway attempt fails,
      // so a WAF 403 treated as "stable" burned each row's one-shot mark
      // answerless (127 attempted, 0 evidenced answers). Environment failures
      // are reported as `environment: true` AND transient, so the sweep leaves
      // the row retryable instead of burning a fact we never learned.
      const code = Number(status)
      const environment = code === 401 || code === 403 || code === 429
      const transient = !Number.isFinite(code) || environment || code === 408 || code >= 500
      return { ok: false, data: null, status, transient, environment }
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
 * Returns { id, transient, environment?, status? } — `transient` true means we
 * could not resolve because the lookup itself failed, which must NOT be
 * recorded as "this row has no amount"; `environment` true means the failure
 * was about OUR egress (WAF 403 / 401 / 429), not this row; `status` is the
 * HTTP status of the failed lookup for telemetry.
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
  if (!res.ok) return { id: null, transient: res.transient, environment: res.environment === true, status: res.status ?? null }

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
 * Returns { ok, transient, environment?, status?, reason?, amount_min,
 * amount_max } where ok:true with both amounts null is the honest "grants.gov
 * publishes no figure for this one". On failure, `reason`/`status` say WHY for
 * the failure telemetry (http_403 from a WAF is a very different outage than
 * api_refusal for a dead id).
 */
export async function fetchGrantsGovAward(opportunityId, { fetchImpl = fetch } = {}) {
  const id = Number.parseInt(String(opportunityId), 10)
  if (!Number.isFinite(id)) return { ok: false, transient: false, amount_min: null, amount_max: null, reason: 'bad_id' }

  const res = await postJson(GRANTS_GOV_FETCH_OPPORTUNITY_URL, { opportunityId: id }, { fetchImpl })
  if (!res.ok) {
    return {
      ok: false,
      transient: res.transient,
      environment: res.environment === true,
      status: res.status ?? null,
      reason: res.apiError ? 'api_refusal' : (res.status ? `http_${res.status}` : 'transport'),
      amount_min: null,
      amount_max: null,
    }
  }

  const data = res.data?.data ?? null
  // The API's own "this record is gone" answer (verified live 2026-08-15 on
  // ids 338441/355786/360509): HTTP 200, "Webservice Succeeds", and a data
  // node whose errorMessages read "There is no record found for your search."
  // — grants.gov has RETIRED/ARCHIVED the listing. That is a definitive fact
  // about the row, not a parse failure: reporting it as
  // `no_synopsis_or_forecast` made 6 active-pipeline rows red the owner's
  // report as "needs an API adapter" forever, for records the adapter had
  // asked about and been answered about. Marked (not returned as ok) so the
  // Simpler Grants second door still gets its chance — its archive can carry
  // records grants.gov no longer lists.
  const apiErrors = Array.isArray(data?.errorMessages) ? data.errorMessages : []
  const recordRetired = apiErrors.some((m) => /no record found/i.test(String(m ?? '')))
  const node = data?.synopsis ?? data?.forecast ?? null
  if (!node) {
    return recordRetired
      ? { ok: false, transient: false, record_retired: true, amount_min: null, amount_max: null, reason: 'record_not_found' }
      : { ok: false, transient: false, amount_min: null, amount_max: null, reason: 'no_synopsis_or_forecast' }
  }

  return {
    ok: true,
    transient: false,
    amount_min: parseApiAmount(node.awardFloor),
    amount_max: parseApiAmount(node.awardCeiling),
    program_total_text: programTotalText(node.estimatedFunding, node.expectedNumberOfAwards),
  }
}

/**
 * Honest text label for "no per-award figure, but the source DOES publish the
 * program envelope". Program totals must NEVER become amount_min/amount_max
 * (the #958 aggregate-precision class: $237,500 recorded for a $20,000 award)
 * — but throwing the envelope away entirely repeats the #954 discarded-fact
 * sin. Text-only is the doctrine's own middle: `resolveOpportunityAmounts`
 * keeps program totals as amount_text, so this label rides the sweep's
 * page_read branch into the same column. Exported for tests.
 */
export function programTotalText(total, count) {
  const t = parseApiAmount(total)
  if (t === null) return null
  const n = Number.parseInt(String(count ?? ''), 10)
  const countNote = Number.isFinite(n) && n > 0 ? ` across ~${n} expected award${n === 1 ? '' : 's'}` : ''
  return `No per-award figure published; estimated program total $${t.toLocaleString('en-US')}${countNote}`
}

/**
 * GET a JSON document with the same reported-failure semantics as postJson:
 * { ok, data, status, transient, environment }. Never throws.
 */
async function getJson(url, { fetchImpl = fetch, headers = {} } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
    const status = res?.status ?? null
    if (!res?.ok) {
      const code = Number(status)
      const environment = code === 401 || code === 403 || code === 429
      const transient = !Number.isFinite(code) || environment || code === 408 || code >= 500
      return { ok: false, data: null, status, transient, environment }
    }
    return { ok: true, data: await res.json(), status, transient: false }
  } catch (err) {
    return { ok: false, data: null, status: null, transient: true, error: String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch award figures from the SIMPLER GRANTS API (api.simpler.grants.gov) by
 * the LEGACY grants.gov opportunity id — the same numeric id our rows' URLs
 * carry (`GET /v1/opportunities/{legacy_opportunity_id}`, verified live
 * 2026-07-22 against id 112354).
 *
 * WHY A SECOND DOOR TO THE SAME FACTS. api.grants.gov is fronted by a WAF that
 * 403s every call from the production egress (prod 2026-07-21: 127 attempts, 0
 * answers, while the identical keyless call succeeds from a residential
 * machine). Simpler Grants is HHS's own replacement API for the same dataset,
 * on separate infrastructure, key-authenticated (SIMPLER_GRANTS_API_KEY — set
 * in prod) — so when the primary door is environment-blocked, the same
 * authoritative figures are still one GET away. Same-shape result as
 * fetchGrantsGovAward, plus `program_total_text` (the honest envelope label
 * when no per-award figure exists). Exported for tests.
 */
export async function fetchSimplerGrantsAward(legacyOpportunityId, { fetchImpl = fetch } = {}) {
  const id = Number.parseInt(String(legacyOpportunityId), 10)
  if (!Number.isFinite(id)) return { ok: false, transient: false, amount_min: null, amount_max: null, reason: 'bad_id' }
  const key = process.env[SIMPLER_GRANTS_API_KEY_ENV] || ''
  if (!key) return { ok: false, transient: false, amount_min: null, amount_max: null, reason: 'no_simpler_key' }

  const res = await getJson(`${SIMPLER_GRANTS_OPPORTUNITY_URL}/${id}`, {
    fetchImpl,
    headers: { Accept: 'application/json', 'X-API-Key': key },
  })
  if (!res.ok) {
    return {
      ok: false,
      transient: res.transient,
      environment: res.environment === true,
      status: res.status ?? null,
      reason: res.status ? `http_${res.status}` : 'transport',
      amount_min: null,
      amount_max: null,
    }
  }
  const summary = res.data?.data?.summary ?? null
  if (!summary) return { ok: false, transient: false, amount_min: null, amount_max: null, reason: 'no_summary' }
  return {
    ok: true,
    transient: false,
    amount_min: parseApiAmount(summary.award_floor),
    amount_max: parseApiAmount(summary.award_ceiling),
    program_total_text: programTotalText(summary.estimated_total_program_funding, summary.expected_number_of_awards),
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
    const resolved = await resolveOpportunityId(row, { fetchImpl })
    const { id, transient: resolveTransient } = resolved
    if (!id) {
      // Could not resolve. If the LOOKUP failed we must say so as a transient
      // ATTEMPT (the row is ours, we just could not read it tonight); if there
      // was simply nothing to resolve from, the adapter does not apply and the
      // caller falls back to the page fetcher.
      return resolveTransient
        ? {
            attempted: true,
            page_read: false,
            transient: true,
            environment: resolved.environment === true,
            status: resolved.status ?? null,
            found: false,
            reason: resolved.status ? `grants_gov_id_lookup_failed:http_${resolved.status}` : 'grants_gov_id_lookup_failed',
          }
        : miss('grants_gov_id_unresolvable')
    }

    let award = await fetchGrantsGovAward(id, { fetchImpl })
    let lane = 'grants_gov_api'
    if (!award.ok) {
      // SECOND DOOR: the same figures over Simpler Grants (separate HHS infra,
      // key-gated). Tried on ANY primary failure — most valuably the WAF-403
      // environment block that has refused every prod call since 2026-07-21,
      // but a transient primary outage loses nothing by asking too. A fallback
      // that is unavailable (no key) or fails changes NOTHING about how the
      // primary failure is reported below.
      const fallback = await fetchSimplerGrantsAward(id, { fetchImpl })
      if (fallback.ok) {
        award = fallback
        lane = 'simpler_grants_api'
      }
    }
    if (!award.ok) {
      // The primary API definitively answered "no record found" (retired /
      // archived listing) and the fallback could not improve on it: that is a
      // READ, not a failure. page_read:true burns the row — re-asking an
      // authoritative API nightly about a record it says is gone cannot change
      // the answer — and the honest label rides amount_text so the row reads
      // as answered (none published; listing retired), never as adapter work.
      if (award.record_retired === true) {
        return {
          attempted: true,
          page_read: true,
          transient: false,
          found: false,
          reason: 'grants_gov_record_retired',
          amount_text: 'grants.gov no longer lists this opportunity (retired or archived listing)',
        }
      }
      return {
        attempted: true,
        page_read: false,
        transient: award.transient === true,
        // WAF/auth/quota (401/403/429): a fact about OUR egress, not this row.
        // The sweep must not let it consume the row's one-shot mark — even via
        // "out of retries" — because a blocked environment fails EVERY row
        // identically until an owner action (API key / egress change) fixes it.
        environment: award.environment === true,
        status: award.status ?? null,
        found: false,
        reason: `grants_gov_api_failed:${award.reason ?? 'unknown'}`,
      }
    }

    const { amount_min, amount_max } = award
    if (amount_min === null && amount_max === null) {
      // A REAL answer: grants.gov itself publishes no award figure for this
      // opportunity ("none"/"0"). page_read:true so the sweep stops asking —
      // re-reading an authoritative API nightly cannot change this. When the
      // API DID publish the program envelope, it rides along as an honest
      // TEXT label (never a number — the #958 aggregate doctrine).
      return {
        attempted: true,
        page_read: true,
        transient: false,
        found: false,
        reason: 'no_award_amount_published',
        amount_text: award.program_total_text ?? null,
      }
    }

    const status = amount_min !== null && amount_max !== null && amount_min === amount_max ? 'known' : 'range'
    return {
      attempted: true,
      page_read: true,
      transient: false,
      found: true,
      reason: lane,
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
  programTotalText,
  extractOpportunityIdFromUrl,
  resolveOpportunityId,
  fetchGrantsGovAward,
  fetchSimplerGrantsAward,
  GRANTS_GOV_FETCH_OPPORTUNITY_URL,
}
