/**
 * Colleges / Local Funding API
 * GET /api/colleges/local-funding?zip=XXXXX&radiusMiles=25
 * Returns local funding resources for a ZIP. Uses localFundingCrawler when profile/signals available.
 */

import express from 'express'
import { crawlLocalFunding } from '../services/crawlers/localFundingCrawler.js'

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
    const minimalProfile = {
      sections: {},
      signals: {
        location: { zip, city: null, state: null },
        keywordSet: new Set(),
        interests: new Set(),
        demographics: new Set(),
      },
      zip_code: zip,
      zip,
      state: null,
      city: null,
    }

    const rawResults = await crawlLocalFunding(minimalProfile, {
      radius_miles: radiusMiles,
      min_match_score: 50,
      include_directory_resources: 'true',
    })

    const hasDistanceData = rawResults.some((r) => r.distance_miles != null)
    const radiusFilteringApplied = hasDistanceData
    let results = rawResults.map((r) => ({
      title: r.title ?? r.sponsor ?? 'Local resource',
      url: r.application_url ?? r.url ?? r.source_url ?? '',
      source: r.source ?? r.sponsor ?? 'Local',
      distanceMiles: r.distance_miles ?? undefined,
    }))

    if (radiusFilteringApplied) {
      results = results.filter((r) => r.distanceMiles == null || r.distanceMiles <= radiusMiles)
    }

    console.info(`[colleges/local-funding] ${requestId} zip=${zip} radius=${radiusMiles} results=${results.length} filtering=${radiusFilteringApplied}`)

    return res.json({
      success: true,
      zip,
      radiusMiles,
      radiusFilteringApplied,
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
