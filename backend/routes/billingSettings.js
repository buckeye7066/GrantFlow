import express from 'express'
import crypto from 'crypto'
import { requireAuthenticatedUser, getAuthUserId } from '../utils/accessControl.js'

const router = express.Router()

function safeJsonParse(value, fallback) {
  try {
    if (!value) return fallback
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function safeJsonStringify(value, fallback = '{}') {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return fallback
  }
}

function mapRow(row) {
  if (!row) return null
  const custom = safeJsonParse(row.custom_preferences, {})
  const billing = (custom && typeof custom === 'object' ? custom.billing_settings : null) || {}
  return { id: row.id, ...billing }
}

async function loadUserPreferencesRow(db, userId) {
  if (!db) throw new Error('Database not available')
  return await db.prepare('SELECT * FROM user_preferences WHERE user_id = ? LIMIT 1').get(String(userId))
}

router.get('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const userId = getAuthUserId(user)
  if (!userId) return res.status(401).json({ error: 'Authentication required' })

  try {
    const row = await loadUserPreferencesRow(req.db, userId)
    if (!row) return res.json({})
    return res.json(mapRow(row))
  } catch (error) {
    console.error('[billing-settings] list error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.get('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const userId = getAuthUserId(user)
  if (!userId) return res.status(401).json({ error: 'Authentication required' })

  try {
    const row = await loadUserPreferencesRow(req.db, userId)
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (String(row.id) !== String(req.params.id)) return res.status(404).json({ error: 'Not found' })
    return res.json(mapRow(row))
  } catch (error) {
    console.error('[billing-settings] get error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.post('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const userId = getAuthUserId(user)
  if (!userId) return res.status(401).json({ error: 'Authentication required' })

  try {
    if (!req.db) throw new Error('Database not available')
    const existing = await loadUserPreferencesRow(req.db, userId)
    const incoming = req.body ?? {}

    const baseCustom = existing ? safeJsonParse(existing.custom_preferences, {}) : {}
    const nextCustom = { ...(baseCustom && typeof baseCustom === 'object' ? baseCustom : {}), billing_settings: incoming }
    const nextCustomJson = safeJsonStringify(nextCustom)

    if (existing) {
      await req.db
        .prepare(
          `
            UPDATE user_preferences
            SET updated_at = CURRENT_TIMESTAMP,
                custom_preferences = ?
            WHERE id = ?
          `,
        )
        .run(nextCustomJson, String(existing.id))

      const row = await loadUserPreferencesRow(req.db, userId)
      return res.json(mapRow(row))
    }

    const id = crypto.randomUUID()
    await req.db
      .prepare(
        `
          INSERT INTO user_preferences (
            id, user_id, custom_preferences
          ) VALUES (?, ?, ?)
        `,
      )
      .run(id, String(userId), nextCustomJson)

    const row = await loadUserPreferencesRow(req.db, userId)
    return res.status(201).json(mapRow(row))
  } catch (error) {
    console.error('[billing-settings] create error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.put('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const userId = getAuthUserId(user)
  if (!userId) return res.status(401).json({ error: 'Authentication required' })

  try {
    if (!req.db) throw new Error('Database not available')
    const existing = await loadUserPreferencesRow(req.db, userId)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    if (String(existing.id) !== String(req.params.id)) return res.status(404).json({ error: 'Not found' })

    const incoming = req.body ?? {}
    const baseCustom = safeJsonParse(existing.custom_preferences, {})
    const nextCustom = { ...(baseCustom && typeof baseCustom === 'object' ? baseCustom : {}), billing_settings: incoming }
    const nextCustomJson = safeJsonStringify(nextCustom)

    await req.db
      .prepare(
        `
          UPDATE user_preferences
          SET updated_at = CURRENT_TIMESTAMP,
              custom_preferences = ?
          WHERE id = ?
        `,
      )
      .run(nextCustomJson, String(existing.id))

    const row = await loadUserPreferencesRow(req.db, userId)
    return res.json(mapRow(row))
  } catch (error) {
    console.error('[billing-settings] update error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

export default router

