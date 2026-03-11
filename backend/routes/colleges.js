/**
 * Colleges / Local Funding API
 * GET /api/colleges/local-funding?zip=XXXXX&radiusMiles=25
 * Returns local funding resources for a ZIP from the funding_opportunities table.
 */

import express from 'express'
import zipcodes from 'zipcodes'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'

const router = express.Router()

const REQUEST_ID_HEADER = 'x-request-id'

function normalizeZip(value) {
  if (value == null) return null
  const s = String(value).trim()
  const match = s.match(/\b(\d{5})(?:-\d{4})?\b/)
  return match ? match[1] : null
}

/**
 * GET /api/colleges/local-funding
 * Query: zip (required), radiusMiles (optional, default 25)
 * Response: { success, zip, radiusMiles, radiusFilteringApplied, results: [{ title, url, source, distanceMiles? }] }
 */
router.get('/local-funding', async (req, res) => {
  const requestId = req.get(REQUEST_ID_HEADER) || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const zipParam = req.query.zip
  const radiusParam = req.query.radiusMiles ?? req.query.radius_miles ?? 25
  const radiusMiles = Math.min(100, Math.max(1, parseInt(String(radiusParam), 10) || 25))

  if (!zipParam || String(zipParam).trim() === '') {
    console.warn(`[colleges/local-funding] ${requestId} zip missing or empty`)
    return res.status(400).json({
      success: false,
      error: 'zip_missing',
      message: 'Query parameter "zip" is required and must be a valid 5-digit US ZIP code.',
      request_id: requestId,
    })
  }

  const zip = normalizeZip(zipParam)
  if (!zip) {
    console.warn(`[colleges/local-funding] ${requestId} invalid zip: ${zipParam}`)
    return res.status(400).json({
      success: false,
      error: 'zip_invalid',
      message: 'Invalid ZIP code. Provide a valid 5-digit US ZIP (e.g. 43210).',
      request_id: requestId,
    })
  }

  try {
    const lookup = zipcodes.lookup(zip)
    const state = lookup?.state || null

    const db = req.db
    const isPostgres = db?.dialect === 'postgres'
    const activeVal = isPostgres ? 'TRUE' : '1'
    let rows = []

    if (state) {
      rows = db.prepare(`
        SELECT title, source_url, application_url, sponsor, source, state
        FROM funding_opportunities
        WHERE is_active = ${activeVal}
          AND (state = ? OR state = 'nationwide' OR is_national = ${activeVal})
          AND ${trustedOriginClause()}
          AND ${trustedSourceClause()}
        ORDER BY updated_at DESC
        LIMIT 50
      `).all(state)
    } else {
      rows = db.prepare(`
        SELECT title, source_url, application_url, sponsor, source, state
        FROM funding_opportunities
        WHERE is_active = ${activeVal}
          AND (is_national = ${activeVal} OR state = 'nationwide')
          AND ${trustedOriginClause()}
          AND ${trustedSourceClause()}
        ORDER BY updated_at DESC
        LIMIT 50
      `).all()
    }

    const results = rows.map((r) => ({
      title: r.title ?? 'Local resource',
      url: r.application_url ?? r.source_url ?? '',
      source: r.sponsor ?? r.source ?? 'Local',
    })).filter((r) => r.url && r.url.startsWith('http'))

    console.info(`[colleges/local-funding] ${requestId} zip=${zip} state=${state} results=${results.length}`)

    return res.json({
      success: true,
      zip,
      radiusMiles,
      radiusFilteringApplied: false,
      results,
      request_id: requestId,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[colleges/local-funding] ${requestId} zip=${zip} error:`, msg)
    return res.status(500).json({
      success: false,
      error: 'fetch_failed',
      message: 'Unable to fetch local funding. Please try again.',
      request_id: requestId,
    })
  }
})

export default router
