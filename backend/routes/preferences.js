import express from 'express'
import crypto from 'crypto'
import ensureUserPreferencesTable from '../utils/ensureUserPreferencesTable.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:preferences')

const router = express.Router()

const DEFAULT_PREFERENCES = {
  sidebar_position: 'left',
  sidebar_collapsed: false,
  dashboard_layout: 'grid',
  card_density: 'comfortable',
  table_row_density: 'medium',
  theme: 'system',
  accent_color: 'blue',
  sidebar_color_scheme: 'default',
  high_contrast: false,
  default_landing_page: '/Dashboard',
  items_per_page: 25,
  date_format: 'MM/DD/YYYY',
  currency_display: 'USD',
  timezone: 'America/New_York',
  email_notifications: true,
  grant_deadline_reminder_days: 7,
  weekly_digest: true,
  browser_notifications: false,
  font_size: 'medium',
  reduce_motion: false,
  screen_reader_optimized: false,
  custom_preferences: {},
}

function mapPreferencesRow(row) {
  if (!row) return null
  
  let customPreferences = {}
  if (row.custom_preferences) {
    if (typeof row.custom_preferences === 'string') {
      try {
        customPreferences = JSON.parse(row.custom_preferences)
      } catch {
        customPreferences = {}
      }
    } else {
      customPreferences = row.custom_preferences
    }
  }
  
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    user_id: row.user_id,
    sidebar_position: row.sidebar_position,
    sidebar_collapsed: Boolean(row.sidebar_collapsed),
    dashboard_layout: row.dashboard_layout,
    card_density: row.card_density,
    table_row_density: row.table_row_density,
    theme: row.theme,
    accent_color: row.accent_color,
    sidebar_color_scheme: row.sidebar_color_scheme,
    high_contrast: Boolean(row.high_contrast),
    default_landing_page: row.default_landing_page,
    items_per_page: row.items_per_page,
    date_format: row.date_format,
    currency_display: row.currency_display,
    timezone: row.timezone,
    email_notifications: Boolean(row.email_notifications),
    grant_deadline_reminder_days: row.grant_deadline_reminder_days,
    weekly_digest: Boolean(row.weekly_digest),
    browser_notifications: Boolean(row.browser_notifications),
    font_size: row.font_size,
    reduce_motion: Boolean(row.reduce_motion),
    screen_reader_optimized: Boolean(row.screen_reader_optimized),
    custom_preferences: customPreferences,
  }
}

async function ensurePreferencesRow(db, dialect, userId, customPreferences = {}) {
  const id = crypto.randomUUID()
  const customJson = JSON.stringify(customPreferences || {})
  const sql =
    dialect === 'postgres'
      ? `
          INSERT INTO user_preferences (id, user_id, custom_preferences)
          VALUES (?, ?, ?::jsonb)
          ON CONFLICT(user_id) DO NOTHING
        `
      : `
          INSERT INTO user_preferences (id, user_id, custom_preferences)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO NOTHING
        `
  await db.prepare(sql).run(id, userId, customJson)
  return db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId)
}

// Get user preferences (or create with defaults if not exists)
router.get('/', async (req, res) => {
  const userId = req.ctx?.userId ?? null
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  
  try {
    await ensureUserPreferencesTable(req.db)
    const dialect = req.db?.dialect || 'sqlite'

    let preferences = await req.db
      .prepare('SELECT * FROM user_preferences WHERE user_id = ?')
      .get(userId)
    
    if (!preferences) {
      // Create default preferences for user (rollout: Anya copilot ON, screenshot OFF)
      // Initialize custom preferences with feature flags and incognito toggle.
      // `anya_match_scout_muted` defaults to false so new users get the
      // recommend-only popup. They can mute it from Settings; the scout
      // service reads this flag before creating any suggestion/notification.
      const defaultCustom = {
        feature_flags: { anyaCopilotEnabled: true, anyaScreenshotEnabled: false },
        incognitoEnabled: false,
        anya_match_scout_muted: false,
      }
      preferences = await ensurePreferencesRow(req.db, dialect, userId, defaultCustom)
    } else {
      let custom = preferences.custom_preferences
      if (typeof custom === 'string') {
        try { custom = JSON.parse(custom) } catch { custom = {} }
      }
      if (!custom || typeof custom.feature_flags !== 'object') {
        // Ensure feature flags and incognitoEnabled exist in custom preferences
        const updatedCustom = {
          ...(custom || {}),
          feature_flags: { anyaCopilotEnabled: true, anyaScreenshotEnabled: false },
          incognitoEnabled: false,
        }
        const updateSql =
          dialect === 'postgres'
            ? 'UPDATE user_preferences SET custom_preferences = ?::jsonb, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
            : 'UPDATE user_preferences SET custom_preferences = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
        await req.db.prepare(updateSql).run(JSON.stringify(updatedCustom), userId)
        preferences = await req.db
          .prepare('SELECT * FROM user_preferences WHERE user_id = ?')
          .get(userId)
      } else if (custom.incognitoEnabled === undefined) {
        // If custom preferences exist but incognitoEnabled is missing, set it to false
        const updatedCustom = { ...custom, incognitoEnabled: false }
        const updateSql =
          dialect === 'postgres'
            ? 'UPDATE user_preferences SET custom_preferences = ?::jsonb, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
            : 'UPDATE user_preferences SET custom_preferences = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
        await req.db.prepare(updateSql).run(JSON.stringify(updatedCustom), userId)
        preferences = await req.db
          .prepare('SELECT * FROM user_preferences WHERE user_id = ?')
          .get(userId)
      }
    }

    res.json(mapPreferencesRow(preferences))
  } catch (error) {
    routeLogger.error('[preferences] Error fetching preferences:', error)
    res.status(500).json({ error: 'Failed to fetch preferences' })
  }
})

