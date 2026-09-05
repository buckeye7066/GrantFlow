/**
 * itemNeeds.js — the profile's ITEM LIST, and on-demand searches for it.
 *
 * ACCESS: every route is `ensureProfileAccess` (owner-or-admin, the same gate
 * every other profile mutation uses). The profile id is a PATH parameter that
 * is checked against the caller's accessible set — never a guessable id, never
 * an unauthenticated lookup.
 *
 *   GET  /api/item-needs/:profileId                    — derived + declared item list
 *   POST /api/item-needs/:profileId/search             — crawl one item or a list
 *   POST /api/item-needs/:profileId/green-home         — strict no-cost green upgrades
 *   GET  /api/item-needs/:profileId/needs-plan         — org-type needs taxonomy
 *   POST /api/item-needs/:profileId/needs-plan/search  — search the plan's needs
 *
 * Search routes are additionally held to the SAME tier capability as the
 * existing item-funding lane (`TIER_CAPABILITIES.ITEM_FUNDING`), so the paths
 * cannot diverge into different entitlement stories.
 *
 * RATE LIMITED, and search routes more strictly than the read. One request can
 * fan out to several live web queries against a shared search backend. An
 * unthrottled loop here would rebuild the anti-bot wall that previously made
 * item search appear to complete with false zero results.
 */

import express from 'express'
import { ensureAuth } from '../middleware/auth.js'
import { standardRateLimiter, mutationRateLimiter } from '../middleware/rateLimiting.js'
import { ensureProfileAccess } from '../utils/accessControl.js'
import { requireTierCapability, TIER_CAPABILITIES } from '../utils/tierGating.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { deriveProfileItemNeeds, parseDeclaredItemList } from '../config/profileItemNeeds.js'
import { resolvePlanClasses, resolveCoverageConditionClasses, annotateItemsWithCoverage } from '../config/planCoverage.js'
import { searchItemNeeds, ITEM_SEARCH_MAX_ITEMS } from '../services/itemNeedSearch.js'
import { readNeedsPlanAutoSearch } from '../services/needs/needsPlanAutoSearch.js'
import { searchGreenHomeNoCostPrograms } from '../services/greenHomeNoCostSearch.js'
import { deriveOrgNeeds } from '../services/needs/orgNeedsTaxonomy.js'
import { probeSearchProviderHealth } from '../services/searchProviderHealth.js'
import { formatError } from '../middleware/errorHandler.js'
import { createLogger } from '../utils/logger.js'

const routeLogger = createLogger('route:itemNeeds')
const router = express.Router()

/**
 * ONE renderer for the web-search provider verdict, so every search route in
 * this file says the same thing about the same outage. A zero-result run must
 * always carry the reason it might be zero — "the backend is dark" and "we
 * searched and there is nothing" are different facts and the owner's whole bar
 * (beat a free Google search) turns on telling them apart.
 */
function buildSearchBackendsBlock(backends) {
  return {
    verdict: backends?.verdict ?? 'unknown',
    detail: backends?.detail ?? null,
    probed_at: backends?.probed_at ?? null,
    message:
      backends?.verdict === 'unconfigured'
        ? 'No web-search backend is configured (SEARXNG_URL / BRAVE_SEARCH_API_KEY are unset). Web results are unavailable — catalog results only. A zero here does not mean nothing exists.'
        : backends?.verdict === 'down'
          ? 'The web-search backend is not responding. Web results are unavailable — catalog results only. A zero here does not mean nothing exists.'
          : backends?.verdict === 'degraded'
            ? 'The web-search backend is degraded; web results may be incomplete.'
            : null,
  }
}

/**
 * Load the profile + sections once; all routes read the same canonical view.
 *
 * A NON-EXISTENT ID IS A 404, NEVER A 500. `loadProfileContext` assumes the
 * profile exists and throws on a missing row, so probing this route with a
 * placeholder id used to surface the throw as a 500 — caught by CI's
 * `gate:endpoint-sweep`, which probes every GET handler and treats any 5xx as a
 * handler that threw. The existence check runs FIRST and a genuine load failure
 * still propagates: swallowing a real DB error into a 404 would hide exactly
 * the class of defect this gate exists to catch.
 */
