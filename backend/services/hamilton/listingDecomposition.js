/**
 * listingDecomposition.js — Layer 2 of listing-decomposition-apply.
 *
 * OWNER DIRECTIVE (2026-08-03): a discovery that is a PAGE of several
 * scholarships must not be turned down just because the awards are listed
 * together. Hamilton enumerates the awards on the page, admits each through the
 * CANONICAL gates, lets the CANONICAL match engine decide relevance, and — for
 * the ones the engine ACCEPTs — follows that award's own apply link into the
 * EXISTING fill/submit flow. Junk is refused at three points: the enumeration
 * fabrication guard (llmPageExtract), the inserter reality gate
 * (opportunityInserter.upsertFundingOpportunity), and the match engine itself.
 *
 * AUTHORITY BOUNDARIES (do not blur):
 *   - The inserter reality gate + canonicalOpportunityKey dedup is the ONLY
 *     admission gate. We never persist an enumerated item directly.
 *   - services/matchEngine.computeMatchDecision is the SOLE relevance authority.
 *     There is no standalone LLM "is this a good match" verdict here.
 *   - The apply step reuses the EXISTING engine + its authorization/evidence
 *     gates verbatim (injected `applyItem`). This layer NEVER widens
 *     auto-submit — it forwards whatever consent the parent run already had.
 *
 * NGWeb EXCEPTION (platform rule, CLAUDE.md 2026-08-03): on
 * `<school>.scholarships.ngwebsolutions.com` a student CANNOT apply to
 * individual scholarships — the General Application covers them. Those catalogs
 * decompose for VISIBILITY (each award admitted through the inserter so it is
 * seen/matchable) but NEVER earn a per-item application attempt.
 *
 * PURE of Playwright/DB browser lifecycle: enumeration, admission, and matching
 * are pure-ish module calls; the only Playwright-backed step (following an
 * award's apply link) is the injected `applyItem`, supplied by the orchestrator
 * where the browser + authorizations already live. Fully unit-testable with
 * fakes for every dependency.
 */

import { extractListingAwardItems } from './portalSync/llmPageExtract.js'
import { upsertFundingOpportunity } from '../opportunityInserter.js'
import { computeMatchDecision } from '../matchEngine.js'

/** Max award items considered from one listing per run (enumerate + admit + match). */
export const LISTING_MAX_ITEMS = Number(process.env.HAMILTON_LISTING_MAX_ITEMS) || 25
/** Max per-item application ATTEMPTS from one listing per run (fan-out bound). */
export const LISTING_MAX_APPLIES = Number(process.env.HAMILTON_LISTING_MAX_APPLIES) || 5

/**
 * NGWeb "Scholarship Manager" catalog host — a student cannot apply to
 * individual scholarships here; the General Application covers them. Matches
 * every `<school>.scholarships.ngwebsolutions.com` tenant.
 */
export function isNgWebCatalogHost(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return /(^|\.)scholarships\.ngwebsolutions\.com$/.test(host)
  } catch {
    return /scholarships\.ngwebsolutions\.com/i.test(String(url || ''))
  }
}

/**
 * Common scholarship-hub hosts → the display name of the org that runs them, so
 * a decomposed award whose OWN text does not name a sponsor still carries a REAL
 * funder identity — the hub/listing it was demonstrably found on — instead of a
 * NULL sponsor. Keyed by the registrable domain label.
 */
const HUB_SPONSOR_DISPLAY = Object.freeze({
  scholarshipowl: 'ScholarshipOwl',
  bold: 'Bold.org',
  fastweb: 'Fastweb',
  scholarships: 'Scholarships.com',
  collegescholarships: 'CollegeScholarships.org',
  niche: 'Niche',
  unigo: 'Unigo',
  cappex: 'Cappex',
  goingmerry: 'Going Merry',
  petersons: "Peterson's",
  chegg: 'Chegg',
  aifsabroad: 'AIFS Abroad',
  ciee: 'CIEE',
  governmentgrants: 'GovernmentGrants.us',
})

// Labels too generic to stand alone as a funder identity — for these the FULL
// registrable domain reads as a real host (grants.gov → "Grants.gov").
const GENERIC_HOST_LABELS = new Set(['grants', 'scholarships', 'funding', 'apply', 'portal', 'awards', 'aid', 'foundation', 'gov', 'org', 'fund'])

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Derive a REAL sponsor of last resort from the listing/hub URL an award was
 * found on. This is the "listing host org" fallback of the owner directive
 * (2026-08-03): a decomposed award whose own text names no sponsor carries the
 * hub it was listed on rather than a NULL funder. It NEVER fabricates — the value
 * is exactly the registrable host the award was demonstrably listed on. Returns
 * null only for an empty/unparseable URL (the caller then leaves sponsor null and
 * the item is still admitted on its description).
 */
