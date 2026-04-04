/**
 * Notifications API
 *
 * GET  /api/notifications          — unread notifications for authenticated user (last 50)
 * POST /api/notifications/:id/read — mark a single notification as read
 * POST /api/notifications/read-all — mark all notifications as read
 */

import { Router } from 'express'
import { requireAuthenticatedUser } from '../utils/accessControl.js'

const router = Router()

/**
 * GET /api/notifications
 * Returns the 50 most recent unread notifications for the authenticated user.
 */
router.get('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const userId = user.userId
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    const db = req.db

    // Ensure the table exists before querying (idempotent guard for fresh DBs).
    try {
      await db.prepare('SELECT 1 FROM notifications LIMIT 1').get()
    } catch {
      return res.json({ notifications: [], unreadCount: 0 })
    }

    const rows = await db
      .prepare(
        `SELECT id, type, title, message, data, read, created_at, expires_at
         FROM notifications
         WHERE user_id = ?
           AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
         ORDER BY created_at DESC
         LIMIT 50`,
      )
      .all(userId)

    const unreadCount = rows.filter((r) => !r.read).length

    const notifications = rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      message: r.message,
      data: (() => {
        try {
          return r.data ? JSON.parse(r.data) : null
        } catch {
          return null
        }
      })(),
      read: Boolean(r.read),
      createdAt: r.created_at,
      expiresAt: r.expires_at ?? null,
    }))

    return res.json({ notifications, unreadCount })
  } catch (error) {
    console.error('[notifications] GET / error:', error?.message || error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/notifications/:id/read
 * Mark a single notification as read.
 */
router.post('/:id/read', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const userId = user.userId
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: 'Notification ID required' })
    }

    const db = req.db

    try {
      await db.prepare('SELECT 1 FROM notifications LIMIT 1').get()
    } catch {
      return res.status(404).json({ error: 'Notification not found' })
    }

    const result = await db
      .prepare(
        `UPDATE notifications
         SET read = 1
         WHERE id = ? AND user_id = ?`,
      )
      .run(id, userId)

    const changed = Number(result?.changes ?? result?.rowCount ?? 0)
    if (changed === 0) {
      return res.status(404).json({ error: 'Notification not found' })
    }

    return res.json({ ok: true })
  } catch (error) {
    console.error('[notifications] POST /:id/read error:', error?.message || error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/notifications/read-all
 * Mark all notifications for the authenticated user as read.
 */
router.post('/read-all', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const userId = user.userId
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    const db = req.db

    try {
      await db.prepare('SELECT 1 FROM notifications LIMIT 1').get()
    } catch {
      return res.json({ ok: true, updated: 0 })
    }

    const result = await db
      .prepare(
        `UPDATE notifications
         SET read = 1
         WHERE user_id = ? AND read = 0`,
      )
      .run(userId)

    const updated = Number(result?.changes ?? result?.rowCount ?? 0)
    return res.json({ ok: true, updated })
  } catch (error) {
    console.error('[notifications] POST /read-all error:', error?.message || error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
