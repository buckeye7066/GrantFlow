/**
 * itemNeeds.js — the profile's ITEM LIST, and an on-demand crawl for it.
 *
 * ACCESS: every route is `ensureProfileAccess` (owner-or-admin, the same gate
 * every other profile mutation uses). The profile id is a PATH parameter that
 * is checked against the caller's accessible set — never a guessable id, never
 * an unauthenticated lookup.
 *
 *   GET  /api/item-needs/:profileId          — derived + declared item list
 *   POST /api/item-needs/:profileId/search   — crawl one item or a list
 *
 * The search route is additionally held to the SAME tier capability as the
 * existing item-funding lane (`TIER_CAPABILITIES.ITEM_FUNDING`), so the two
 * cannot diverge into different entitlement stories.
 */

import express from 'express'
import { ensureAuth } from '../middleware/auth.js'
import { ensureProfileAccess } from '../utils/accessControl.js'
import { requireTierCapability, TIER_CAPABILITIES } from '../utils/tierGating.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { deriveProfileItemNeeds } from '../config/profileItemNeeds.js'
import { searchItemNeeds, ITEM_SEARCH_MAX_ITEMS } from '../services/itemNeedSearch.js'
import { formatError } from '../middleware/errorHandler.js'
import { createLogger } from '../utils/logger.js'

const routeLogger = createLogger('route:itemNeeds')
const router = express.Router()

/** Load the profile + sections once; both routes read the same canonical view. */
async function loadContext(db, profileId) {
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
router.get('/:profileId', ensureAuth, async (req, res) => {
  const profileId = String(req.params.profileId ?? '').trim()
  if (!(await ensureProfileAccess(req, res, profileId))) return
  try {
    const ctx = await loadContext(req.db, profileId)
    if (!ctx.profile) return res.status(404).json({ error: 'Profile not found' })
    const derived = deriveProfileItemNeeds(ctx.profile, ctx.sections ?? {})
    return res.json({
      success: true,
      profile_id: profileId,
      display_name: ctx.profile.display_name ?? null,
      primary_type: ctx.profile.primary_type ?? null,
      count: derived.needs.length,
      truncated: derived.truncated,
      needs: derived.needs,
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
 * POST /api/item-needs/:profileId/search
 *
 * Body: `{ items?: string[] | string, variant?: 'funding'|'gift' }`.
 * Omitting `items` searches the profile's OWN derived + declared list — that is
 * the "crawl my whole item list" action. Supplying `items` searches exactly
 * those, which is the "I need X right now" action; the caller's words are used
 * verbatim and are never adjudicated against a vocabulary first.
 */
router.post('/:profileId/search', ensureAuth, async (req, res) => {
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
      items = (Array.isArray(explicit) ? explicit : [explicit]).map((v) => String(v ?? '').trim()).filter(Boolean)
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
        total_awardable: 0,
        total_pointer: 0,
        items: [],
        note: 'No items to search. Add one in Financial Situation → "Items you need funding for", or pass items[] in the request.',
      })
    }

    const report = await searchItemNeeds(req.db, {
      profileId,
      items,
      profileContext: ctx,
      variant: body.variant === 'gift' ? 'gift' : 'funding',
    })
    return res.json({ success: true, subject, max_items_per_run: ITEM_SEARCH_MAX_ITEMS, ...report })
  } catch (error) {
    routeLogger.error('[item-needs] search error', error)
    return res.status(500).json(formatError(error))
  }
})

export default router