export function listingHostSponsor(url) {
  if (!url) return null
  let hostname = null
  try { hostname = new URL(String(url)).hostname } catch { return null }
  const parts = String(hostname).toLowerCase().replace(/^(www\d*|m|portal|apply|w\d+)\./, '').split('.').filter(Boolean)
  if (parts.length === 0) return null
  const idx = parts.length >= 2 ? parts.length - 2 : 0
  const label = parts[idx]
  if (!label) return null
  if (HUB_SPONSOR_DISPLAY[label]) return HUB_SPONSOR_DISPLAY[label]
  // A bare generic word is not a funder identity — use label.tld instead.
  if (GENERIC_HOST_LABELS.has(label) && parts[idx + 1]) return `${cap(label)}.${parts[idx + 1]}`
  return cap(label)
}

/**
 * Map one enumerated listing item to an opportunity record the canonical
 * inserter accepts. record_origin 'scholarship_crawler' is a TRUSTED origin
 * (recordOrigins.ALLOWED_RECORD_ORIGINS) — the row still passes the full
 * quality/policy/validation/reality gate stack before it is stored.
 *
 * SPONSOR PRIORITY (owner directive 2026-08-03 — never a NULL funder, never
 * fabricated): (a) the sponsor the award's OWN text named (item.sponsor, captured
 * by the fabrication-guarded enumerator), else (b) the hub/listing host org the
 * award was found on (listingHostSponsor). A real funder identity lets the row
 * pass the inserter's missing_sponsor validation, dedupe distinctly, and carry a
 * funder through Robert's RELATABLE audit + the pipeline funder backfill.
 *
 * @param {object} item      enumerated award (from extractListingAwardItems)
 * @param {object} ctx
 * @param {string} ctx.listingUrl  the page the item was listed on
 */
export function buildOpportunityRecord(item, { listingUrl } = {}) {
  const applyUrl = item?.applyUrl || null
  const url = applyUrl || listingUrl || null
  const amount = Number.isFinite(item?.amount) ? item.amount : null
  return {
    title: String(item?.title || '').slice(0, 300),
    sponsor: item?.sponsor || listingHostSponsor(listingUrl),
    source: 'scholarship_crawler',
    record_origin: 'scholarship_crawler',
    source_url: url,
    application_url: applyUrl,
    final_url: url,
    description: item?.evidence || null,
    amount_min: amount,
    amount_max: amount,
    amount_text: amount ? String(amount) : null,
    deadline: item?.deadline || null,
    // Provenance of the decomposition itself (audit): which listing minted this.
    raw_meta: { decomposed_from: listingUrl || null, listing_item: true },
  }
}

/**
 * Decompose a LISTING page into per-award candidates, admit + match each, and
 * (for ACCEPTs with a real apply link) hand off to the injected apply step.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.profile              raw profile bundle (for matching)
 * @param {object} [args.profileSections]    optional sections for signal build
 * @param {object} args.listing              { url, title, text, links }
 * @param {number} [args.maxItems]
 * @param {number} [args.maxApplies]
 * @param {object} [deps]
 * @param {Function} [deps.enumerate]  (listing,opts)=>{items,rejected,notFound}
 * @param {Function} [deps.insert]     (db,record,opts)=>{id,inserted,skipped,reason}
 * @param {Function} [deps.match]      (profile,opportunity,opts)=>decision
 * @param {Function} [deps.applyItem]  (item,{opportunityId})=>engineResult — the
 *                                     ONLY Playwright-backed dep; when absent,
 *                                     ACCEPTs are recorded but not applied.
 * @param {Function} [deps.log]
 * @returns {Promise<{
 *   surface: 'LISTING', catalog_only: boolean, host: string|null,
 *   enumerated: number, admitted: number, applies_attempted: number,
 *   items: Array<object>, notFound: string[], rejected: Array<object>,
 * }>}
 */
