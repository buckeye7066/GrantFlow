import express from 'express'
import crypto from 'crypto'
import { formatError } from '../middleware/errorHandler.js'

const router = express.Router()

function isAdminUser(user) {
  const userEmail = user?.primary_email || user?.email || ''
  return (
    Boolean(user?.is_admin) ||
    user?.role === 'admin' ||
    (userEmail && String(userEmail).toLowerCase().includes('buckeye7066'))
  )
}

function requireAdmin(req, res) {
  const user = req.user
  if (!user) {
    res.status(401).json({ error: 'Authentication required' })
    return false
  }
  if (!isAdminUser(user)) {
    res.status(403).json({ error: 'Access denied' })
    return false
  }
  return true
}

function ensureDefaults(db) {
  // Ensure default alert configs exist for all organizations.
  const orgs = db.prepare('SELECT id FROM organizations').all()
  const insert = db.prepare(`
    INSERT INTO grant_monitoring_alerts (id, organization_id, alert_type, enabled, threshold_days, notification_methods)
    VALUES (@id, @organization_id, @alert_type, @enabled, @threshold_days, @notification_methods)
  `)

  const exists = db.prepare(
    'SELECT 1 FROM grant_monitoring_alerts WHERE organization_id = ? AND alert_type = ? LIMIT 1',
  )

  const defaults = [
    { alert_type: 'deadline_approaching', enabled: 1, threshold_days: 14 },
    { alert_type: 'status_change', enabled: 1, threshold_days: null },
    { alert_type: 'new_match', enabled: 1, threshold_days: null },
    { alert_type: 'milestone_due', enabled: 1, threshold_days: 14 },
  ]

  const tx = db.transaction(() => {
    for (const org of orgs) {
      for (const def of defaults) {
        const already = exists.get(org.id, def.alert_type)
        if (already) continue
        insert.run({
          id: crypto.randomUUID(),
          organization_id: org.id,
          alert_type: def.alert_type,
          enabled: def.enabled,
          threshold_days: def.threshold_days,
          notification_methods: JSON.stringify(['in_app']),
        })
      }
    }
  })

  tx()
}

router.get('/alerts', (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    ensureDefaults(req.db)
    const { organization_id } = req.query
    const rows = organization_id
      ? req.db
          .prepare(
            `
              SELECT *
              FROM grant_monitoring_alerts
              WHERE organization_id = ?
              ORDER BY alert_type ASC
            `,
          )
          .all(String(organization_id))
      : req.db
          .prepare(
            `
              SELECT *
              FROM grant_monitoring_alerts
              ORDER BY organization_id ASC, alert_type ASC
            `,
          )
          .all()

    res.json(rows)
  } catch (error) {
    console.error('[grant-monitoring/alerts] Error:', error)
    res.status(500).json(formatError(error))
  }
})

router.get('/logs', (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit ?? 100, 10)))
    const { organization_id } = req.query

    const rows = organization_id
      ? req.db
          .prepare(
            `
              SELECT *
              FROM grant_monitoring_logs
              WHERE organization_id = ?
              ORDER BY datetime(created_date) DESC
              LIMIT ?
            `,
          )
          .all(String(organization_id), limit)
      : req.db
          .prepare(
            `
              SELECT *
              FROM grant_monitoring_logs
              ORDER BY datetime(created_date) DESC
              LIMIT ?
            `,
          )
          .all(limit)

    res.json(rows)
  } catch (error) {
    console.error('[grant-monitoring/logs] Error:', error)
    res.status(500).json(formatError(error))
  }
})

router.put('/logs/:id', (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const id = req.params.id
    const acknowledged = Boolean(req.body?.acknowledged)
    const acknowledgedAt = req.body?.acknowledged_at ?? new Date().toISOString()

    const existing = req.db.prepare('SELECT id FROM grant_monitoring_logs WHERE id = ?').get(id)
    if (!existing) {
      return res.status(404).json({ error: 'Monitoring event not found' })
    }

    req.db
      .prepare(
        `
          UPDATE grant_monitoring_logs
          SET acknowledged = ?, acknowledged_at = ?, updated_date = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
      )
      .run(acknowledged ? 1 : 0, acknowledged ? acknowledgedAt : null, id)

    const updated = req.db.prepare('SELECT * FROM grant_monitoring_logs WHERE id = ?').get(id)
    res.json(updated)
  } catch (error) {
    console.error('[grant-monitoring/logs/:id] Error:', error)
    res.status(500).json(formatError(error))
  }
})

router.post('/check', (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    ensureDefaults(req.db)

    const orgId = req.body?.organization_id ?? null
    const orgFilter = orgId ? ' AND organization_id = ?' : ''
    const params = orgId ? [String(orgId)] : []

    const grants = req.db
      .prepare(
        `
          SELECT id, organization_id, title, status, deadline, match_score
          FROM grants
          WHERE 1=1
          ${orgFilter}
        `,
      )
      .all(...params)

    const now = new Date()

    const insert = req.db.prepare(
      `
        INSERT INTO grant_monitoring_logs (
          id, organization_id, grant_id, event_type, severity, event_data, acknowledged, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
      `,
    )

    // Avoid spamming duplicate events: if the same (grant_id,event_type) exists in last 24h, skip.
    const seenRecent = req.db.prepare(
      `
        SELECT 1
        FROM grant_monitoring_logs
        WHERE grant_id = ? AND event_type = ?
          AND datetime(created_date) >= datetime('now', '-1 day')
        LIMIT 1
      `,
    )

    let eventsLogged = 0

    const tx = req.db.transaction(() => {
      for (const grant of grants) {
        if (!grant.deadline) continue
        const dl = new Date(grant.deadline)
        if (Number.isNaN(dl.getTime())) continue
        const daysUntil = Math.floor((dl.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        if (daysUntil < 0) continue

        // only track relevant active statuses
        const active = ['discovered', 'interested', 'drafting', 'app_prep', 'revision'].includes(grant.status)
        if (!active) continue

        if (daysUntil <= 14) {
          const eventType = 'deadline_approaching'
          if (seenRecent.get(grant.id, eventType)) continue
          const severity = daysUntil <= 7 ? 'critical' : 'high'
          insert.run(
            crypto.randomUUID(),
            grant.organization_id,
            grant.id,
            eventType,
            severity,
            JSON.stringify({
              grant_title: grant.title,
              deadline: grant.deadline,
              days_until: daysUntil,
              match_score: grant.match_score ?? null,
            }),
          )
          eventsLogged += 1
        }
      }
    })

    tx()

    res.json({
      success: true,
      alerts_sent: 0,
      events_logged: eventsLogged,
      organization_id: orgId,
    })
  } catch (error) {
    console.error('[grant-monitoring/check] Error:', error)
    res.status(500).json(formatError(error))
  }
})

export default router

