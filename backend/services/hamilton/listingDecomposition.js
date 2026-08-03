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
 * Map one enumerated listing item to an opportunity record the canonical
 * inserter accepts. record_origin 'scholarship_crawler' is a TRUSTED origin
 * (recordOrigins.ALLOWED_RECORD_ORIGINS) — the row still passes the full
 * quality/policy/validation/reality gate stack before it is stored.
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
    sponsor: item?.sponsor || null,
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
  }

  const enumResult = await enumerate(
    { url: listingUrl, title: listing?.title || null, text: listing?.text || '', links: listing?.links || [] },
    { maxItems, log },
  )
  out.rejected.push(...(enumResult?.rejected || []))
  out.notFound.push(...(enumResult?.notFound || []))
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

export default { decomposeListing, buildOpportunityRecord, isNgWebCatalogHost, LISTING_MAX_ITEMS, LISTING_MAX_APPLIES }
