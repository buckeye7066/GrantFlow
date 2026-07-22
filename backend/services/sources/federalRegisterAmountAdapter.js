/**
 * federalRegisterAmountAdapter.js — read a Federal Register document's full
 * text through the FR's own API and extract per-award figures from it.
 *
 * WHY THIS EXISTS. 19 active-pipeline rows (prod census 2026-07-22) point at
 * `federalregister.gov/documents/YYYY/MM/DD/<doc>/<slug>` notices that burned
 * as unreadable — the page fetch never yielded extractable award copy. The
 * Federal Register publishes a clean, keyless JSON API
 * (`/api/v1/documents/<doc>.json`) whose `raw_text_url` serves the ENTIRE
 * document as plain text — no JS shell, no truncated fetch, and often several
 * times more text than the HTML fetch's 12k-char window ever saw (award
 * figures in FR notices sit deep in SUPPLEMENTARY INFORMATION).
 *
 * A notice that genuinely states no per-award figure (most Paperwork-Reduction
 * comment requests, for instance) comes back as an evidenced read with no
 * figure → the sweep records the honest denial. That is the answer going green
 * NATURALLY: by reading, not by stamping.
 *
 * NOT AN SSRF SURFACE. The document NUMBER (strictly `\d{4}-\d+`) is parsed
 * out of the row and interpolated into hardcoded federalregister.gov URLs; the
 * API's own `raw_text_url` is followed only when it is on federalregister.gov.
 *
 * HONESTY CONTRACT — same shape as `enrichOpportunityAmountFromSource`; see
 * the grants.gov adapter header for the field semantics.
 */

import { createLogger } from '../../utils/logger.js'
import { extractAwardAmountsFromText } from '../awardAmountExtractor.js'

const log = createLogger('service:federalRegisterAmountAdapter')

/** Federal Register single-document API (keyless). */
export const FEDERAL_REGISTER_DOCUMENT_API = 'https://www.federalregister.gov/api/v1/documents/'

/** Network timeout for one call (two calls per enrich: JSON, then raw text). */
const API_TIMEOUT_MS = 20_000

/**
 * Cap on document text scanned. FR rules run long; the extractor is linear and
 * the figures we care about live in preamble/supplementary sections, so 120k
 * chars (~10× the page fetcher's window) is generous without being unbounded.
 */
const DOC_TEXT_MAX_CHARS = 120_000

/** FR document number: `2025-13802`. Anchored — never a partial match. */
const RE_DOC_NUMBER = /^\d{4}-\d{1,8}$/

/** Document URL: `federalregister.gov/documents/2025/07/23/2025-13802/slug`. */
const RE_DOC_URL = /federalregister\.gov\/documents\/\d{4}\/\d{2}\/\d{2}\/(\d{4}-\d{1,8})(?:\/|$)/i

/** Row source spellings in live use. */
const RE_FR_SOURCE = /^federal[._ ]?register$/i

/** The row's FR document number, or null. Pure; exported for tests. */
export function extractFrDocNumber(row) {
  const sourceId = String(row?.source_id ?? '').trim()
  if (RE_DOC_NUMBER.test(sourceId)) return sourceId
  for (const url of [row?.source_url, row?.application_url, row?.evidence_url]) {
    const m = String(url ?? '').match(RE_DOC_URL)
    if (m) return m[1]
  }
  return null
}

/** Is this row a Federal Register document? Pure; exported for tests. */
export function isFederalRegisterRow(row) {
  if (RE_FR_SOURCE.test(String(row?.source ?? row?.record_origin ?? '').trim())) return true
  for (const url of [row?.source_url, row?.application_url, row?.evidence_url]) {
    if (RE_DOC_URL.test(String(url ?? ''))) return true
  }
  return false
}

/** Shared failure classification for both calls. */
function classifyHttpFailure(status) {
  const code = Number(status)
  const environment = code === 401 || code === 403 || code === 429
  const transient = !Number.isFinite(code) || environment || code === 408 || code >= 500
  return { environment, transient }
}

/**
 * Fetch the document's full plain text. Returns
 * { ok, text, status, transient, environment, reason }. Never throws.
 * Exported for tests.
 */
