/**
 * Foundation Search Routes — powered by ProPublica 990 data + NSF + SAM Assistance
 *
 * Provides GrantWatch-beating foundation/funder search with IRS 990 financial data,
 * NSF award search, and CFDA federal assistance listings — all free, no subscription.
 */

import express from 'express'
import { requireAuthenticatedUser } from '../utils/accessControl.js'
import * as propublica from '../src/integrations/propublica990.js'
import * as nsf from '../src/integrations/nsfAwards.js'
import * as samAL from '../src/integrations/samAssistanceListings.js'
import { formatError } from '../middleware/errorHandler.js'

const router = express.Router()

// ── Foundation / 990 Search ───────────────────────────────────────────────────

/**
 * GET /api/foundations/search?q=...&state=...&page=0
 * Search nonprofits/foundations via ProPublica 990 data.
 */
router.get('/search', async (req, res) => {
  if (!requireAuthenticatedUser(req, res)) return

  try {
    const q = String(req.query.q || '').trim()
    if (!q) return res.status(400).json({ error: 'Search query (q) is required' })

    const result = await propublica.searchOrganizations({
      q,
      page: Number(req.query.page) || 0,
      state: req.query.state || undefined,
      ntee: req.query.ntee || undefined,
      c_code: req.query.c_code || undefined,
    })

    res.json(result)
  } catch (error) {
    console.error('[foundations/search] error', error?.message)
    res.status(500).json(formatError(error))
  }
})

/**
 * GET /api/foundations/:ein
 * Get detailed organization info + 990 filing history.
 */
router.get('/:ein', async (req, res) => {
  if (!requireAuthenticatedUser(req, res)) return

  try {
    const ein = String(req.params.ein).replace(/\D/g, '')
    if (ein.length !== 9) return res.status(400).json({ error: 'EIN must be 9 digits' })

    const org = await propublica.getOrganization(ein)
    res.json(org)
  } catch (error) {
    console.error('[foundations/:ein] error', error?.message)
    res.status(500).json(formatError(error))
  }
})

/**
 * GET /api/foundations/:ein/filing/:taxPeriod
 * Get specific 990 filing details.
 */
router.get('/:ein/filing/:taxPeriod', async (req, res) => {
  if (!requireAuthenticatedUser(req, res)) return

  try {
    const ein = String(req.params.ein).replace(/\D/g, '')
    const taxPeriod = String(req.params.taxPeriod)
    const filing = await propublica.getFiling(ein, taxPeriod)
    res.json(filing)
  } catch (error) {
    console.error('[foundations/filing] error', error?.message)
    res.status(500).json(formatError(error))
  }
})

// ── NSF Awards Search ─────────────────────────────────────────────────────────

/**
 * GET /api/foundations/nsf/search?keyword=...&state=...
 * Search NSF funded awards.
 */
router.get('/nsf/search', async (req, res) => {
  if (!requireAuthenticatedUser(req, res)) return

  try {
    const results = await nsf.fetchOpportunities({
      keyword: req.query.keyword || req.query.q || '',
      fundProgramName: req.query.program || undefined,
      awardeeStateCode: req.query.state || undefined,
      dateStart: req.query.dateStart || undefined,
      dateEnd: req.query.dateEnd || undefined,
      offset: Number(req.query.offset) || 1,
      limit: Math.min(Number(req.query.limit) || 25, 25),
    })

    res.json({ count: results.length, opportunities: results })
  } catch (error) {
    console.error('[foundations/nsf] error', error?.message)
    res.status(500).json(formatError(error))
  }
})

// ── SAM Assistance Listings (CFDA) Search ─────────────────────────────────────

/**
 * GET /api/foundations/federal/search?keyword=...&assistanceType=...
 * Search the CFDA catalog of federal assistance programs.
 */
