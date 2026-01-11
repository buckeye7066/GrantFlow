import express from 'express'
import { formatError } from '../middleware/errorHandler.js'
import { calculateMatchScore } from '../services/matchingEngine.js'

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
    const profile = req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // Use profile.organization_id to fetch the pipeline grants.
    if (!profile.organization_id) {
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
      .all(profile.organization_id)

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

      const computed = calculateMatchScore(profile, candidate)

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

export default router