// Update user preferences
router.put('/', async (req, res) => {
  const userId = req.ctx?.userId ?? null
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  
  try {
    await ensureUserPreferencesTable(req.db)
    const dialect = req.db?.dialect || 'sqlite'

    // Ensure row exists before update.
    let existing = await req.db.prepare('SELECT id FROM user_preferences WHERE user_id = ?').get(userId)
    if (!existing?.id) {
      await ensurePreferencesRow(req.db, dialect, userId, {})
      existing = await req.db.prepare('SELECT id FROM user_preferences WHERE user_id = ?').get(userId)
    }

    const updates = []
    const values = []
    const allowedFields = Object.keys(DEFAULT_PREFERENCES)

    // Merge custom_preferences with existing instead of replacing (preserves lastVisitedPath, incognitoEnabled, etc.)
    if (req.body.custom_preferences !== undefined) {
      const existingRow = await req.db.prepare('SELECT custom_preferences FROM user_preferences WHERE user_id = ?').get(userId)
      let existingCustom = {}
      if (existingRow?.custom_preferences) {
        try {
          existingCustom = typeof existingRow.custom_preferences === 'string'
            ? JSON.parse(existingRow.custom_preferences)
            : existingRow.custom_preferences
        } catch {
          existingCustom = {}
        }
      }
      const incoming = typeof req.body.custom_preferences === 'object' ? req.body.custom_preferences : {}
      const merged = { ...existingCustom, ...incoming }
      updates.push(dialect === 'postgres' ? 'custom_preferences = ?::jsonb' : 'custom_preferences = ?')
      values.push(JSON.stringify(merged))
    }
    
    Object.entries(req.body).forEach(([key, value]) => {
      if (key === 'custom_preferences') return // already handled above
      if (allowedFields.includes(key) && value !== undefined) {
        if (typeof value === 'boolean') {
          updates.push(`${key} = ?`)
          values.push(Boolean(value))
        } else {
          updates.push(`${key} = ?`)
          values.push(value)
        }
      }
    })
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid preferences to update' })
    }
    
    values.push(userId)
    
    await req.db.prepare(`
      UPDATE user_preferences 
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(...values)
    
    const updated = await req.db
      .prepare('SELECT * FROM user_preferences WHERE user_id = ?')
      .get(userId)
    
    res.json(mapPreferencesRow(updated))
  } catch (error) {
    routeLogger.error('[preferences] Error updating preferences:', error)
    res.status(500).json({ error: 'Failed to update preferences' })
  }
})

// Reset preferences to defaults
router.post('/reset', async (req, res) => {
  const userId = req.ctx?.userId ?? null
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  
  try {
    await ensureUserPreferencesTable(req.db)
    const dialect = req.db?.dialect || 'sqlite'

    await req.db.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(userId)

    const preferences = await ensurePreferencesRow(req.db, dialect, userId, {})
    
    res.json(mapPreferencesRow(preferences))
  } catch (error) {
    routeLogger.error('[preferences] Error resetting preferences:', error)
    res.status(500).json({ error: 'Failed to reset preferences' })
  }
})

export default router