async function loadContext(db, profileId) {
  // `.get()` is SYNCHRONOUS on the better-sqlite3 shim and a promise on the
  // Postgres one, so `await` handles both and `.catch()` on the result handles
  // neither — that mistake turned this guard itself into the 500 it was added
  // to prevent (`Cannot read properties of undefined (reading 'catch')`).
  const row = await db.prepare('SELECT id FROM profiles WHERE id = ?').get(String(profileId))
  if (!row) return { profile: null, sections: {} }
  const ctx = await loadProfileContext(db, profileId)
  return ctx ?? { profile: null, sections: {} }
}

/**
 * GET /api/item-needs/:profileId
 *
 * The item list, with PROVENANCE on every entry. `unmapped` names declared
 * values that resolve to no item and the one-line vocabulary fix, so the gap
 * converges instead of recurring; `silent_fields` names the registry fields
 * that said nothing, so "your list is short" is explainable rather than
 * mysterious.
 */
router.get('/:profileId', ensureAuth, standardRateLimiter, async (req, res) => {
  const profileId = String(req.params.profileId ?? '').trim()
  if (!(await ensureProfileAccess(req, res, profileId))) return
  try {
    const ctx = await loadContext(req.db, profileId)
    if (!ctx.profile) return res.status(404).json({ error: 'Profile not found' })
    const derived = deriveProfileItemNeeds(ctx.profile, ctx.sections ?? {})
    // INSURANCE ELIGIBILITY HINTS (owner rule 2026-08-15): when the profile
    // declares insurance/enrollment facts, items whose category the plan
    // class (× declared condition class, when the rule needs medical
    // necessity) typically covers carry an `eligibility_hint` — "what help
    // are you already eligible for" ahead of "what needs fundraising". A
    // labeling layer only: membership and order are unchanged, a profile
    // with no insurance facts sees zero change, and the hint language never
    // asserts plan-document coverage.
    const planClasses = resolvePlanClasses(ctx.sections ?? {})
    const conditionClasses = resolveCoverageConditionClasses(ctx.sections ?? {})
    const needs = annotateItemsWithCoverage(derived.needs, { planClasses, conditionClasses })
    return res.json({
      success: true,
      profile_id: profileId,
      display_name: ctx.profile.display_name ?? null,
      primary_type: ctx.profile.primary_type ?? null,
      count: needs.length,
      truncated: derived.truncated,
      needs,
      plan_classes: planClasses,
      condition_classes: conditionClasses,
      unmapped: derived.unmapped,
      consulted_fields: derived.consultedFields,
      silent_fields: derived.silentFields,
      free_text_field: 'financial_information.item_needs',
      generated_at: new Date().toISOString(),
    })
  } catch (error) {
    routeLogger.error('[item-needs] list error', error)
    return res.status(500).json(formatError(error))
  }
})

/**
 * GET /api/item-needs/:profileId/needs-plan
 *
 * THE PREDETERMINED NEEDS LIST for an entity applicant (owner directive
 * 2026-08-12). A profile that says it is a research lab gets the research-lab
 * need list without typing anything; a volunteer fire department gets the
 * public-safety list; and so on down `orgNeedsTaxonomy.NEED_BLUEPRINTS`.
 *
 * Read-only and cheap — it runs NO searches, so it sits on the standard limiter
 * with the other read.
 *
 * The response deliberately returns FOUR buckets rather than one list, because
 * "this need is gone" has three different honest meanings that must not blur:
 *   open           — ask about it
 *   suppressed     — you already have it, and here is the field + value proving it
 *   not_applicable — this need does not apply to your kind of org at all
 *   user_added     — you typed this yourself; it is never suppressed by us
 * `candidate_count` is returned so a caller can verify nothing was silently
 * dropped: open + suppressed + not_applicable + truncated must equal it.
 */
