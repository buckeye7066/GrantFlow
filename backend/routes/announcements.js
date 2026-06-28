/**
 * Login announcements — one-time, dismissible messages shown to users after
 * they log in (e.g. "how to merge your portals and what that means").
 *
 *   GET  /api/announcements/pending  -> active announcements this user hasn't
 *        dismissed, scoped to audience 'all' or a profile they can access.
 *   POST /api/announcements/:id/dismiss -> record per-user dismissal (shows once).
 *
 * Created by the owner, or by Anya on the owner's behalf
 * (anyaToolRegistry: owner.create_announcement).
 */
import express from 'express'
import { requireAuthenticatedUser, getAccessibleProfileIds } from '../utils/accessControl.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:announcements')
const router = express.Router()

router.get('/announcements/pending', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const userId = String(user.userId || user.id || user.email || '')
  try {
    let profileIds = []
    try { profileIds = (await getAccessibleProfileIds(req.db, user)) || [] } catch { profileIds = [] }
    const audienceVals = ['all', ...profileIds.map(String)]
    const audiencePh = audienceVals.map(() => '?').join(', ')
    const activePredicate = req.db?.dialect === 'postgres' ? 'active IS TRUE' : 'active = 1'
    const rows = await req.db.prepare(
      `SELECT id, title, body, type, created_at
         FROM announcements
        WHERE ${activePredicate}
          AND (starts_at IS NULL OR starts_at <= CURRENT_TIMESTAMP)
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
          AND audience IN (${audiencePh})
          AND id NOT IN (SELECT announcement_id FROM announcement_dismissals WHERE user_id = ?)
        ORDER BY created_at DESC
        LIMIT 5`,
    ).all(...audienceVals, userId)
    return res.json({ announcements: rows || [] })
  } catch (err) {
    log.warn('announcements.pending_failed', { error: err?.message || String(err) })
    return res.json({ announcements: [] }) // never block app load on this
  }
})

router.post('/announcements/:id/dismiss', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const userId = String(user.userId || user.id || user.email || '')
  const announcementId = String(req.params.id || '').trim()
  if (!announcementId) return res.status(400).json({ error: 'announcement id required' })
  try {
    const isPg = req.db.dialect === 'postgres'
    const conflict = isPg ? 'ON CONFLICT (user_id, announcement_id) DO NOTHING' : 'ON CONFLICT(user_id, announcement_id) DO NOTHING'
    await req.db.prepare(
      `INSERT INTO announcement_dismissals (user_id, announcement_id) VALUES (?, ?) ${conflict}`,
    ).run(userId, announcementId)
    return res.json({ ok: true })
  } catch (err) {
    log.warn('announcements.dismiss_failed', { error: err?.message || String(err) })
    return res.status(200).json({ ok: false })
  }
})

export default router
