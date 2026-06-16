/**
 * Funding Library API
 *
 * GET /api/funding-library             list (filterable)
 * GET /api/funding-library/:id         single record
 *
 * Authenticated read-only. Cross-tenant by design — the Funding Library
 * is the GrantFlow general resources pool, not a profile-specific pipeline.
 * Profile-specific recommendations live under /api/robert/recommendations
 * (created by the Robert agent), and accepting a recommendation goes
 * through the existing canonical add-to-pipeline path.
 */
import express from 'express'
import { requireAuthenticatedUserMiddleware } from '../utils/accessControl.js'
import {
  listFundingLibrary,
  getFundingLibraryItem,
} from '../services/fundingLibraryService.js'
import { createLogger } from '../utils/logger.js'

const routeLogger = createLogger('route:funding-library')
const router = express.Router()

router.use(requireAuthenticatedUserMiddleware)

router.get('/', async (req, res) => {
  try {
    const opts = {
      state: req.query.state || null,
      applicant_type: req.query.applicant_type || null,
      category: req.query.category || null,
      q: req.query.q || null,
      deadline: req.query.deadline || null,
      source_trust: req.query.source_trust || null,
      record_origin: req.query.record_origin || null,
      kind: req.query.kind || null,
      include_unverified: parseBool(req.query.include_unverified),
      include_loans: parseBool(req.query.include_loans),
      sort: req.query.sort || 'discovered_at',
      sort_dir: req.query.sort_dir || 'desc',
      limit: req.query.limit,
      offset: req.query.offset,
    }
    const result = await listFundingLibrary(req.db, opts)
    return res.status(200).json({ ok: true, ...result })
  } catch (err) {
    routeLogger.error('list_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const item = await getFundingLibraryItem(req.db, req.params.id)
    if (!item) return res.status(404).json({ ok: false, error: 'not_found' })
    return res.status(200).json({ ok: true, item })
  } catch (err) {
    routeLogger.error('get_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

function parseBool(v) {
  if (v === true || v === '1' || v === 'true' || v === 'yes') return true
  return false
}

export default router
