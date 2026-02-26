import express from 'express'
import { formatError } from '../middleware/errorHandler.js'
import { calculateMatchScore } from '../services/matchingEngine.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { ensureProfileAccess } from '../utils/accessControl.js'
import { getDataReadiness } from '../services/dataReadinessService.js'
import { checkProfileReadiness } from '../services/profileReadinessService.js'

const router = express.Router()

function requireAuth(req, res) {
  if (!req.ctx?.userId) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  return req.ctx
}

async function requireProfileAccess(req, res, profileId) {
  const ctx = requireAuth(req, res)
  if (!ctx) return null
  if (ctx.isAdmin) return ctx

  const ok = await ensureProfileAccess(req, res, profileId)
  if (!ok) return null
  return ctx
}

/**
 * Match a profile to grants in its organization pipeline.
 * Returns: [{ grant_id, title, funder, status, deadline, match_score, match_reasons, funding_opportunity_id }]
 */
router.get('/profile/:profileId/grants', async (req, res) => {
  const profileId = req.params.profileId
  const auth = await requireProfileAccess(req, res, profileId)
  if (!auth) return

  try {
    const profileRow = await req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // Load full profile context (sections + signals) and taxonomy facets so scoring matches crawler behavior.
    const baseContext = await loadProfileContext(req.db, profileId)
    const profileContext = buildProfileFacets(baseContext)

    // Use profile.organization_id to fetch the pipeline grants.
    if (!profileRow.organization_id) {
      return res.json([])
    }

    const rows = await req.db
      .prepare(
        `
          SELECT
            g.id AS grant_id,
            g.title AS grant_title,
            g.funder AS grant_funder,
            g.status AS grant_status,
            g.deadline AS grant_deadline,
            g.notes AS grant_notes,
            g.funding_opportunity_id,
            fo.*
          FROM grants g
          LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
          WHERE g.organization_id = ?
          ORDER BY g.updated_at DESC, g.created_at DESC
        `,
      )
      .all(profileRow.organization_id)

    const matches = rows.map((row) => {
      // Prefer opportunity fields (when a grant is linked), otherwise fall back to the grant's own fields.
      const candidate = row.id
        ? {
            // Opportunity fields
            title: row.title,
            description: row.description,
            is_national: row.is_national,
            state: row.state,
            keywords: row.keywords,
            categories: row.categories,
            deadline: row.deadline ?? row.grant_deadline,
            deadline_type: row.deadline_type,
            amount_min: row.amount_min,
            amount_max: row.amount_max,
            requires_501c3: row.requires_501c3,
            requires_match: row.requires_match,
            match_percentage: row.match_percentage,
            eligibility_bullets: row.eligibility_bullets,
          }
        : {
            // Fallback to grant fields (limited fidelity)
            title: row.grant_title,
            description: row.grant_notes ?? null,
            is_national: null,
            state: null,
            keywords: null,
            categories: null,
            deadline: row.grant_deadline,
          }

      const computed = calculateMatchScore(profileContext, candidate)

      return {
        grant_id: row.grant_id,
        title: row.grant_title,
        funder: row.grant_funder,
        status: row.grant_status,
        deadline: row.grant_deadline,
        funding_opportunity_id: row.funding_opportunity_id ?? null,
        match_score: computed.score,
        match_reasons: computed.reasons,
      }
    })

    matches.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
    res.json(matches)
  } catch (error) {
    console.error('Error matching profile to grants:', error)
    res.status(500).json(formatError(error))
  }
})

/**
 * Match a profile to live funding opportunities.
 * Uses the full 22-page profileContext (sections + derived signals) to score.
 *
 * GET /api/matching/profile/:profileId/opportunities?min_score=60&limit=200&q=keyword
 */
