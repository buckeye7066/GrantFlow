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
 * This service resolves ONE opportunity's award figures by two strategies, in
 * order:
 *
 *   1. AN API ADAPTER (services/sources/amountAdapters.js), when the row's
 *      source publishes its award figures over its own API. This exists because
 *      strategy 2 is structurally impossible for the largest sources:
 *      grants.gov/sam.gov render detail pages client-side, so the fetcher gets a
 *      JS shell and this service returns `thin_page` every night forever
 *      regardless of budget (grants.gov = 45 of 149 backlog rows, prod
 *      2026-07-15). A source's own API is more authoritative than its HTML.
 *   2. THE PAGE FETCH — the generic strategy: fetch source_url through the
 *      crawler-os production fetcher (safe-URL validation, DNS-rebinding guard,
 *      redirect validation, timeout) and run the conservative
 *      awardAmountExtractor over the page text.
 *
 * Precision doctrine unchanged across both: only explicit per-award phrasings
 * (or a source's own structured award fields) yield numbers; program totals stay
 * text-only. Reading the funder's own page or API is EVIDENCE, not invention (G0).
 *
 * Consumed by the enforceAmountEnrichment boot sweep (bounded per boot) and
 * usable ad-hoc by admin tooling. Best-effort: never throws.
 */

import { extractAwardAmountsFromText } from './awardAmountExtractor.js'
import { htmlToText } from './webGrantExtractor.js'
import { AMOUNT_ADAPTERS } from './sources/amountAdapters.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('service:amountEnrichment')

/** Max characters of page text scanned for amounts (amounts sit in body copy). */
const PAGE_TEXT_MAX_CHARS = 12_000

/**
 * Was this fetch failure worth retrying?
 *
 * This service NEVER throws (see the header), so callers cannot use try/catch to
 * tell "the host 503'd tonight" from "this page genuinely has no award figure".
 * The enforceAmountEnrichment sweep did exactly that and its catch block was
 * dead code, so every outage permanently burned the rows it touched. The
 * distinction has to be reported in the RETURN VALUE, which is what
 * `transient` is for.
 *
 * 5xx/429/408 and transport-level errors (no status at all: DNS, TLS, timeout,
 * socket reset) are the provider having a bad night. A 4xx is the provider
 * telling us something stable and true about the URL — retrying it nightly
 * would burn budget forever and never learn anything new.
 */
export function isTransientFetchFailure({ status = null } = {}) {
  if (status === null || status === undefined) return true
  const code = Number(status)
  if (!Number.isFinite(code)) return true
  if (code === 408 || code === 429) return true
  return code >= 500
}

/**
 * enrichOpportunityAmountFromSource — read the opportunity's own source page
 * and extract per-award amounts from it.
 *
 * `page_read` is the field the caller's one-shot attempt mark must key off: it
 * is true only when real page text was actually scanned by the extractor. A
 * fetch that never delivered readable text teaches us NOTHING about the row, so
 * marking it "attempted" on that basis is a lie that costs the row its chance
 * forever. `transient` then says whether a retry could plausibly do better.
 *
 * @param {object} opportunity row-ish object with source_url/application_url/evidence_url, title
 * @param {object} deps injectable: { fetcher } (crawler-os fetcher: { fetch(url) → {ok, body, status} })
 * @returns {Promise<{attempted:boolean, page_read:boolean, transient:boolean, found:boolean, reason?:string, amounts?:object}>}
 */
export async function enrichOpportunityAmountFromSource(opportunity, deps = {}) {
  let fetcher = deps.fetcher
  try {
    // ADAPTER FIRST. Some sources cannot be read by fetching at all: grants.gov
    // and sam.gov render their detail pages client-side, so the fetcher receives
    // a JS shell, the extractor never sees award copy, and this function returns
    // `thin_page` every single night no matter how large the budget. Those rows
    // are not a long tail — grants.gov alone was 45 of the 149 remaining backlog
    // rows in the 2026-07-15 prod audit. When a source publishes the figure over
    // its own API, that API is both cheaper and MORE authoritative than parsing
    // its HTML, so it is consulted before any page fetch.
    //
    // An adapter that does not recognize the row returns `attempted:false` and we
    // fall through — first to any LATER adapter that also matches (a row can
    // carry a grants.gov source_url AND a sam.gov /fal/ evidence_url; if the
    // primary adapter cannot identify it, the secondary one still deserves its
    // chance), then to the page fetcher unchanged. The adapter lane can never
    // cost a row its chance at the generic strategy.
    if (deps.findAdapter) {
      const adapter = deps.findAdapter(opportunity)
      if (adapter) {
        const viaApi = await adapter.enrich(opportunity, deps)
        if (viaApi?.attempted) return viaApi
      }
    } else {
      for (const adapter of AMOUNT_ADAPTERS) {
        let matches = false
        try { matches = adapter.matches(opportunity) } catch { matches = false }
        if (!matches) continue
        const viaApi = await adapter.enrich(opportunity, deps)
        if (viaApi?.attempted) return viaApi
      }
    }

    if (!fetcher) {
      const { makeProductionFetcher } = await import('./crawlerOsService.js')
      fetcher = makeProductionFetcher()
    }
    const url =
      opportunity?.source_url ?? opportunity?.application_url ?? opportunity?.evidence_url ?? null
    if (!url) return { attempted: false, page_read: false, transient: false, found: false, reason: 'no_url' }

    const res = await fetcher.fetch(url)
    if (!res?.ok || !res.body) {
      return {
        attempted: true,
        page_read: false,
        transient: isTransientFetchFailure({ status: res?.status ?? null }),
        found: false,
        reason: `fetch_failed:${res?.status ?? res?.error ?? 'unknown'}`,
      }
    }
    const text = htmlToText(res.body, PAGE_TEXT_MAX_CHARS)
    if (text.length < 200) {
      // A 200 that yields under 200 characters is a JS-rendered shell (sam.gov,
      // grants.gov) or an interstitial — stable, not a bad night, so retrying
      // it nightly would burn budget forever. Not page_read either: the
      // extractor never saw the award copy, so we have NOT learned that this
      // opportunity lacks an amount. Reaching these hosts needs an API adapter,
      // not another fetch.
      return { attempted: true, page_read: false, transient: false, found: false, reason: 'thin_page' }
    }

    const result = extractAwardAmountsFromText(text)
    const hasNumber = typeof result.amount_min === 'number' || typeof result.amount_max === 'number'
    if (!hasNumber) {
      // Still useful: a "varies"/"contact funder" status or a program-total
      // excerpt is more honest than a blank — surface it for the caller to
      // persist as text/status only. page_read: the extractor DID scan this
      // page's copy and found no per-award figure — a real answer about the
      // row, so the caller is right to stop asking.
      return {
        attempted: true,
        page_read: true,
        transient: false,
        found: false,
        reason: 'no_per_award_amount_on_page',
        amount_text: result.amount_text ?? null,
        amount_status: result.amount_status ?? null,
      }
    }
    return { attempted: true, page_read: true, transient: false, found: true, amounts: result }
  } catch (err) {
    // A throw here is the fetcher blowing up (DNS, TLS, abort) — transport, not
    // a fact about the opportunity. Retryable.
    log.warn(`[amountEnrichment] failed for "${opportunity?.title ?? '?'}": ${err?.message ?? err}`)
    return { attempted: true, page_read: false, transient: true, found: false, reason: `error:${err?.message ?? 'unknown'}` }
  }
}
