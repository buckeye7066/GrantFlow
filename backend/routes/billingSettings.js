import express from 'express'
import crypto from 'crypto'
import { requireAuthenticatedUser, getAuthUserId } from '../utils/accessControl.js'
import { createOrgScopedRecordsRouter } from './orgScopedRecords.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:billingSettings')

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

// Consultant workspace entities share this already-mounted /api/billing-settings
// router so server.js does not need a new top-level mount. Register these BEFORE
// /:id so "invoices" is never treated as a settings id.
router.use('/invoices', createOrgScopedRecordsRouter('invoices'))
router.use('/invoice-lines', createOrgScopedRecordsRouter('invoice-lines'))
router.use('/projects', createOrgScopedRecordsRouter('projects'))
router.use('/time-entries', createOrgScopedRecordsRouter('time-entries'))
router.use('/time-logs', createOrgScopedRecordsRouter('time-logs'))

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
    routeLogger.error('[billing-settings] list error:', error)
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
    routeLogger.error('[billing-settings] get error:', error)
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
    const insertResult = await req.db
      .prepare(
        `
          INSERT INTO user_preferences (
            id, user_id, custom_preferences
          ) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO NOTHING
        `,
      )
      .run(id, String(userId), nextCustomJson)
    const inserted = Number(insertResult?.changes ?? 0) > 0

    if (!inserted) {
      const latest = await loadUserPreferencesRow(req.db, userId)
      const latestCustom = safeJsonParse(latest?.custom_preferences, {})
      const mergedCustom = {
        ...(latestCustom && typeof latestCustom === 'object' ? latestCustom : {}),
        billing_settings: incoming,
      }
      await req.db
        .prepare(
          `
            UPDATE user_preferences
            SET updated_at = CURRENT_TIMESTAMP,
                custom_preferences = ?
            WHERE user_id = ?
          `,
        )
        .run(safeJsonStringify(mergedCustom), String(userId))
    }

    const row = await loadUserPreferencesRow(req.db, userId)
    return res.status(inserted ? 201 : 200).json(mapRow(row))
  } catch (error) {
    routeLogger.error('[billing-settings] create error:', error)
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
    routeLogger.error('[billing-settings] update error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

export default router