export async function decomposeListing(args = {}, deps = {}) {
  const {
    db, profile, profileSections = null, listing = {},
    maxItems = LISTING_MAX_ITEMS, maxApplies = LISTING_MAX_APPLIES,
  } = args
  const log = deps.log || (() => {})
  const enumerate = deps.enumerate || ((l, o) => extractListingAwardItems(l, o))
  const insert = deps.insert || ((d, rec, o) => upsertFundingOpportunity(d, rec, o))
  const match = deps.match || ((p, opp, o) => computeMatchDecision(p, opp, o))
  const applyItem = deps.applyItem || null

  const listingUrl = listing?.url || null
  const catalogOnly = isNgWebCatalogHost(listingUrl)
  let host = null
  try { host = listingUrl ? new URL(listingUrl).hostname : null } catch { host = null }

  const out = {
    surface: 'LISTING', catalog_only: catalogOnly, host,
    enumerated: 0, admitted: 0, applies_attempted: 0,
    items: [], notFound: [], rejected: [],
    // Set when the enumerator could not READ the page at all (LLM provider
    // momentarily unavailable — exhausted credits, rate limit, 5xx — or no
    // provider configured / disabled). A zero enumeration under this flag is
    // NOT evidence the page is empty, and the orchestrator must leave the task
    // RETRYABLE rather than parking it as a manual "needs you" card.
    enumeration_unavailable: false, enumeration_transient: false,
  }

  const enumResult = await enumerate(
    { url: listingUrl, title: listing?.title || null, text: listing?.text || '', links: listing?.links || [] },
    { maxItems, log },
  )
  out.rejected.push(...(enumResult?.rejected || []))
  out.notFound.push(...(enumResult?.notFound || []))
  const enumRaw = enumResult?.raw || {}
  // `transient` = provider outage/credits/rate limit; `attempted === false` =
  // no provider configured or LLM extraction disabled. Both mean "we did not
  // actually read the page", so a 0 here is unexplained, never "empty".
  out.enumeration_transient = Boolean(enumRaw.transient)
  out.enumeration_unavailable = Boolean(enumRaw.transient) || enumRaw.attempted === false
  const enumerated = Array.isArray(enumResult?.items) ? enumResult.items.slice(0, maxItems) : []
  out.enumerated = enumerated.length

  for (const item of enumerated) {
    const record = { perItem: { title: item.title, apply_url: item.applyUrl || null } }
    // 1. Admit through the canonical inserter (reality gate + dedup).
    let ins
    try {
      ins = await insert(db, buildOpportunityRecord(item, { listingUrl }), { allowDirectories: true })
    } catch (err) {
      record.perItem.outcome = 'insert_error'
      record.perItem.detail = err?.message || String(err)
      out.items.push(record.perItem)
      continue
    }
    if (!ins || ins.skipped || (!ins.inserted && !ins.updated && !ins.id)) {
      record.perItem.outcome = 'not_admitted'
      record.perItem.detail = ins?.reason || 'inserter rejected or deduped without id'
      out.items.push(record.perItem)
      continue
    }
    out.admitted += 1
    record.perItem.opportunity_id = ins.id
    record.perItem.admitted = true

    // 2. Canonical relevance decision (SOLE authority).
    let decision
    try {
      decision = match(profile, buildOpportunityRecord(item, { listingUrl }), { profileSections })
    } catch (err) {
      record.perItem.outcome = 'match_error'
      record.perItem.detail = err?.message || String(err)
      out.items.push(record.perItem)
      continue
    }
    record.perItem.decision = decision?.decision || 'REVIEW'
    record.perItem.match_score = decision?.score ?? null

    // 3. Apply only ACCEPTs that carry a real apply link — and never on NGWeb.
    const accepted = record.perItem.decision === 'ACCEPT'
    if (!accepted) {
      record.perItem.outcome = 'not_accepted'
      out.items.push(record.perItem)
      continue
    }
    if (catalogOnly) {
      record.perItem.outcome = 'catalog_only'
      record.perItem.detail = 'NGWeb catalog — covered by the General Application; no per-item apply'
      out.items.push(record.perItem)
      continue
    }
    if (!item.applyUrl) {
      record.perItem.outcome = 'accepted_no_apply_link'
      out.items.push(record.perItem)
      continue
    }
    if (!applyItem) {
      record.perItem.outcome = 'accepted_apply_deferred'
      record.perItem.detail = 'no apply runner wired'
      out.items.push(record.perItem)
      continue
    }
    if (out.applies_attempted >= maxApplies) {
      record.perItem.outcome = 'apply_fanout_capped'
      record.perItem.detail = `reached HAMILTON_LISTING_MAX_APPLIES=${maxApplies}`
      out.items.push(record.perItem)
      continue
    }
    // 4. Follow the award's own apply link into the EXISTING fill/submit flow.
    out.applies_attempted += 1
    try {
      const engineResult = await applyItem(item, { opportunityId: ins.id })
      record.perItem.outcome = 'applied'
      record.perItem.apply_status = engineResult?.status || null
      record.perItem.apply_blocker = engineResult?.blocker_kind || null
    } catch (err) {
      record.perItem.outcome = 'apply_error'
      record.perItem.detail = err?.message || String(err)
    }
    out.items.push(record.perItem)
  }

  log(`decomposeListing: ${out.enumerated} enumerated, ${out.admitted} admitted, ${out.applies_attempted} apply attempt(s)${catalogOnly ? ' (NGWeb catalog-only)' : ''} from ${host || listingUrl}`)
  return out
}

export default { decomposeListing, buildOpportunityRecord, isNgWebCatalogHost, listingHostSponsor, LISTING_MAX_ITEMS, LISTING_MAX_APPLIES }
