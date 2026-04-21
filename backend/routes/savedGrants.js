/**
 * Saved Grants API
 *
 * GET    /api/saved-grants              — list saved grants for authenticated user
 * POST   /api/saved-grants              — save a grant (optional notes)
 * PATCH  /api/saved-grants/:id/notes    — update notes on a saved grant
 * DELETE /api/saved-grants/:id          — unsave a grant (id = opportunity_id)
 */

import { Router } from 'express'
import crypto from 'node:crypto'
import { requireAuthenticatedUser } from '../utils/accessControl.js'
import {
  assessOpportunityTrust,
  buildTrustMetadata,
} from '../services/opportunityTrust.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const userId = user.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    const userRows = await req.db.prepare(`
      SELECT sg.opportunity_id, sg.saved_at, sg.notes,
             fo.title, fo.sponsor, fo.deadline, fo.amount_min, fo.amount_max,
             fo.application_url, fo.link_status, fo.source,
             fo.source_category, fo.is_loan, fo.requires_matching_funds,
             fo.description, fo.categories
      FROM saved_grants sg
      LEFT JOIN funding_opportunities fo ON fo.id = sg.opportunity_id
      WHERE sg.user_id = ?
      ORDER BY sg.saved_at DESC
      LIMIT 500
    `).all(userId)

    // Attach canonical trust metadata so saved-grants UI and Anya can explain
    // lower-trust / directory / expired items consistently with discovery.
    const saved = userRows.map((row) => {
      const trust = assessOpportunityTrust(row, {
        allowDirectory: true,
        allowExpired: true, // saved items are always shown; mark status instead
      })
      const meta = buildTrustMetadata(trust) || {}
      return {
        ...row,
        trust_tier: meta.trust_tier ?? null,
        source_trust: meta.source_trust ?? null,
        trust_flags: meta.trust_flags ?? null,
        trust_reasons: meta.trust_reasons ?? [],
        trust_downgrade: Boolean(meta.trust_downgrade),
        trust_downgrade_reason: meta.trust_downgrade_reason ?? null,
        actionable_url: meta.actionable_url ?? row.application_url ?? null,
      }
    })

    res.json({ saved, ids: saved.map((r) => r.opportunity_id) })
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

    const { opportunity_id, notes } = req.body ?? {}
    if (!opportunity_id) return res.status(400).json({ error: 'opportunity_id required' })

    const id = crypto.randomUUID()
    await req.db.prepare(`
      INSERT INTO saved_grants (id, user_id, opportunity_id, notes)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, opportunity_id) DO UPDATE SET
        notes = COALESCE(excluded.notes, saved_grants.notes)
    `).run(id, userId, opportunity_id, notes ?? null)

    res.json({ saved: true, id })
  } catch (err) {
    console.error('[saved-grants] POST error:', err)
    res.status(500).json({ error: err.message })
  }
})

router.patch('/:opportunityId/notes', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const userId = user.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    const { notes } = req.body ?? {}
    if (typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' })

    const result = await req.db.prepare(`
      UPDATE saved_grants SET notes = ? WHERE user_id = ? AND opportunity_id = ?
    `).run(notes, userId, req.params.opportunityId)

    if (result.changes === 0) return res.status(404).json({ error: 'Saved grant not found' })
    res.json({ updated: true })
  } catch (err) {
    console.error('[saved-grants] PATCH notes error:', err)
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:opportunityId', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const userId = user.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    await req.db.prepare(`
      DELETE FROM saved_grants WHERE user_id = ? AND opportunity_id = ?
    `).run(userId, req.params.opportunityId)

    res.json({ removed: true })
  } catch (err) {
    console.error('[saved-grants] DELETE error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
