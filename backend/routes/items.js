import express from 'express'
import { requireAuthenticatedUser, ensureProfileAccess } from '../utils/accessControl.js'
import { suggestItemsForProfile, discoverNewCatalogItems, ensureItemCatalogSeeded } from '../services/itemCatalogService.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { deriveProfileItemNeeds } from '../config/profileItemNeeds.js'
import { formatError } from '../middleware/errorHandler.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:items')

const router = express.Router()

router.get('/suggestions', async (req, res) => {
  if (!requireAuthenticatedUser(req, res)) return

  try {
    const profileIdRaw = req.query.profile_id ? String(req.query.profile_id) : null
    const profileId = profileIdRaw ?? (req.ctx?.activeProfileId ? String(req.ctx.activeProfileId) : null)
    if (!profileId) {
      return res.status(400).json({ error: 'profile_id required' })
    }

    if (!req.ctx?.isAdmin) {
      if (!(await ensureProfileAccess(req, res, String(profileId)))) return
    }

    const limit = Number.parseInt(String(req.query.limit ?? '8'), 10)
    const safeLimit = Number.isFinite(limit) ? limit : 8

    // DERIVED FIRST (owner rule 2026-08-02). `suggestItemsForProfile` scores a
    // NINE-ROW fixture (laptop / desktop / hotspot / wheelchair van /
    // wheelchair / hearing aids / glasses / school supplies / work clothing)
    // against coarse need buckets and asks an LLM for the rest, so two profiles
    // with nothing in common get the same nine candidates — Focus Forward
    // Ministry, whose declared focus areas contain "Building supplies", was
    // offered hearing aids. The suggestions this endpoint serves now come from
    // what the profile actually DECLARED, each carrying the field id it was
    // read from. Response shape is unchanged so the existing chips render as-is.
    let derived = null
    let derivationError = null
    try {
      const ctx = await loadProfileContext(req.db, String(profileId))
      derived = deriveProfileItemNeeds(ctx?.profile ?? {}, ctx?.sections ?? {})
    } catch (err) {
      derivationError = err?.message ?? String(err)
      routeLogger.warn(`[items/suggestions] derivation failed: ${derivationError}`)
    }

    if (derived) {
      return res.json({
        profile_id: String(profileId),
        count: Math.min(derived.needs.length, safeLimit),
        suggestions: derived.needs.slice(0, safeLimit).map((n) => ({
          name: n.item,
          category: n.category,
          // Not a score: these are DERIVED facts, not ranked guesses. A number
          // here would imply a measurement nobody made.
          score: null,
          reasons: [`Declared in ${n.evidence}`],
          source: n.source,
          evidence: n.evidence,
          need_text: n.need_text,
        })),
        // Honest empties: an owner whose list is short can see exactly which
        // declared fields produced nothing and which values named no item.
        unmapped: derived.unmapped,
        silent_fields: derived.silentFields,
        free_text_field: 'financial_information.item_needs',
        generated_at: new Date().toISOString(),
      })
    }

    // Derivation unavailable (the profile could not be READ) — fall back to the
    // legacy catalog scorer rather than returning nothing. But SAY SO: that
    // scorer is the nine-row fixture described above, which offered hearing
    // aids to a building-supplies ministry. Handing those back silently, in the
    // exact response shape the derived (evidence-carrying) answer uses, makes a
    // failed read indistinguishable from a real reading of the profile. The
    // caller now gets the flag and the reason.
    const response = await suggestItemsForProfile(req.db, { profileId, limit: safeLimit })
    return res.json({
      ...response,
      derivation_failed: true,
      derivation_error: derivationError,
      suggestion_basis: 'legacy_catalog_scorer',
      warning:
        'These are generic catalog suggestions, not facts read from this profile: the profile could not be loaded. Do not treat them as declared needs.',
    })
  } catch (error) {
    routeLogger.error('[items/suggestions] error', error)
    return res.status(500).json(formatError(error))
  }
})

// Admin/manual trigger: discover new items from existing DB opportunities
router.post('/discover', async (req, res) => {
  if (!requireAuthenticatedUser(req, res)) return
  if (!req.ctx?.isAdmin) return res.status(403).json({ error: 'Admin privileges required' })

  try {
    const minCount = Number(req.body?.min_count ?? 3)
    const limit = Number(req.body?.limit ?? 50)
    const report = await discoverNewCatalogItems(req.db, { minCount, limit })
    return res.json(report)
  } catch (error) {
    routeLogger.error('[items/discover] error', error)
    return res.status(500).json(formatError(error))
  }
})

// Lightweight admin/debug endpoint: ensure catalog exists (idempotent)
router.post('/seed', async (req, res) => {
  if (!requireAuthenticatedUser(req, res)) return
  if (!req.ctx?.isAdmin) return res.status(403).json({ error: 'Admin privileges required' })

  try {
    const result = await ensureItemCatalogSeeded(req.db)
    return res.json(result)
  } catch (error) {
    routeLogger.error('[items/seed] error', error)
    return res.status(500).json(formatError(error))
  }
})

export default router

