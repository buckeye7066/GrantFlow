/**
 * pipelineCategory.js — the ONE definition of the two kinds of pipeline row.
 *
 * OWNER DIRECTIVE (2026-08-23): Robert autonomously adds national FUNDERS that
 * meet a profile's criteria to that profile's pipeline. But a 990 foundation is
 * NOT a scholarship portal: most fund by relationship / invitation and do NOT
 * accept a cold auto-submitted application. So a funder Robert adds is a
 * "potential source, UNDER ACTIVE INVESTIGATION" — a research/relationship
 * prospect — never an apply-ready opportunity Hamilton may cold-submit.
 *
 * Two categories live on `grants.pipeline_category`:
 *
 *   FUNDER_LEAD  — a qualified funder prospect. It reached the pipeline on
 *                  Robert's four-gate qualification (real / relatable /
 *                  covers-a-declared-need / qualifies-on-type+geo+eligibility),
 *                  NOT on an apply-ready score. It has no confirmed application
 *                  path yet. Hamilton's auto-submit MUST NOT select it.
 *   APPLY_READY  — a normal opportunity with a real application path (portal /
 *                  application URL). This is what Hamilton auto-submits on a
 *                  fully-autonomous profile. Every legacy row (NULL category)
 *                  is apply-ready by construction — the funder-lead category is
 *                  the ONLY thing that is ever withheld from the apply path.
 *
 * A FUNDER_LEAD is PROMOTED to APPLY_READY only when investigation establishes a
 * real, usable application path for that funder (Robert's "closer inspection").
 * Promotion is the single gate that lets a funder reach Hamilton's auto-submit.
 */

import { isSearchEngineUrl } from './urlRules.js'

export const PIPELINE_CATEGORY = Object.freeze({
  APPLY_READY: 'apply_ready',
  FUNDER_LEAD: 'funder_lead',
})

/** Investigation lifecycle stored in `grants.funder_lead_state`. */
export const FUNDER_LEAD_STATE = Object.freeze({
  // A fresh lead, not yet investigated.
  CANDIDATE: 'candidate',
  // Investigated at least once; no usable apply path found yet — stays a lead.
  INVESTIGATED: 'investigated',
  // Investigation determined it is NOT applicable (invitation-only / closed /
  // no reachable application path after bounded attempts). Kept, labeled.
  NOT_APPLICABLE: 'not_applicable',
  // Investigation found a usable apply path; the row was promoted to apply-ready.
  PROMOTED: 'promoted',
})

/** True iff this row is a funder LEAD (not on the apply-ready side). */
export function isFunderLead(row) {
  return String(row?.pipeline_category ?? '').trim().toLowerCase() === PIPELINE_CATEGORY.FUNDER_LEAD
}

/**
 * True iff this row is on the APPLY-READY side — the ONLY side Hamilton's
 * auto-submit may select. A NULL / unset / unknown category is apply-ready by
 * construction (every pre-existing pipeline row); ONLY an explicit funder_lead
 * is withheld.
 */
export function isApplyReady(row) {
  return !isFunderLead(row)
}

/**
 * SQL predicate for the APPLY-READY side (NOT a funder lead). Dialect-agnostic;
 * `LOWER()` because prod may store either case. Use this wherever a query must
 * exclude funder leads (Hamilton's ready-source selection is the load-bearing
 * caller).
 */
export function notFunderLeadSql(col = 'pipeline_category') {
  return `(${col} IS NULL OR LOWER(${col}) <> '${PIPELINE_CATEGORY.FUNDER_LEAD}')`
}

/** SQL predicate that selects ONLY funder leads. */
export function funderLeadSql(col = 'pipeline_category') {
  return `(LOWER(${col}) = '${PIPELINE_CATEGORY.FUNDER_LEAD}')`
}

/**
 * A grant row has a USABLE http(s) URL when it carries any non-search-engine
 * application/portal/url. Coarse filter only — a ProPublica research page and a
 * real /apply form both pass. Promotion to apply-ready MUST use
 * `hasPromotableApplyPath` instead.
 */
export function hasUsableApplyPath(row) {
  const candidates = [row?.application_url, row?.portal_url, row?.url, row?.apply_url]
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue
    const u = raw.trim()
    if (!/^https?:\/\//i.test(u)) continue
    try {
      if (isSearchEngineUrl(u)) continue
    } catch { /* isSearchEngineUrl never throws in practice; be defensive */ }
    return true
  }
  return false
}

/** Path shapes that look like a self-serve application surface (not a homepage). */
const APPLICATION_PATH_RX = /\/(apply|application|applications|grants?|funding|how-to-apply|eligibility|guidelines|rfp|nofo|proposal)s?(\/|$|\?|#)/i

/**
 * True when `url` looks like an application/grants PATH, not a bare homepage
 * or research directory (e.g. ProPublica org pages).
 */
export function looksLikeApplicationPath(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
  try {
    const parsed = new URL(url)
    return APPLICATION_PATH_RX.test(parsed.pathname + (parsed.search || ''))
  } catch {
    return false
  }
}

/**
 * Promotion bar for funder leads → apply-ready.
 *
 * ONLY `application_url` / `apply_url` / `portal_url` count, and the path must
 * look like an application surface. Deliberately ignores `url` / `source_url`:
 * admit used to copy the ProPublica 990 research page into `grants.url`, and
 * `hasUsableApplyPath` then treated that research URL as "already applicable"
 * and auto-promoted every lead on the next investigation pass — the exact
 * cold-submit failure this category exists to prevent.
 */
export function hasPromotableApplyPath(row) {
  const candidates = [row?.application_url, row?.apply_url, row?.portal_url]
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue
    const u = raw.trim()
    if (!/^https?:\/\//i.test(u)) continue
    try {
      if (isSearchEngineUrl(u)) continue
    } catch { /* defensive */ }
    if (looksLikeApplicationPath(u)) return true
  }
  return false
}

export default {
  PIPELINE_CATEGORY,
  FUNDER_LEAD_STATE,
  isFunderLead,
  isApplyReady,
  notFunderLeadSql,
  funderLeadSql,
  hasUsableApplyPath,
  looksLikeApplicationPath,
  hasPromotableApplyPath,
}
