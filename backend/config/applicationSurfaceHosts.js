/**
 * Pages that are STRUCTURALLY never a funder's application surface.
 *
 * WHY THIS EXISTS — measured, not theorised. Hamilton's runtime URL rescue
 * accepts a page when it is live and ≥60% of the opportunity title's
 * significant tokens appear in the hit's title, snippet, or URL. There is no
 * check that the page carries an application at all. On production, during the
 * run the owner was watching on 2026-08-21, that bar accepted — each of these
 * is a verbatim `url_rescue` event message from `application_task_events`:
 *
 *   https://en.wikipedia.org/wiki/NeighborWorks_America
 *   https://www.mjnewellhomes.com/blog/section-8-housing-voucher-program-florida
 *   https://nationaltaxreports.com/property-tax-exemption-for-seniors-in-california/
 *   https://trendsnbest.com/housing-programs-for-single-mothers/
 *   https://www.debt.org/advice/cant-pay-my-utility-bills/
 *   https://www.needhelppayingbills.com/html/disability_grants.html
 *   https://www.keela.co/grants/type/seniors
 *   https://www.wemakescholars.com/other-scholarships-in-gender-studies-to-study-abroad
 *
 * An encyclopedia article about a funder passes the token test perfectly — it
 * is literally named after the funder — which is exactly why token overlap
 * alone cannot be the bar. A realtor's blog post about Section 8 shares every
 * significant token with a Section 8 program and offers nothing to apply to.
 *
 * WHAT THIS IS NOT. It is not a quality filter and it is not a denylist of
 * "bad" sites — several of these are useful pages. It answers ONE question:
 * could this URL be the page where an applicant submits an application to this
 * funder? For an encyclopedia article, a marketing blog post, or a software
 * vendor's content page, the answer is structurally no.
 *
 * MISSING = NEUTRAL. A host this file does not recognise is NOT rejected; it
 * simply does not gain the benefit of the doubt from here. Nothing in this
 * file widens any gate — it can only refuse.
 */

/**
 * Reference works. An article ABOUT an organisation is never that
 * organisation's application form, in any language edition.
 */
export const ENCYCLOPEDIA_HOST_PATTERNS = Object.freeze([
  /(^|\.)wikipedia\.org$/i,
  /(^|\.)wikiwand\.com$/i,
  /(^|\.)britannica\.com$/i,
  /(^|\.)wikidata\.org$/i,
  /(^|\.)dbpedia\.org$/i,
  /(^|\.)fandom\.com$/i,
])

/**
 * Path shapes that declare the page is an ARTICLE about a topic rather than a
 * transaction with a funder. Matched on the path only, so a funder whose own
 * application lives at `/apply` is untouched even if its site also has a blog.
 *
 * `/blog/` is what `mjnewellhomes.com/blog/section-8-housing-voucher-program-florida`
 * announces about itself; `/advice/` is what `debt.org/advice/...` announces.
 */
export const EDITORIAL_PATH_PATTERNS = Object.freeze([
  /\/blog(\/|$)/i,
  /\/blogs\//i,
  /\/advice(\/|$)/i,
  /\/articles?(\/|$)/i,
  /\/news(\/|$)/i,
  /\/press-releases?(\/|$)/i,
  /\/guides?(\/|$)/i,
  /\/resources?\/(?:article|guide|blog)/i,
  /\/wiki\//i,
])

/**
 * Content-marketing and lead-generation sites whose entire business is writing
 * ABOUT benefit programmes they do not administer. Every entry here was
 * observed being accepted as an "application page" in production.
 *
 * These are deliberately listed by host rather than inferred, because their
 * pages are indistinguishable from a real programme page by shape alone —
 * that is the product they sell.
 */
export const CONTENT_FARM_HOST_PATTERNS = Object.freeze([
  /(^|\.)nationaltaxreports\.com$/i,
  /(^|\.)trendsnbest\.com$/i,
  /(^|\.)needhelppayingbills\.com$/i,
  /(^|\.)debt\.org$/i,
  /(^|\.)mjnewellhomes\.com$/i,
])

/**
 * Software vendors and consultancies that publish grant CONTENT to sell a
 * product. `keela.co` is a nonprofit-CRM vendor; its `/grants/type/seniors`
 * page is marketing, not a funder's portal.
 */
export const VENDOR_CONTENT_HOST_PATTERNS = Object.freeze([
  /(^|\.)keela\.co$/i,
  /(^|\.)instrumentl\.com$/i,
  /(^|\.)submittable\.com$/i, // the marketing site; tenant portals live on *.submittable.com paths handled elsewhere
])

export const NON_APPLICATION_HOST_CLASSES = Object.freeze({
  encyclopedia: ENCYCLOPEDIA_HOST_PATTERNS,
  content_farm: CONTENT_FARM_HOST_PATTERNS,
  vendor_content: VENDOR_CONTENT_HOST_PATTERNS,
})

function parse(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (!/^https?:$/i.test(url.protocol)) return null
    return url
  } catch {
    return null
  }
}

/**
 * Classify a URL as a page that cannot be an application surface.
 *
 * Returns `null` when the URL is not recognised as one — which is the common
 * case and the safe one. Returns `{ reason, detail }` when it provably is.
 */
export function classifyNonApplicationSurface(value) {
  const url = parse(value)
  if (!url) return null
  const host = url.hostname.toLowerCase()

  for (const [reason, patterns] of Object.entries(NON_APPLICATION_HOST_CLASSES)) {
    if (patterns.some((rx) => rx.test(host))) {
      return { reason: `non_application_${reason}`, detail: host }
    }
  }

  // A path that declares itself editorial. Checked after hosts so a funder's
  // own domain is judged on its path, not assumed innocent.
  const path = `${url.pathname || ''}`
  if (EDITORIAL_PATH_PATTERNS.some((rx) => rx.test(path))) {
    return { reason: 'non_application_editorial_page', detail: path }
  }

  return null
}

export function isNonApplicationSurface(value) {
  return classifyNonApplicationSurface(value) !== null
}

export default {
  ENCYCLOPEDIA_HOST_PATTERNS,
  EDITORIAL_PATH_PATTERNS,
  CONTENT_FARM_HOST_PATTERNS,
  VENDOR_CONTENT_HOST_PATTERNS,
  NON_APPLICATION_HOST_CLASSES,
  classifyNonApplicationSurface,
  isNonApplicationSurface,
}
