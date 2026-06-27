/**
 * Funding Trace Routes (admin only)
 * ---------------------------------
 * POST /api/admin/funding-trace        -> trace where an entity gets its funding
 * POST /api/admin/funding-trace/add    -> add a traced source to the catalog
 *
 * Mounted under /api/admin which is already guarded by ensureAuth + ensureAdmin.
 */

import express from 'express'
import crypto from 'crypto'
import { FUNDING_TRACE_ENTITY_TYPES, traceFunding, traceSourceToOpportunity } from '../services/fundingTraceService.js'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { createLogger } from '../utils/logger.js'

const routeLogger = createLogger('route:fundingTrace')
const router = express.Router()

// Self-guard so the feature is admin-only regardless of mount order.
router.use(ensureAuth)
router.use(ensureAdmin)

const VALID_ENTITY_TYPES = new Set(FUNDING_TRACE_ENTITY_TYPES)

router.post('/', async (req, res) => {
  const { entity, entity_type: entityType = 'company', use_ai: useAi = true } = req.body || {}

  if (!entity || !String(entity).trim()) {
    return res.status(400).json({ error: 'entity is required' })
  }
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    return res.status(400).json({ error: `entity_type must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}` })
  }

  try {
    const result = await traceFunding(req.db, { entity: String(entity), entityType, useAi: useAi !== false })
    return res.json(result)
  } catch (error) {
    routeLogger.error('[funding-trace] failed', error?.message)
    return res.status(500).json({ error: error?.message || 'Funding trace failed' })
  }
})

/**
 * Add a single traced source to the funding_opportunities catalog.
 * Reuses the same payload shape as POST /api/opportunities for consistency.
 */
router.post('/add', async (req, res) => {
  const { source, entity } = req.body || {}
  if (!source || !source.name) {
    return res.status(400).json({ error: 'source (with a name) is required' })
  }

  try {
    const payload = traceSourceToOpportunity(source, entity || source.name)
    const id = crypto.randomUUID()

    const arrayFields = ['categories', 'keywords', 'eligibility_bullets']
    const data = { ...payload }
    for (const f of arrayFields) {
      if (Array.isArray(data[f])) data[f] = JSON.stringify(data[f])
    }
    const entries = Object.entries(data).filter(([, v]) => v !== undefined)
    const columns = ['id', ...entries.map(([k]) => k)]
    const values = [id, ...entries.map(([, v]) => v)]
    const placeholders = columns.map(() => '?').join(', ')

    await req.db
      .prepare(`INSERT INTO funding_opportunities (${columns.join(', ')}) VALUES (${placeholders})`)
      .run(...values)

    const opp = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(id)
    return res.status(201).json({ ok: true, opportunity: opp })
  } catch (error) {
    routeLogger.error('[funding-trace/add] failed', error?.message)
    return res.status(500).json({ error: error?.message || 'Failed to add source' })
  }
})

export default router