router.get('/:profileId/needs-plan', ensureAuth, standardRateLimiter, async (req, res) => {
  const profileId = String(req.params.profileId ?? '').trim()
  if (!(await ensureProfileAccess(req, res, profileId))) return
  try {
    const ctx = await loadContext(req.db, profileId)
    if (!ctx.profile) return res.status(404).json({ error: 'Profile not found' })

    const plan = deriveOrgNeeds({ profile: ctx.profile, sections: ctx.sections ?? {} })
    // Robert's last AUTOMATIC search of this plan (runs after every live crawl
    // of the profile — needsPlanAutoSearch.js), so the list arrives with
    // funding sources already found rather than as an empty checklist.
    const lastAutoSearch = await readNeedsPlanAutoSearch(req.db, profileId)
    return res.json({
      success: true,
      profile_id: profileId,
      display_name: ctx.profile.display_name ?? null,
      primary_type: ctx.profile.primary_type ?? null,
      ...plan,
      last_auto_search: lastAutoSearch,
      // Named so the UI can point the owner at the exact boxes that control
      // suppression instead of leaving a vanished need unexplained.
      evidence_fields: [
        'organization_details.licenses_held',
        'organization_details.insurance_held',
        'organization_details.equipment_owned',
        'organization_details.regulatory_approvals_held',
        'organization_details.facility_status',
      ],
      free_text_field: 'financial_information.item_needs',
      generated_at: new Date().toISOString(),
    })
  } catch (error) {
    routeLogger.error('[item-needs] needs-plan error', error)
    return res.status(500).json(formatError(error))
  }
})

/**
 * POST /api/item-needs/:profileId/needs-plan/search
 *
 * Run a REAL search for the plan's needs. Body:
 *   `{ codes?: string[], include_user_needs?: boolean, offset?: number, variant?: 'funding'|'gift' }`
 *
 * Each need is searched through the SAME `searchItemNeeds` two-lane engine the
 * item scanner already uses (catalog SQL + live web leads) — there is no second
 * search path to drift, `matchEngine.computeMatchDecision` stays the sole
 * relevance authority, and nothing here manufactures a score or a percentage.
 *
 * BACKEND HONESTY. `searchWeb` reports provider status on a NON-ENUMERABLE
 * `searchMeta` that `collectWebLeads` drops when it maps the array, so by the
 * time results reach here a 402'd Brave over a dead SearXNG is indistinguishable
 * from "searched, found nothing". Rather than let a dark backend read as a
 * genuine zero, this route probes the providers directly
 * (`probeSearchProviderHealth`, 10-min cached) and returns the verdict as
 * `search_backends`. A `down`/`unconfigured` verdict is stated plainly in
 * `search_backends.message` so the caller can say so instead of showing an
 * empty list as if it were an answer.
 *
 * `searchItemNeeds` caps a run at ITEM_SEARCH_MAX_ITEMS; the response reports
 * `truncated` and `next_offset` so the rest of a long plan is reachable rather
 * than quietly discarded.
 */