router.get('/federal/search', async (req, res) => {
  if (!requireAuthenticatedUser(req, res)) return

  try {
    const results = await samAL.fetchAssistanceListings({
      keyword: req.query.keyword || req.query.q || '',
      assistanceType: req.query.assistanceType || undefined,
      applicantType: req.query.applicantType || undefined,
      page: Number(req.query.page) || 1,
      limit: Math.min(Number(req.query.limit) || 25, 100),
    })

    res.json(results)
  } catch (error) {
    console.error('[foundations/federal] error', error?.message)
    res.status(500).json(formatError(error))
  }
})

// ── Grant Calendar (Deadline View) ────────────────────────────────────────────

/**
 * GET /api/foundations/calendar?profileId=...&month=2026-04
 * Get grants with deadlines for calendar view.
 */
router.get('/calendar/deadlines', async (req, res) => {
  if (!requireAuthenticatedUser(req, res)) return

  try {
    const userId = req.ctx?.userId
    const profileId = req.query.profileId || null
    const month = req.query.month || null // YYYY-MM format

    let dateFilter = ''
    const params = []

    if (month) {
      // Filter to specific month
      const [year, mo] = month.split('-')
      const startDate = `${year}-${mo}-01`
      const endDate = `${year}-${String(Number(mo) + 1).padStart(2, '0')}-01`
      if (Number(mo) === 12) {
        dateFilter = " AND fo.deadline >= ? AND fo.deadline < ?"
        params.push(startDate, `${Number(year) + 1}-01-01`)
      } else {
        dateFilter = " AND fo.deadline >= ? AND fo.deadline < ?"
        params.push(startDate, endDate)
      }
    } else {
      // Default: next 90 days
      const dialect = req.db?.dialect || 'sqlite'
      if (dialect === 'postgres') {
        dateFilter = " AND fo.deadline >= CURRENT_DATE AND fo.deadline <= (CURRENT_DATE + INTERVAL '90 days')"
      } else {
        dateFilter = " AND fo.deadline >= date('now') AND fo.deadline <= date('now', '+90 days')"
      }
    }

    // Get from saved grants (user's pipeline)
    const savedSql = `
      SELECT fo.id, fo.title, fo.sponsor, fo.deadline, fo.deadline_type,
             fo.amount_min, fo.amount_max, fo.state, fo.source,
             fo.application_url, fo.source_url,
             g.status as pipeline_status, g.notes as pipeline_notes
      FROM grants g
      JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
      WHERE g.user_id = ?${profileId ? ' AND g.profile_id = ?' : ''}
        AND fo.deadline IS NOT NULL${dateFilter}
      ORDER BY fo.deadline ASC
      LIMIT 200
    `
    const savedParams = profileId ? [userId, profileId, ...params] : [userId, ...params]

    let savedGrants = []
    try {
      savedGrants = await req.db.prepare(savedSql).all(...savedParams)
    } catch {
      // grants table may not have all columns; fall through
    }

    // Also get matched opportunities with deadlines
    const matchedSql = `
      SELECT id, title, sponsor, deadline, deadline_type,
             amount_min, amount_max, state, source,
             application_url, source_url
      FROM funding_opportunities
      WHERE deadline IS NOT NULL
        AND is_active = ${req.db?.dialect === 'postgres' ? 'TRUE' : '1'}
        ${dateFilter}
      ORDER BY deadline ASC
      LIMIT 500
    `
    let matchedOpps = []
    try {
      matchedOpps = await req.db.prepare(matchedSql).all(...params)
    } catch {
      // may fail if table structure differs
    }

    // Merge and deduplicate
    const seen = new Set()
    const events = []
    for (const g of savedGrants) {
      seen.add(g.id)
      events.push({ ...g, calendar_source: 'pipeline' })
    }
    for (const o of matchedOpps) {
      if (!seen.has(o.id)) {
        events.push({ ...o, calendar_source: 'catalog' })
      }
    }

    events.sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''))

    res.json({ count: events.length, events })
  } catch (error) {
    console.error('[foundations/calendar] error', error?.message)
    res.status(500).json(formatError(error))
  }
})

export default router