export async function fetchFrDocumentText(docNumber, { fetchImpl = fetch } = {}) {
  if (!RE_DOC_NUMBER.test(String(docNumber ?? ''))) {
    return { ok: false, transient: false, reason: 'bad_doc_number' }
  }
  const getOnce = async (url, accept) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
    try {
      // redirect:'error' — the host allowlist below is checked BEFORE the
      // fetch, so silently following a redirect would let a poisoned pointer
      // hop off federalregister.gov after passing the check (gate finding). A
      // legitimate FR redirect surfaces as a thrown error → transient, and the
      // row keeps its chance.
      return await fetchImpl(url, { method: 'GET', headers: { Accept: accept }, signal: controller.signal, redirect: 'error' })
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const metaRes = await getOnce(
      `${FEDERAL_REGISTER_DOCUMENT_API}${docNumber}.json?fields[]=raw_text_url&fields[]=title`,
      'application/json',
    )
    if (!metaRes?.ok) {
      const status = metaRes?.status ?? null
      return { ok: false, status, ...classifyHttpFailure(status), reason: status ? `http_${status}` : 'transport' }
    }
    const meta = await metaRes.json()
    const rawUrl = String(meta?.raw_text_url ?? '')
    // Follow the API's own pointer ONLY back onto federalregister.gov — a
    // poisoned/odd payload must never turn this adapter into an open fetcher.
    let host = ''
    try { host = new URL(rawUrl).hostname.toLowerCase() } catch { host = '' }
    if (!host || !(host === 'federalregister.gov' || host.endsWith('.federalregister.gov'))) {
      return { ok: false, status: metaRes.status ?? null, transient: false, reason: 'no_raw_text_url' }
    }
    const textRes = await getOnce(rawUrl, 'text/plain')
    if (!textRes?.ok) {
      const status = textRes?.status ?? null
      return { ok: false, status, ...classifyHttpFailure(status), reason: status ? `http_${status}` : 'transport' }
    }
    const body = await textRes.text()
    const text = String(body ?? '').slice(0, DOC_TEXT_MAX_CHARS)
    if (text.trim().length < 200) return { ok: false, status: textRes.status ?? null, transient: false, reason: 'thin_document' }
    return { ok: true, text, status: textRes.status ?? null, transient: false }
  } catch (err) {
    return { ok: false, status: null, transient: true, reason: `error:${err?.message ?? 'unknown'}` }
  }
}

/**
 * enrichAmountViaFederalRegister — the adapter entry point.
 * Contract-compatible with `enrichOpportunityAmountFromSource`.
 */
export async function enrichAmountViaFederalRegister(row, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  if (!isFederalRegisterRow(row)) {
    return { attempted: false, page_read: false, transient: false, found: false, reason: 'not_federal_register' }
  }
  const docNumber = extractFrDocNumber(row)
  if (!docNumber) {
    // Ours by host but no resolvable document number — let the page fetcher
    // have its ordinary chance rather than answering for a row we cannot
    // actually identify.
    return { attempted: false, page_read: false, transient: false, found: false, reason: 'fr_doc_unresolvable' }
  }
  try {
    const res = await fetchFrDocumentText(docNumber, { fetchImpl })
    if (!res.ok) {
      return {
        attempted: true,
        page_read: false,
        transient: res.transient === true,
        environment: res.environment === true,
        status: res.status ?? null,
        found: false,
        reason: `federal_register_api_failed:${res.reason ?? 'unknown'}`,
      }
    }
    const extracted = extractAwardAmountsFromText(res.text)
    const hasNumber = typeof extracted.amount_min === 'number' || typeof extracted.amount_max === 'number'
    if (!hasNumber) {
      // The FULL document was read and states no per-award figure — an
      // evidenced denial (or a better honest label the text did state).
      return {
        attempted: true,
        page_read: true,
        transient: false,
        found: false,
        reason: 'no_per_award_amount_in_document',
        amount_text: extracted.amount_text ?? null,
        amount_status: extracted.amount_status !== 'not_listed' ? extracted.amount_status : null,
      }
    }
    return { attempted: true, page_read: true, transient: false, found: true, reason: 'federal_register_api', amounts: extracted }
  } catch (err) {
    log.warn(`[federalRegisterAmountAdapter] failed for "${row?.title ?? '?'}": ${err?.message ?? err}`)
    return { attempted: true, page_read: false, transient: true, found: false, reason: `error:${err?.message ?? 'unknown'}` }
  }
}

export default {
  enrichAmountViaFederalRegister,
  isFederalRegisterRow,
  extractFrDocNumber,
  fetchFrDocumentText,
  FEDERAL_REGISTER_DOCUMENT_API,
}
