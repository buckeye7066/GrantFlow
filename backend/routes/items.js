import express from 'express'
import { requireAuthenticatedUser, ensureProfileAccess } from '../utils/accessControl.js'
import { discoverNewCatalogItems, ensureItemCatalogSeeded } from '../services/itemCatalogService.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { buildProfileNeedSuggestions } from '../services/needs/profileNeedSuggestions.js'
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
    // DERIVED FIRST (owner rule 2026-08-02), and NEVER EMPTY for a parsed
    // profile (owner rule 2026-09-05: "a profile is only in GrantFlow if it
    // has a need; no inferred needs means the profile was not parsed"). The
    // ladder in profileNeedSuggestions: declared item needs → the needs plan
    // → declared canonical needs → an explicit PARSE FAILURE. Each tier is a
    // declared or type-derived fact; nothing is guessed from prose.
    let ctx = null
    let derivationError = null
    try {
      ctx = await loadProfileContext(req.db, String(profileId))
    } catch (err) {
      derivationError = err?.message ?? String(err)
      routeLogger.warn(`[items/suggestions] profile read failed: ${derivationError}`)
    }

    if (ctx) {
      const built = buildProfileNeedSuggestions({ profile: ctx?.profile ?? {}, sections: ctx?.sections ?? {}, limit: safeLimit })
      if (built.parse_failure) {
        routeLogger.warn('[items/suggestions] parse failure: no need readable from the profile', { profile_id: String(profileId) })
      }
      return res.json({
        profile_id: String(profileId),
        count: built.suggestions.length,
        suggestions: built.suggestions,
        suggestion_basis: built.basis,
        parse_failure: built.parse_failure,
        message: built.message,
        // Honest empties: an owner whose list is short can see exactly which
        // declared fields produced nothing and which values named no item.
        unmapped: built.unmapped,
        silent_fields: built.silent_fields,
        free_text_field: 'financial_information.item_needs',
        generated_at: new Date().toISOString(),
      })
    }

    // A failed profile read is not permission to substitute the old nine-item
    // generic scorer. Fail closed so the UI cannot present guesses as needs the
    // profile declared.
    return res.status(503).json({
      error: 'profile_item_derivation_unavailable',
      message: 'GrantFlow could not read this profile well enough to derive item needs. Retry after the profile service is available.',
      profile_id: String(profileId),
      suggestions: [],
      derivation_failed: true,
      derivation_error: derivationError,
      suggestion_basis: 'none',
      parse_failure: true,
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
