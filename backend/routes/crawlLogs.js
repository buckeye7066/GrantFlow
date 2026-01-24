import express from 'express'
import { requireAuthenticatedUser } from '../utils/accessControl.js'

const router = express.Router()

function mapStatus(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'success') return 'completed'
  if (s === 'error') return 'failed'
  if (s === 'started') return 'running'
  if (s === 'partial') return 'completed'
  return s || 'unknown'
}

function mapRow(row) {
  if (!row) return null
  return {
    id: row.id,
    source: row.source,
    status: mapStatus(row.status),
    created_date: row.created_at ?? row.created_date ?? null,
    recordsFound: Number(row.records_found || 0),
    recordsAdded: Number(row.records_imported || 0),
    recordsUpdated: Number(row.records_updated || 0),
    durationMs: row.duration_ms ?? null,
    errorMessage: row.error_message ?? null,
    metadata: row.metadata ?? null,
  }
}

router.get('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const limit = Math.max(1, Math.min(Number(req.query?.limit) || 50, 500))
    const rows = await req.db
      .prepare(
        `
          SELECT *
          FROM crawl_logs
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(limit)
    return res.json((rows || []).map(mapRow))
  } catch (error) {
    console.error('[crawl-logs] list error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.post('/filter', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const filter = req.body ?? {}
    const clauses = []
    const params = []

    if (filter.source) {
      clauses.push('source = ?')
      params.push(String(filter.source))
    }

    if (filter.status) {
      // Accept UI-style values and map back to DB values.
      const s = String(filter.status).toLowerCase()
      if (s === 'completed') {
        clauses.push("status IN ('success','partial')")
      } else if (s === 'failed') {
        clauses.push("status = 'error'")
      } else if (s === 'running') {
        clauses.push("status = 'started'")
      } else {
        clauses.push('status = ?')
        params.push(String(filter.status))
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await req.db
      .prepare(
        `
          SELECT *
          FROM crawl_logs
          ${where}
          ORDER BY created_at DESC
          LIMIT 200
        `,
      )
      .all(...params)

    return res.json((rows || []).map(mapRow))
  } catch (error) {
    console.error('[crawl-logs] filter error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

export default router

