/**
 * Saved Grants API
 *
 * GET    /api/saved-grants       — list saved grant IDs for authenticated user
 * POST   /api/saved-grants       — save a grant
 * DELETE /api/saved-grants/:id   — unsave a grant (id = opportunity_id)
 */

import { Router } from 'express'
import crypto from 'node:crypto'
import { requireAuthenticatedUser } from '../utils/accessControl.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const userId = user.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    const userRows = req.db.prepare(`
      SELECT sg.opportunity_id, sg.saved_at,
             fo.title, fo.sponsor, fo.deadline, fo.amount_min, fo.amount_max,
             fo.application_url, fo.link_status, fo.source
      FROM saved_grants sg
      LEFT JOIN funding_opportunities fo ON fo.id = sg.opportunity_id
      WHERE sg.user_id = ?
      ORDER BY sg.saved_at DESC
      LIMIT 500
    `).all(userId)

    res.json({ saved: userRows, ids: userRows.map(r => r.opportunity_id) })
  } catch (err) {
    console.error('[saved-grants] GET error:', err)
    res.status(500).json({ error: err.message })
  }
})

router.post('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const userId = user.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    const { opportunity_id } = req.body ?? {}
    if (!opportunity_id) return res.status(400).json({ error: 'opportunity_id required' })

    const id = crypto.randomUUID()
    req.db.prepare(`
      INSERT INTO saved_grants (id, user_id, opportunity_id)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, opportunity_id) DO NOTHING
    `).run(id, userId, opportunity_id)

    res.json({ saved: true, id })
  } catch (err) {
    console.error('[saved-grants] POST error:', err)
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:opportunityId', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const userId = user.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    req.db.prepare(`
      DELETE FROM saved_grants WHERE user_id = ? AND opportunity_id = ?
    `).run(userId, req.params.opportunityId)

    res.json({ removed: true })
  } catch (err) {
    console.error('[saved-grants] DELETE error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