router.post('/:profileId/needs-plan/search', ensureAuth, mutationRateLimiter, async (req, res) => {
  const profileId = String(req.params.profileId ?? '').trim()
  if (!(await ensureProfileAccess(req, res, profileId))) return
  if (!(await requireTierCapability(req, res, profileId, TIER_CAPABILITIES.ITEM_FUNDING))) return

  try {
    const ctx = await loadContext(req.db, profileId)
    if (!ctx.profile) return res.status(404).json({ error: 'Profile not found' })

    const body = req.body ?? {}
    const plan = deriveOrgNeeds({ profile: ctx.profile, sections: ctx.sections ?? {} })
    const includeUser = body.include_user_needs !== false

    // The searchable set, in plan order: open blueprint needs first (they are
    // ordered blockers-first), then the owner's own words.
    //
    // DEDUPED BY SUBJECT ON PURPOSE. `searchItemNeeds` dedupes its `items` by
    // normalized text before searching, so two needs that resolve to the same
    // search phrase would come back as ONE result — silently shortening the
    // response relative to what we asked for and (before this) shifting the
    // need identities we re-attach below. Collapsing here instead keeps
    // `plan_size`, `remaining`, and `next_offset` truthful.
    const bySubject = new Map()
    for (const entry of [
      ...plan.open.map((need) => ({ code: need.code, label: need.label, subject: need.search_subject, source: need.source })),
      ...(includeUser ? plan.user_added.map((need) => ({ code: null, label: need.label, subject: need.search_subject, source: 'user_added' })) : []),
    ]) {
      const key = String(entry.subject ?? '').trim().toLowerCase()
      if (!key || bySubject.has(key)) continue
      bySubject.set(key, entry)
    }
    let selectable = [...bySubject.values()]

    // An explicit `codes` filter narrows to those needs. A code the plan does
    // not contain is REPORTED, never silently ignored.
    let unknownCodes = []
    if (Array.isArray(body.codes) && body.codes.length > 0) {
      const wanted = body.codes.map((c) => String(c ?? '').trim()).filter(Boolean)
      const wantedSet = new Set(wanted)
      const present = new Set(selectable.map((s) => s.code).filter(Boolean))
      unknownCodes = wanted.filter((c) => !present.has(c))
      selectable = selectable.filter((s) => s.code && wantedSet.has(s.code))
    }

    const offset = Number.isFinite(Number(body.offset)) ? Math.max(0, Math.floor(Number(body.offset))) : 0
    const window = selectable.slice(offset, offset + ITEM_SEARCH_MAX_ITEMS)
    const remaining = Math.max(0, selectable.length - (offset + window.length))

    // Probe the providers regardless of outcome, so a zero-result run always
    // carries the reason it might be zero.
    const backends = await probeSearchProviderHealth().catch((error) => ({
      verdict: 'unknown',
      detail: `probe failed: ${error?.message || error}`,
    }))
    const backendsBlock = buildSearchBackendsBlock(backends)

    if (window.length === 0) {
      // HONEST EMPTY. Nothing was searched, and the reason is named — never a
      // fabricated default need and never a bare zero.
      return res.json({
        success: true,
        profile_id: profileId,
        subject: 'needs_plan',
        taxonomy_version: plan.taxonomy_version,
        blueprint: plan.blueprint,
        requested_count: 0,
        searched_count: 0,
        searched_needs: [],
        remaining,
        next_offset: null,
        unknown_codes: unknownCodes,
        search_backends: backendsBlock,
        items: [],
        note:
          selectable.length === 0
            ? (plan.blueprint.source === 'not_an_organization'
              ? 'This profile is not an organization, so it has no org-type needs plan. Use POST /api/item-needs/:id/search for person-shaped item needs.'
              : 'Every need in this plan is either already held or not applicable. Nothing to search.')
            : `Offset ${offset} is past the end of the ${selectable.length}-need plan.`,
      })
    }

    // CARRY THE NEED'S IDENTITY, NOT JUST ITS WORDS. Handing the search only
    // `subject` threw away the one thing this route already knew — WHICH
    // curated `ORG_NEED_DEFINITIONS` entry the subject came from — and forced
    // the search to re-derive the need from the string with the household
    // taxonomy, which carries no research, laboratory or regulatory vocabulary.
    // See `orgNeedsTaxonomy.needSearchVocabulary`. A `user_added` need has no
    // code and correctly keeps the inferred expansion: the owner's own words
    // are not a taxonomy entry.
    const report = await searchItemNeeds(req.db, {
      profileId,
      items: window.map((w) => ({ item: w.subject, code: w.code })),
      blueprintKey: plan.blueprint?.key ?? null,
      profileContext: ctx,
      variant: body.variant === 'gift' ? 'gift' : 'funding',
    })

    // Re-attach the need identity to each searched item BY SUBJECT, not by
    // index. `searchItemNeed` echoes back the exact string it was handed, so
    // the join is exact — and unlike an index join it cannot mislabel a result
    // if the service ever reorders or drops an entry. `index` is only a
    // last-resort fallback so an unmatched row is still labelled rather than
    // silently anonymous.
    const windowBySubject = new Map(window.map((w) => [String(w.subject).trim().toLowerCase(), w]))
    const items = (report.items ?? []).map((item, index) => {
      const need = windowBySubject.get(String(item?.item ?? '').trim().toLowerCase()) ?? window[index] ?? null
      return {
        need_code: need?.code ?? null,
        need_label: need?.label ?? null,
        need_source: need?.source ?? null,
        ...item,
      }
    })

    return res.json({
      success: true,
      subject: 'needs_plan',
      taxonomy_version: plan.taxonomy_version,
      blueprint: plan.blueprint,
      max_items_per_run: ITEM_SEARCH_MAX_ITEMS,
      plan_size: selectable.length,
      offset,
      remaining,
      next_offset: remaining > 0 ? offset + window.length : null,
      unknown_codes: unknownCodes,
      suppressed_count: plan.suppressed.length,
      not_applicable_count: plan.not_applicable.length,
      search_backends: backendsBlock,
      ...report,
      items,
    })
  } catch (error) {
    routeLogger.error('[item-needs] needs-plan search error', error)
    return res.status(500).json(formatError(error))
  }
})

/**
 * POST /api/item-needs/:profileId/green-home
 *
 * A deliberately strict homeowner/household lane. The service searches
 * weatherization, insulation, heat pumps, geothermal, solar/storage, and small
 * residential wind, then withholds every result that requires a loan,
 * financing, lease/PPA, tax credit, rebate, reimbursement, purchase, match,
 * cost share, or applicant contribution. Unknown cost terms are review-only and
 * are not returned in `programs`.
 */
