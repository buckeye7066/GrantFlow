/**
 * routes/fieldUsage.js
 *
 * Mission Goal 11 — Field-to-Funding Accountability surface.
 *
 * Exposes the canonical profileFieldUsageRegistry to the UI and to
 * Anya so:
 *
 *   - Form components can render a "Why are you asking for this?" tip
 *     next to every field.
 *   - The mission-health dashboard can show field-usage coverage.
 *   - Anya can answer "what does this field do" without GET-by-id loops
 *     against the bundle.
 *
 * Endpoints:
 *
 *   GET /api/field-usage              → { entries: [...], report: {...} }
 *   GET /api/field-usage/report       → { ...buildFieldUsageReport() }
 *   GET /api/field-usage/:id          → { entry }
 *
 * Read-only / no DB access; safe to cache aggressively at the edge.
 */

import express from 'express'
import {
  listFieldUsages,
  getFieldUsage,
  buildFieldUsageReport,
} from '../services/profileFieldUsageRegistry.js'

const router = express.Router()

// Long browser cache OK because the registry only changes on deploy.
const CACHE_HEADER = 'public, max-age=300, s-maxage=600'

router.get('/', (_req, res) => {
  res.set('Cache-Control', CACHE_HEADER)
  res.json({
    success: true,
    entries: listFieldUsages(),
    report: buildFieldUsageReport(),
  })
})

router.get('/report', (_req, res) => {
  res.set('Cache-Control', CACHE_HEADER)
  res.json({ success: true, report: buildFieldUsageReport() })
})

router.get('/:id', (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) {
    return res.status(400).json({ success: false, error: 'field id required' })
  }
  const entry = getFieldUsage(id)
  if (!entry) {
    return res.status(404).json({
      success: false,
      error: 'unknown field id',
      hint: 'Field must be registered in profileFieldUsageRegistry (Goal 11).',
    })
  }
  res.set('Cache-Control', CACHE_HEADER)
  res.json({ success: true, entry })
})

export default router
