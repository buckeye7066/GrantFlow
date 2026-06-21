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

import { extractPortalDataWithLLM } from '../llmPageExtract.js'

const GENERIC_NOTE =
  'Signed in successfully, but there is no structured data connector for this portal yet, ' +
  'so no fields were read/written. (A dedicated connector is needed to map this portal.)'

function destinationUrl(ctx) {
  const loginUrl = ctx?.credential?.login_url || ctx?.credential?.loginUrl || null
  if (loginUrl && /^https?:\/\//i.test(loginUrl)) return loginUrl
  return `https://${ctx?.portalHost || ''}/`
}

async function visit(page, ctx) {
  const url = destinationUrl(ctx)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    return { reached: true, url }
  } catch (err) {
    return { reached: false, url, error: err?.message || String(err) }
  }
}

const generic = {
  id: 'generic',
  label: 'Generic portal (sign-in only)',
  hostMatch: /.*/,

  async read(page, ctx) {
    const log = ctx?.log || (() => {})
    const nav = await visit(page, ctx)
    if (!nav.reached) {
      return { fields: [], awards: [], notFound: [`Could not reach ${nav.url}: ${nav.error}`], raw: { navigated: nav } }
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
      notFound,
      raw: { navigated: nav, llm: llm.raw },
    }
  },

  async write(page, ctx /*, data */) {
    const nav = await visit(page, ctx)
    return {
      written: [],
      skipped: [nav.reached ? GENERIC_NOTE : `Could not reach ${nav.url}: ${nav.error}`],
    }
  },
}

export default generic
