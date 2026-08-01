/**
 * portalSync/connectors/generic.js
 *
 * Fallback connector for any portal that has a saved login/session but no
 * dedicated connector yet. It proves access (navigates to the portal using the
 * authenticated context Hamilton already holds) AND now runs the shared,
 * selector-independent model-driven extractor (llmPageExtract) so EVERY
 * saved-login portal gets REAL data extraction — not just an empty "no
 * connector" note. This is the global win: a portal without a hand-written
 * connector still yields awards/fields when the model can read them from the
 * authenticated page text.
 *
 * Honesty: the extractor never fabricates. If it finds nothing (or no AI
 * provider is configured), it returns empty arrays with an honest note, which
 * the orchestrator surfaces verbatim.
 *
 * Hamilton owns the URL here too: it derives the destination from the saved
 * credential's login_url when present, else https://<portalHost>/ — the user
 * never has to supply a URL.
 */

import { registrableDomain } from '../../hamiltonPortalCredentialService.js'
import { extractPortalDataWithLLM } from '../llmPageExtract.js'

const GENERIC_NOTE =
  'Signed in successfully, but there is no structured data connector for this portal yet, ' +
  'so no fields were read/written. (A dedicated connector is needed to map this portal.)'

/**
 * Navigation candidates, in order: the saved credential's login_url (the URL the
 * user actually logs in at) first, then https://<host>/, then — when the host is
 * a bare APEX domain — https://www.<host>/. The www fallback matters in prod:
 * goingmerry.com does not resolve (DNS) and coca-colascholarsfoundation.org's
 * apex cert is invalid, but both www. hosts work.
 */
function candidateUrls(ctx) {
  const urls = []
  const loginUrl = ctx?.credential?.login_url || ctx?.credential?.loginUrl || null
  if (loginUrl && /^https?:\/\//i.test(loginUrl)) urls.push(loginUrl)
  const host = String(ctx?.portalHost || '').trim().toLowerCase()
  if (host) {
    urls.push(`https://${host}/`)
    let apex = false
    try { apex = registrableDomain(host) === host } catch { apex = false }
    if (apex && !/^www\./i.test(host)) urls.push(`https://www.${host}/`)
  }
  return [...new Set(urls)]
}

/**
 * Try each candidate URL until one loads. Every failed attempt is recorded (URL
 * + real Playwright error) so the run summary shows exactly what was tried.
 */
async function visit(page, ctx) {
  const attempts = []
  for (const url of candidateUrls(ctx)) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      return { reached: true, url, attempts }
    } catch (err) {
      attempts.push({ url, error: err?.message || String(err) })
    }
  }
  return {
    reached: false,
    url: attempts[attempts.length - 1]?.url || null,
    error: attempts.length
      ? attempts.map((a) => `${a.url}: ${a.error}`).join(' | ')
      : 'no navigable URL for this portal',
    attempts,
  }
}

const generic = {
  id: 'generic',
  label: 'Generic portal (captured session required)',
  hostMatch: /.*/,
  // This connector NEVER fills or submits a login form — it only navigates
  // and extracts from whatever the page shows. A saved username/password
  // therefore cannot authenticate anything here: without a captured browser
  // session the run lands on a login wall, extracts nothing, and used to be
  // recorded as a clean "completed" (the 2026-07-28 audit's misleading-merge
  // class). Requiring a session makes the orchestrator's honesty gate refuse
  // password-only generic syncs up front. A future connector that actually
  // implements a login workflow may relax this for ITS hosts.
  requiresSession: true,

  // Completeness contract (2026-07-28 audit #19): generic LLM extraction cannot
  // certify it read a portal's every domain, so it can NEVER reach the terminal
  // `merged` state — a generic sync that pulls real data reaches at most
  // `partially_synced`. supportsFullMerge:false is what enforces that.
  supportsFullMerge: false,

  async read(page, ctx) {
    const log = ctx?.log || (() => {})
    const nav = await visit(page, ctx)
    if (!nav.reached) {
      // reached:false + error propagate to the orchestrator, which records the
      // run as FAILED with the real navigation error — never a clean
      // "completed" for a portal the browser could not even load.
      return {
        reached: false,
        error: nav.error,
        fields: [],
        awards: [],
        rejected: [],
        notFound: [`Could not reach the portal: ${nav.error}`],
        raw: { navigated: nav },
      }
    }

    // Selector-independent extraction from the authenticated page text.
    const llm = await extractPortalDataWithLLM(page, { log, navCandidates: [nav.url] })
    const notFound = (llm.notFound || []).slice()
    if ((llm.awards || []).length === 0 && (llm.fields || []).length === 0) {
      // Nothing extracted — keep the honest generic note alongside the reason.
      notFound.push(GENERIC_NOTE)
    }
    return {
      fields: llm.fields || [],
      awards: llm.awards || [],
      // Fabrication-guard audit trail: what the extractor REFUSED to record as
      // user awards (listing/marketing entries) — surfaced in the run summary.
      rejected: llm.rejected || [],
      notFound,
      raw: { navigated: nav, llm: llm.raw },
    }
  },

  /**
   * WRITE is now REAL for EVERY portal (owner rule, 2026-08-01: "the two-way
   * sync should be global for all portals"). This used to return GENERIC_NOTE
   * and write nothing, so only MTSU ever pushed anything — every other
   * saved-login portal was a one-way street, pulling data in and never
   * reporting the household's own accepted awards back.
   *
   * It fills and deliberately does NOT submit — see outsideAwardReporter.
   */
  async write(page, ctx, data = {}) {
    const nav = await visit(page, ctx)
    if (!nav.reached) {
      return {
        reached: false,
        error: nav.error,
        written: [],
        skipped: [`Could not reach the portal: ${nav.error}`],
      }
    }
    const { reportOutsideAwards } = await import('../outsideAwardReporter.js')
    const res = await reportOutsideAwards(page, {
      sources: Array.isArray(data?.fundingSources) ? data.fundingSources : [],
      allowSubmit: data?.allowSubmit === true,
      log: ctx?.log,
    })
    return { written: res.written, skipped: res.skipped, submitted: res.submitted }
  },
}

export default generic
