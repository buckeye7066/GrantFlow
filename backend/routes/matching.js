import express from 'express'
import { formatError } from '../middleware/errorHandler.js'
import { calculateMatchScore } from '../services/matchingEngine.js'
import { loadProfileContext } from '../services/profileHelpers.js'

const router = express.Router()

function requireAuth(req, res) {
  const auth = req.user ?? { role: 'guest' }
  if (auth.role === 'guest') {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  return auth
}

function requireProfileAccess(req, res, profileId) {
  const auth = requireAuth(req, res)
  if (!auth) return null

  if (auth.role === 'admin') return auth

  // Non-admin tokens are scoped to a single profile [[memory:12811124]]
  if (!auth.profileId || auth.profileId !== profileId) {
    res.status(403).json({ error: 'Not authorized to access this profile' })
    return null
  }

  return auth
}

/**
 * Match a profile to grants in its organization pipeline.
 * Returns: [{ grant_id, title, funder, status, deadline, match_score, match_reasons, funding_opportunity_id }]
 */
router.get('/profile/:profileId/grants', (req, res) => {
  const profileId = req.params.profileId
  const auth = requireProfileAccess(req, res, profileId)
  if (!auth) return

  try {
    const profileRow = req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // Load full profile context (sections + signals) so scoring uses the 22-page application data.
    const profileContext = loadProfileContext(req.db, profileId)

    // Use profile.organization_id to fetch the pipeline grants.
    if (!profileRow.organization_id) {
      return res.json([])
    }

    const rows = req.db
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
router.get('/profile/:profileId/opportunities', (req, res) => {
  const profileId = req.params.profileId
  const auth = requireProfileAccess(req, res, profileId)
  if (!auth) return

  try {
    const profileRow = req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const minScore = Number.parseInt(req.query.min_score ?? '60', 10)
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '200', 10) || 200, 1), 2000)
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''

    const profileContext = loadProfileContext(req.db, profileId)
    const profileState = profileContext?.signals?.location?.state ?? null

    const conditions = ['is_active = 1']
    const params = []

    // Keep results current: no expired deadlines unless rolling/ongoing/NULL.
    conditions.push('(deadline_type IN ("rolling","ongoing") OR deadline IS NULL OR deadline >= date("now"))')

    // Default geography behavior: state + national + NULL state.
    if (profileState && typeof profileState === 'string' && profileState.length === 2) {
      conditions.push('(state = ? OR is_national = 1 OR state IS NULL)')
      params.push(profileState)
    }

    if (q) {
      conditions.push('(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ? OR LOWER(categories) LIKE ?)')
      const pattern = `%${q}%`
      params.push(pattern, pattern, pattern, pattern)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    // Candidate set: prioritize upcoming deadlines first, then recently updated.
    const candidates = req.db
      .prepare(
        `
          SELECT *
          FROM funding_opportunities
          ${where}
          ORDER BY
            CASE WHEN deadline IS NULL OR deadline = '' THEN 1 ELSE 0 END,
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
          url: opp.application_url ?? opp.source_url ?? opp.record_origin ?? null,
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