router.post('/:profileId/green-home', ensureAuth, mutationRateLimiter, async (req, res) => {
  const profileId = String(req.params.profileId ?? '').trim()
  if (!(await ensureProfileAccess(req, res, profileId))) return
  if (!(await requireTierCapability(req, res, profileId, TIER_CAPABILITIES.ITEM_FUNDING))) return

  try {
    const ctx = await loadContext(req.db, profileId)
    if (!ctx.profile) return res.status(404).json({ error: 'Profile not found' })

    const report = await searchGreenHomeNoCostPrograms(req.db, {
      profileId,
      profileContext: ctx,
    })
    return res.json(report)
  } catch (error) {
    routeLogger.error('[item-needs] green-home search error', error)
    return res.status(error?.statusCode || 500).json(formatError(error))
  }
})

/**
 * POST /api/item-needs/:profileId/search
 *
 * Body: `{ items?: string[] | string, variant?: 'funding'|'gift' }`.
 * Omitting `items` searches the profile's OWN derived + declared list — that is
 * the "crawl my whole item list" action. Supplying `items` searches exactly
 * those, which is the "I need X right now" action; the caller's words are used
 * verbatim and are never adjudicated against a vocabulary first.
 */
router.post('/:profileId/search', ensureAuth, mutationRateLimiter, async (req, res) => {
  const profileId = String(req.params.profileId ?? '').trim()
  if (!(await ensureProfileAccess(req, res, profileId))) return
  if (!(await requireTierCapability(req, res, profileId, TIER_CAPABILITIES.ITEM_FUNDING))) return

  try {
    const ctx = await loadContext(req.db, profileId)
    if (!ctx.profile) return res.status(404).json({ error: 'Profile not found' })

    const body = req.body ?? {}
    const explicit = body.items ?? body.item ?? null
    let items = []
    let subject = 'requested'
    if (explicit !== null && explicit !== undefined && String(explicit).length > 0) {
      items = parseDeclaredItemList(explicit)
    } else {
      const derived = deriveProfileItemNeeds(ctx.profile, ctx.sections ?? {})
      items = derived.needs.map((n) => n.need_text || n.item)
      subject = 'profile_item_list'
    }

    if (items.length === 0) {
      // HONEST EMPTY: nothing was searched because nothing was asked for and
      // the profile declares no item need. Do NOT invent a default item.
      return res.json({
        success: true,
        profile_id: profileId,
        subject,
        requested_count: 0,
        searched_count: 0,
        truncated: 0,
        total_found: 0,
        total_direct_funding: 0,
        total_research_leads: 0,
        total_awardable: 0,
        total_pointer: 0,
        items: [],
        note: 'No items to search. Add one in Financial Situation → "Items you need funding for", or pass items[] in the request.',
      })
    }

    // A ZERO FROM A DARK BACKEND IS NOT "NOTHING EXISTS". This is the route the
    // item scanner actually calls, and `searchItemNeeds` carries no provider
    // verdict of its own — so a 402'd Brave over a dead SearXNG rendered exactly
    // like a genuine "we searched and there is nothing for your need". The
    // sibling /needs-plan/search route already probes for precisely this reason;
    // the same block is attached here so the honest reason travels with the
    // zero.
    const backends = await probeSearchProviderHealth().catch((error) => ({
      verdict: 'unknown',
      detail: `probe failed: ${error?.message || error}`,
    }))
    const report = await searchItemNeeds(req.db, {
      profileId,
      items,
      profileContext: ctx,
      variant: body.variant === 'gift' ? 'gift' : 'funding',
      maxResults: Math.max(1, Math.min(Number(body.max_results) || 12, 40)),
    })
    return res.json({
      success: true,
      subject,
      profile_type: ctx.profile?.primary_type ?? ctx.profile?.applicant_type ?? null,
      max_items_per_run: ITEM_SEARCH_MAX_ITEMS,
      max_results_per_item: Math.max(1, Math.min(Number(body.max_results) || 12, 40)),
      search_backends: buildSearchBackendsBlock(backends),
      ...report,
    })
  } catch (error) {
    routeLogger.error('[item-needs] search error', error)
    return res.status(500).json(formatError(error))
  }
})

export default router
