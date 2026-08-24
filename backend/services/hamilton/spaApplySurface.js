/**
 * spaApplySurface.js — detect a scholarship-HUB "Apply" surface that lives
 * behind an in-app button inside a logged-in single-page app (React SPA),
 * where the application is NOT a native HTML form and NOT a navigable apply URL.
 *
 * WHY THIS EXISTS (2026-08-24). Measured on prod: every one of the 13 live
 * profiles carries ~5 bold.org award pages in its pipeline, and Robert holds a
 * VALID bold.org session — yet Hamilton reaches ZERO confirmed external
 * submissions on them. A read-only in-container probe of bold.org with Robert's
 * saved session showed exactly why:
 *   - https://bold.org/scholarships/<slug>/ renders `field_count: 0` (no native
 *     form fields) and its apply control is a `<button>` reading "Apply Now" —
 *     NOT an <a href> to a form. The application opens IN-PLACE in the SPA.
 *   - The engine therefore dead-ends: `detectGate` sees no password/no form,
 *     the submit-hunt sees only "Apply Now"-looking chrome, and the page gets
 *     mislabeled `no_application_form` ("informational page — degrade to the
 *     manual funder-contact packet") or `listing_page` with 0 real applies.
 *   Both are wrong and both are silent: bold.org is neither an info page nor a
 *   multi-award listing at the award URL — it is a real application Hamilton
 *   cannot yet drive because it opens behind an in-SPA button, and blindly
 *   following that button risks an unintended REAL submission on a no-essay
 *   award.
 *
 * This module is the classifier the future bold.org/scholarshipowl HARVEST +
 * in-SPA apply build needs. In this first increment the engine uses it to route
 * an individual-award SPA apply surface to an HONEST, distinct blocker
 * (`spa_apply_surface`) — with side-by-side co-browse as the actionable next
 * step using the saved session — instead of the misleading silent dead-ends.
 *
 * PURE: no IO, never throws. Fully unit-testable from a page snapshot.
 */

/**
 * Known scholarship HUBS whose individual award pages open the application
 * behind an in-app "Apply" button in a logged-in SPA. Keyed by registrable
 * host. `applyRx` is the apply-cue vocabulary each hub prints on its button /
 * award page ("Apply Now", "Apply to scholarship", "1-Click Apply").
 */
export const SPA_APPLY_HUBS = Object.freeze({
  'bold.org': { display: 'Bold.org', applyRx: /\bapply(\s+(now|to\s+(this\s+)?scholarship))?\b/i },
  'scholarshipowl.com': { display: 'ScholarshipOwl', applyRx: /\b(apply(\s+now)?|1[-\s]?click\s+apply)\b/i },
})

/**
 * Path segments that mark a bold.org / scholarshipowl LISTING (a browse tree of
 * many awards) rather than a single applyable award. A listing is harvested by
 * the existing listing-decomposition path, so it must NOT be claimed here.
 */
const LISTING_PATH_RX = /\/scholarships\/(by-type|by-state|by-major|by-year|by-gpa|type|category|search|winners|leaders)(\/|$)/i

/** Registrable-host match: host === domain OR host ends with `.domain`. */
function hostMatches(host, domain) {
  if (!host) return false
  return host === domain || host.endsWith(`.${domain}`)
}

/** The hub entry (with its key) for a URL, or null. */
export function spaApplyHub(url) {
  let host = null
  try { host = new URL(String(url)).hostname.toLowerCase() } catch { return null }
  for (const [key, val] of Object.entries(SPA_APPLY_HUBS)) {
    if (hostMatches(host, key)) return { key, ...val }
  }
  return null
}

/** True iff `url` is on a known SPA-apply hub host. */
export function isSpaApplyHubHost(url) {
  return spaApplyHub(url) !== null
}

/**
 * True iff `url` is an INDIVIDUAL award page on a hub (a single `/scholarships/
 * <slug>/` that is not a browse-tree/listing segment) — the surface whose
 * "Apply" opens the application in-SPA. Bare `/scholarships/` and `by-*`
 * category pages are LISTINGS and return false (left to decomposition).
 */
export function isIndividualAwardPath(url) {
  let path = null
  try { path = new URL(String(url)).pathname } catch { return false }
  if (LISTING_PATH_RX.test(path)) return false
  // A single award slug directly under /scholarships/ (one path segment after it).
  return /\/scholarships\/[a-z0-9][a-z0-9-]*\/?$/i.test(path)
}

/**
 * Detect an individual-award SPA "Apply" surface from a dead-end page snapshot.
 *
 * @param {object} snapshot
 * @param {string} snapshot.url            the page URL
 * @param {number} snapshot.fieldCount     recognized native form fields on the page
 * @param {string[]} [snapshot.buttonTexts] visible button / submit-control texts
 * @param {string} [snapshot.text]         page innerText (fallback apply-cue source)
 * @returns {{
 *   isSpaApply: boolean, hub: string|null, display: string|null,
 *   surface: 'award'|'listing'|null, reason: string
 * }}
 */
export function detectSpaApplySurface(snapshot = {}) {
  const { url = null, fieldCount = 0, buttonTexts = [], text = '' } = snapshot || {}
  const hub = spaApplyHub(url)
  if (!hub) return { isSpaApply: false, hub: null, display: null, surface: null, reason: 'not_spa_hub' }

  // A page that DOES carry a real native form (a handful of fillable fields) is
  // not the in-SPA button surface — leave it to the normal fill path.
  if (Number(fieldCount) > 2) {
    return { isSpaApply: false, hub: hub.key, display: hub.display, surface: null, reason: 'native_form_present' }
  }

  const cueTexts = Array.isArray(buttonTexts) ? buttonTexts : []
  const hasApplyCue = cueTexts.some((t) => hub.applyRx.test(String(t || '')))
    || hub.applyRx.test(String(text || ''))
  if (!hasApplyCue) {
    return { isSpaApply: false, hub: hub.key, display: hub.display, surface: null, reason: 'no_apply_cue' }
  }

  // Only the INDIVIDUAL award page is routed here; listing/browse pages keep the
  // existing decomposition path.
  if (!isIndividualAwardPath(url)) {
    return { isSpaApply: false, hub: hub.key, display: hub.display, surface: 'listing', reason: 'listing_surface_defer_to_decomposition' }
  }

  return {
    isSpaApply: true,
    hub: hub.key,
    display: hub.display,
    surface: 'award',
    reason: 'individual_award_spa_apply',
  }
}

/** A human-readable, actionable blocker detail for a detected SPA apply award. */
export function spaApplyBlockerDetail(display) {
  const name = display || 'this scholarship hub'
  return `This is a ${name} application that opens behind an in-app "Apply" button in a logged-in single-page app — Hamilton cannot yet drive its in-SPA apply flow, and must not blind-click "Apply" (some ${name} awards submit on click). Use side-by-side co-browse with the saved ${name} session to apply.`
}

export default {
  SPA_APPLY_HUBS,
  spaApplyHub,
  isSpaApplyHubHost,
  isIndividualAwardPath,
  detectSpaApplySurface,
  spaApplyBlockerDetail,
}