router.get('/profile/:profileId/opportunities', async (req, res) => {
  const profileId = req.params.profileId
  const auth = await requireProfileAccess(req, res, profileId)
  if (!auth) return

  try {
    const profileRow = await req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // ── Profile readiness gate ────────────────────────────────────────────────
    // Skip only if caller explicitly passes ?skip_readiness_check=1 (for admin/debug use).
    if (req.query.skip_readiness_check !== '1') {
      const readiness = await checkProfileReadiness(req.db, profileId)
      if (!readiness.ready) {
        return res.status(422).json({
          error: 'profile_not_ready',
          message: readiness.guidance || 'Profile requires additional information before matching.',
          missing: readiness.missing,
          score: readiness.score,
          guidance: readiness.guidance,
        })
      }
    }

    // ── Data readiness gate ───────────────────────────────────────────────────
    // Skip only if caller explicitly passes ?skip_readiness_check=1.
    if (req.query.skip_readiness_check !== '1') {
      const dataReady = await getDataReadiness(req.db)
      if (dataReady.status === 'not_run') {
        return res.status(503).json({
          error: 'catalog_not_ready',
          message: 'The funding opportunity catalog has not been populated yet. Please run crawls first.',
          data_readiness: dataReady,
        })
      }
      if (dataReady.status === 'running') {
        return res.status(503).json({
          error: 'catalog_loading',
          message: 'Crawls are in progress. Please try again shortly.',
          data_readiness: dataReady,
        })
      }
    }

    const minScore = Number.parseInt(req.query.min_score ?? '50', 10)
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '2000', 10) || 2000, 1), 5000)
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''

    // Load profile context and build taxonomy facets so catalog scoring uses same intent/keywords as crawlers.
    const baseContext = await loadProfileContext(req.db, profileId)
    const profileContext = buildProfileFacets(baseContext)

    const conditions = ['is_active = ?']
    const params = []
    params.push(true)

    // Unconditional exclusion of loans and matching-required funds.
    const isPostgres = req.db?.dialect === 'postgres'
    conditions.push(
      isPostgres
        ? '(requires_match IS NULL OR requires_match = FALSE)'
        : '(requires_match = 0 OR requires_match IS NULL)',
    )
    conditions.push(
      isPostgres
        ? '(is_loan IS NULL OR is_loan = FALSE)'
        : '(is_loan = 0 OR is_loan IS NULL)',
    )

    // Only return real opportunities by default.
    // (We keep NULL as "unknown" origin, but explicitly exclude synthetic placeholders.)
    conditions.push("(record_origin IS NULL OR record_origin != 'synthetic')")
    conditions.push("(source IS NULL OR source NOT IN ('synthetic','template'))")

    // Keep results current: no expired deadlines unless rolling/ongoing/NULL.
    conditions.push(`(deadline_type IN ('rolling','ongoing') OR deadline IS NULL OR deadline >= ${req.db?.dialect === 'postgres' ? 'CURRENT_DATE' : "date('now')"})`)

    // Geography: expand outward. Do NOT hard-filter by state—let scoring surface best fits.
    // Profile state is used by calculateMatchScore for ranking; mismatches reduce score, not exclude.
    // (Previously excluded out-of-state opportunities entirely, blocking many relevant national/regional programs.)

    if (q) {
      conditions.push('(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ? OR LOWER(categories) LIKE ?)')
      const pattern = `%${q}%`
      params.push(pattern, pattern, pattern, pattern)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    // Candidate set: national first, then rolling/no-deadline, then upcoming fixed deadlines.
    const deadlineNullSort =
      req.db?.dialect === 'postgres' ? 'deadline IS NULL' : "deadline IS NULL OR deadline = ''"
    const isNationalSort = req.db?.dialect === 'postgres'
      ? "(is_national = TRUE OR state = 'nationwide')"
      : "(is_national = 1 OR state = 'nationwide')"

    const candidates = await req.db
      .prepare(
        `
          SELECT *
          FROM funding_opportunities
          ${where}
          ORDER BY
            CASE WHEN ${isNationalSort} THEN 0 ELSE 1 END,
            CASE WHEN ${deadlineNullSort} THEN 0 ELSE 1 END,
            deadline ASC,
            updated_at DESC
          LIMIT ?
        `,
      )
      .all(...params, limit)

    const scored = candidates
      .map((opp) => {
        const computed = calculateMatchScore(profileContext, opp)
        return {
          ...opp,
          match_score: computed.score,
          match_reasons: computed.reasons,
          // Normalize for frontend convenience.
          url: opp.application_url ?? opp.source_url ?? null,
        }
      })
      .filter((opp) => (Number.isFinite(minScore) ? (opp.match_score ?? 0) >= minScore : true))

    scored.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

    res.json({
      profile_id: profileId,
      min_score: Number.isFinite(minScore) ? minScore : null,
      total_scored: candidates.length,
      returned: scored.length,
      opportunities: scored,
    })
  } catch (error) {
    console.error('Error matching profile to opportunities:', error)
    res.status(500).json(formatError(error))
  }
})

export default router

