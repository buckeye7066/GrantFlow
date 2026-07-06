/**
 * amountEnrichment.js — crawl-time per-award dollar acquisition.
 *
 * THE GAP (2026-07-06 prod audit): only ~18% of funding_opportunities rows
 * carry any dollar figure, so most pipelines honestly sum to $0 even when
 * full of real, relevant sources. The description text stored at ingest is
 * often one aggregator sentence — but the funder's OWN page (source_url)
 * usually states the award ("grants of up to $5,000"). Nothing ever went
 * back to read it.
 *
 * This service fetches ONE opportunity's source page through the crawler-os
 * production fetcher (safe-URL validation, DNS-rebinding guard, redirect
 * validation, timeout) and runs the conservative awardAmountExtractor over
 * the page text. Precision doctrine unchanged: only explicit per-award
 * phrasings yield numbers; program totals stay text-only. Extraction from
 * the funder's own page is EVIDENCE, not invention (G0).
 *
 * Consumed by the enforceAmountEnrichment boot sweep (bounded per boot) and
 * usable ad-hoc by admin tooling. Best-effort: never throws.
 */

import { extractAwardAmountsFromText } from './awardAmountExtractor.js'
import { htmlToText } from './webGrantExtractor.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('service:amountEnrichment')

/** Max characters of page text scanned for amounts (amounts sit in body copy). */
const PAGE_TEXT_MAX_CHARS = 12_000

/**
 * enrichOpportunityAmountFromSource — read the opportunity's own source page
 * and extract per-award amounts from it.
 *
 * @param {object} opportunity row-ish object with source_url/application_url/evidence_url, title
 * @param {object} deps injectable: { fetcher } (crawler-os fetcher: { fetch(url) → {ok, body, status} })
 * @returns {Promise<{attempted:boolean, found:boolean, reason?:string, amounts?:object}>}
 */
export async function enrichOpportunityAmountFromSource(opportunity, deps = {}) {
  let fetcher = deps.fetcher
  try {
    if (!fetcher) {
      const { makeProductionFetcher } = await import('./crawlerOsService.js')
      fetcher = makeProductionFetcher()
    }
    const url =
      opportunity?.source_url ?? opportunity?.application_url ?? opportunity?.evidence_url ?? null
    if (!url) return { attempted: false, found: false, reason: 'no_url' }

    const res = await fetcher.fetch(url)
    if (!res?.ok || !res.body) {
      return { attempted: true, found: false, reason: `fetch_failed:${res?.status ?? res?.error ?? 'unknown'}` }
    }
    const text = htmlToText(res.body, PAGE_TEXT_MAX_CHARS)
    if (text.length < 200) return { attempted: true, found: false, reason: 'thin_page' }

    const result = extractAwardAmountsFromText(text)
    const hasNumber = typeof result.amount_min === 'number' || typeof result.amount_max === 'number'
    if (!hasNumber) {
      // Still useful: a "varies"/"contact funder" status or a program-total
      // excerpt is more honest than a blank — surface it for the caller to
      // persist as text/status only.
      return {
        attempted: true,
        found: false,
        reason: 'no_per_award_amount_on_page',
        amount_text: result.amount_text ?? null,
        amount_status: result.amount_status ?? null,
      }
    }
    return { attempted: true, found: true, amounts: result }
  } catch (err) {
    log.warn(`[amountEnrichment] failed for "${opportunity?.title ?? '?'}": ${err?.message ?? err}`)
    return { attempted: true, found: false, reason: `error:${err?.message ?? 'unknown'}` }
  }
}
