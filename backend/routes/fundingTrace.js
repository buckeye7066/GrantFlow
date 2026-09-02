/**
 * Funding Trace Routes (admin only)
 * ---------------------------------
 * POST /api/admin/funding-trace        -> trace where an entity gets its funding
 * POST /api/admin/funding-trace/add    -> add a traced source to the catalog
 *
 * Mounted under /api/admin which is already guarded by ensureAuth + ensureAdmin.
 */

import express from 'express'
import {
  FUNDING_TRACE_ENTITY_TYPES,
  isSourceAddable,
  traceFunding,
  traceSourceToOpportunity,
} from '../services/fundingTraceService.js'
import { upsertFundingOpportunity } from '../services/opportunityInserter.js'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { createLogger } from '../utils/logger.js'

const routeLogger = createLogger('route:fundingTrace')
const router = express.Router()

// Self-guard so the feature is admin-only regardless of mount order.
router.use(ensureAuth)
router.use(ensureAdmin)

const VALID_ENTITY_TYPES = new Set(FUNDING_TRACE_ENTITY_TYPES)

router.post('/', async (req, res) => {
  const { entity, entity_type: entityType = 'company', use_ai: useAi = false } = req.body || {}

  if (!entity || !String(entity).trim()) {
    return res.status(400).json({ error: 'entity is required' })
  }
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    return res.status(400).json({ error: `entity_type must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}` })
  }

  try {
    const result = await traceFunding(req.db, { entity: String(entity), entityType, useAi: useAi === true })
    return res.json(result)
  } catch (error) {
    routeLogger.error('[funding-trace] failed', error?.message)
    return res.status(500).json({ error: error?.message || 'Funding trace failed' })
  }
})

/**
 * Add a single traced source to the funding_opportunities catalog.
 * Reuses the same payload shape as POST /api/opportunities for consistency.
 *
 * Routed through the canonical upsertFundingOpportunity() admission gate
 * (per docs/canonical_rules.md's single-admission-gate rule) instead of a
 * raw INSERT - gets canonicalOpportunityKey dedup, URL hygiene, the reality
 * gate, and resolveOpportunityAmounts() for free. A traced row is a
 * DIRECTORY pointer (see traceSourceToOpportunity's opportunity_kind), so
 * allowDirectories is passed explicitly even though it already defaults true.
 */
router.post('/add', async (req, res) => {
  const { source, entity, entity_type: entityType = 'company' } = req.body || {}
  if (!source?.key) {
    return res.status(400).json({ error: 'source (with its trace key) is required' })
  }
  if (!entity || !String(entity).trim()) {
    return res.status(400).json({ error: 'entity is required so official evidence can be revalidated' })
  }
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    return res.status(400).json({ error: `entity_type must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}` })
  }

  try {
    // Browser-returned source fields are untrusted. Re-run the official trace
    // and select by the opaque server-derived key so a caller cannot turn an AI
    // hypothesis or edited amount/year/status into an addable catalog row.
    const retraced = await traceFunding(req.db, {
      entity: String(entity),
      entityType,
      useAi: false,
    })
    if (retraced.data_sources?.usaspending?.status === 'unavailable') {
      return res.status(503).json({
        error: 'funding_trace_evidence_unavailable',
        message: 'USASpending evidence could not be revalidated. Nothing was added; retry when the official source is available.',
      })
    }
    const verifiedSource = (retraced.sources || []).find((candidate) => candidate.key === source.key)
    if (!verifiedSource || !isSourceAddable(verifiedSource)) {
      return res.status(422).json({
        error: 'unverified_trace_source',
        message: 'The requested source was not present as current, verified award evidence for the resolved recipient.',
      })
    }

    const payload = traceSourceToOpportunity(verifiedSource, retraced.entity)
    const result = await upsertFundingOpportunity(req.db, payload, { allowDirectories: true })

    if (result.skipped) {
      return res.status(422).json({ ok: false, skipped: true, reason: result.reason })
    }

    const opp = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(result.id)
    return res.status(result.inserted ? 201 : 200).json({ ok: true, opportunity: opp })
  } catch (error) {
    routeLogger.error('[funding-trace/add] failed', error?.message)
    return res.status(500).json({ error: error?.message || 'Failed to add source' })
  }
})

export default router
