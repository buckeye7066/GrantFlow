import express from 'express'
import ensureUserPreferencesTable from '../utils/ensureUserPreferencesTable.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:incognito')

const router = express.Router()

// Apply authentication middleware to all routes
router.use((req, res, next) => {
  if (!req.ctx?.userId) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  next()
})

// Simple health endpoint to verify Incognito module is enabled for the user.
router.get('/health', async (req, res) => {
  const userId = req.ctx.userId
  try {
    if (!req.db) {
      throw new Error('Database connection not available')
    }
    await ensureUserPreferencesTable(req.db)
    const row = await req.db
      .prepare('SELECT custom_preferences FROM user_preferences WHERE user_id = ?')
      .get(userId)
    let custom = row?.custom_preferences
    if (typeof custom === 'string') {
      try {
        custom = JSON.parse(custom)
      } catch (parseError) {
        console.warn('[incognito] Invalid JSON in custom_preferences:', parseError)
        custom = {}
      }
    }
    const enabled = Boolean(custom?.incognitoEnabled)
    if (!enabled) {
      return res.status(403).json({ error: 'Incognito module is disabled' })
    }
    return res.json({ status: 'ok' })
  } catch (error) {
    console.error('[incognito] Error checking health:', error)
    return res.status(500).json({ error: 'Failed to check Incognito status' })
  }
})

export default router
