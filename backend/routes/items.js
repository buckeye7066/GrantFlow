import express from 'express'
import { requireAuthenticatedUser, ensureProfileAccess } from '../utils/accessControl.js'
import { suggestItemsForProfile, discoverNewCatalogItems, ensureItemCatalogSeeded } from '../services/itemCatalogService.js'
import { formatError } from '../middleware/errorHandler.js'

const router = express.Router()

router.get('/suggestions', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

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
    const response = await suggestItemsForProfile(req.db, {
      profileId,
      limit: Number.isFinite(limit) ? limit : 8,
    })

    return res.json(response)
  } catch (error) {
    console.error('[items/suggestions] error', error)
    return res.status(500).json(formatError(error))
  }
})

// Admin/manual trigger: discover new items from existing DB opportunities
router.post('/discover', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!req.ctx?.isAdmin) return res.status(403).json({ error: 'Admin privileges required' })

  try {
    const minCount = Number(req.body?.min_count ?? 3)
    const limit = Number(req.body?.limit ?? 50)
    const report = await discoverNewCatalogItems(req.db, { minCount, limit })
    return res.json(report)
  } catch (error) {
    console.error('[items/discover] error', error)
    return res.status(500).json(formatError(error))
  }
})

// Lightweight admin/debug endpoint: ensure catalog exists (idempotent)
router.post('/seed', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!req.ctx?.isAdmin) return res.status(403).json({ error: 'Admin privileges required' })

  try {
    const result = await ensureItemCatalogSeeded(req.db)
    return res.json(result)
  } catch (error) {
    console.error('[items/seed] error', error)
    return res.status(500).json(formatError(error))
  }
})

export default router

