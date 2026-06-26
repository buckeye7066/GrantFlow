import express from 'express'
import crypto from 'crypto'
import { formatError } from '../middleware/errorHandler.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:grantMonitoring')

const router = express.Router()
function isAdmin(req, res) {
  if (!req.ctx?.userId) {
    res.status(401).json({ error: 'Authentication required' })
    return false
  }
  if (!req.ctx?.isAdmin) {
    res.status(403).json({ error: 'Access denied' })
    return false
  }
  return true
}

async function ensureDefaults(db) {
  // Ensure default alert configs exist for all organizations.
  const orgs = await db.prepare('SELECT id FROM organizations').all()
  // Statements are prepared inside withTransaction below to stay within the same connection/tx scope.

  const defaults = [
    { alert_type: 'deadline_approaching', enabled: true, threshold_days: 14 },
    { alert_type: 'status_change', enabled: true, threshold_days: null },
    { alert_type: 'new_match', enabled: true, threshold_days: null },
    { alert_type: 'milestone_due', enabled: true, threshold_days: 14 },
  ]

  await db.withTransaction(async (tx) => {
    const insertTx = tx.prepare(`
      INSERT INTO grant_monitoring_alerts (id, organization_id, alert_type, enabled, threshold_days, notification_methods)
      VALUES (@id, @organization_id, @alert_type, @enabled, @threshold_days, @notification_methods)
    `)
    const existsTx = tx.prepare(
      'SELECT 1 FROM grant_monitoring_alerts WHERE organization_id = ? AND alert_type = ? LIMIT 1',
    )

    for (const org of orgs) {
      for (const def of defaults) {
        const already = await existsTx.get(org.id, def.alert_type)
        if (already) continue
        await insertTx.run({
          id: crypto.randomUUID(),
          organization_id: org.id,
          alert_type: def.alert_type,
          enabled: Boolean(def.enabled),
          threshold_days: def.threshold_days,
          notification_methods: JSON.stringify(['in_app']),
        })
      }
    }
  })
}

router.get('/alerts', async (req, res) => {
  if (!isAdmin(req, res)) return
  try {
    await ensureDefaults(req.db)
    const { organization_id } = req.query
    const rows = organization_id
      ? await req.db
          .prepare(
            `
              SELECT *
              FROM grant_monitoring_alerts
              WHERE organization_id = ?
              ORDER BY alert_type ASC
            `,
          )
          .all(String(organization_id))
      : await req.db
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
    routeLogger.error('[grant-monitoring/alerts] Error:', error)
    res.status(500).json(formatError(error))
  }
})

router.get('/logs', async (req, res) => {
  if (!isAdmin(req, res)) return
  try {
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit ?? 100, 10)))
    const { organization_id } = req.query

    const rows = organization_id
      ? await req.db
          .prepare(
            `
              SELECT *
              FROM grant_monitoring_logs
              WHERE organization_id = ?
              ORDER BY created_date DESC
              LIMIT ?
            `,
          )
          .all(String(organization_id), limit)
      : await req.db
          .prepare(
            `
              SELECT *
              FROM grant_monitoring_logs
              ORDER BY created_date DESC
              LIMIT ?
            `,
          )
          .all(limit)

    res.json(rows)
  } catch (error) {
    routeLogger.error('[grant-monitoring/logs] Error:', error)
    res.status(500).json(formatError(error))
  }
})

router.put('/logs/:id', async (req, res) => {
  if (!isAdmin(req, res)) return
  try {
    const id = req.params.id
    const acknowledged = Boolean(req.body?.acknowledged)
    const rawAcknowledgedAt = req.body?.acknowledged_at
    const parsedAt = rawAcknowledgedAt ? new Date(rawAcknowledgedAt) : null
    const acknowledgedAt = (parsedAt && !Number.isNaN(parsedAt.getTime()))
      ? parsedAt.toISOString()
      : new Date().toISOString()

    const existing = await req.db.prepare('SELECT id FROM grant_monitoring_logs WHERE id = ?').get(id)
    if (!existing) {
      return res.status(404).json({ error: 'Monitoring event not found' })
    }

    await req.db
      .prepare(
        `
          UPDATE grant_monitoring_logs
          SET acknowledged = ?, acknowledged_at = ?, updated_date = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
      )
      .run(acknowledged, acknowledged ? acknowledgedAt : null, id)

    const updated = await req.db.prepare('SELECT * FROM grant_monitoring_logs WHERE id = ?').get(id)
    res.json(updated)
  } catch (error) {
    routeLogger.error('[grant-monitoring/logs/:id] Error:', error)
    res.status(500).json(formatError(error))
  }
})

router.post('/check', async (req, res) => {
  if (!isAdmin(req, res)) return
  try {
    await ensureDefaults(req.db)

    const orgId = req.body?.organization_id ?? null
    const orgFilter = orgId ? ' AND organization_id = ?' : ''
    const params = orgId ? [String(orgId)] : []

    const statusPlaceholders = "('discovered','interested','drafting','app_prep','revision')"
    const grants = await req.db
      .prepare(
        `
          SELECT id, organization_id, title, status, deadline, match_score
          FROM grants
          WHERE status IN ${statusPlaceholders}
            AND deadline IS NOT NULL
          ${orgFilter}
        `,
      )
      .all(...params)

    const now = new Date()

    // Avoid spamming duplicate events: if the same (grant_id,event_type) exists in last 24h, skip.
    const since1dPredicate =
      req.db?.dialect === 'postgres'
        ? "created_date >= (NOW() - INTERVAL '1 day')"
        : "datetime(created_date) >= datetime('now', '-1 day')"

    let eventsLogged = 0

    await req.db.withTransaction(async (tx) => {
      // Omit acknowledged / acknowledged_at so the DB defaults apply
      // (acknowledged=FALSE, acknowledged_at=NULL). Inserting a literal `0` for
      // the BOOLEAN `acknowledged` column 500s on Postgres ("column is of type
      // boolean but expression is of type integer") while SQLite silently
      // accepts it — that mismatch was the production /check 500.
      const insertTx = tx.prepare(
        `
          INSERT INTO grant_monitoring_logs (
            id, organization_id, grant_id, event_type, severity, event_data
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      const seenRecentTx = tx.prepare(
        `
          SELECT 1
          FROM grant_monitoring_logs
          WHERE grant_id = ? AND event_type = ?
            AND ${since1dPredicate}
          LIMIT 1
        `,
      )

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
          // Respect per-org alert config: skip if the org has disabled this alert type.
          const alertCfg = await tx
            .prepare(
              `SELECT enabled FROM grant_monitoring_alerts
               WHERE organization_id = ? AND alert_type = ? LIMIT 1`,
            )
            .get(grant.organization_id, eventType)
          if (alertCfg && !alertCfg.enabled) continue
          const alreadySeen = await seenRecentTx.get(grant.id, eventType)
          if (!alreadySeen) {
            const severity = daysUntil <= 7 ? 'critical' : 'high'
            await insertTx.run(
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
      }
    })

    res.json({
      success: true,
      alerts_sent: 0,
      events_logged: eventsLogged,
      organization_id: orgId,
    })
  } catch (error) {
    routeLogger.error('[grant-monitoring/check] Error:', error)
    res.status(500).json(formatError(error))
  }
})

export default router

