import express from 'express'
import { validatePagination } from '../utils/validation.js'
import { requireAuthenticatedUser } from '../utils/accessControl.js'
import { sanitizeLogValue } from '../utils/logger.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:programs')

const router = express.Router()

// Require authentication for all program routes
router.use((req, res, next) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  return next()
})

// Add database middleware
router.use((req, res, next) => {
  if (!req.db) {
    return res.status(500).json({ error: 'Database not available' })
  }
  next()
})

function normalizeTrack(track) {
  if (!track) return null
  const t = String(track).trim().toLowerCase()
  if (t === 'client' || t === 'a' || t === 'beneficiary') return 'CLIENT'
  if (t === 'provider' || t === 'b' || t === 'caregiver') return 'PROVIDER'
  // Unrecognised but non-empty track: log so operators can detect bad callers
  // CodeQL js/log-injection (#590): raw query/route param logged on the
  // branch where it just failed the recognized-track check.
  console.warn('[programs] normalizeTrack: unrecognised track value:', sanitizeLogValue(track))
  return null
}

function tableForTrack(track) {
  if (track === 'PROVIDER') return 'programs_provider'
  if (track === 'CLIENT') return 'programs_client'
  throw new Error(`tableForTrack: unexpected track value: ${track}`)
}

function buildFilters({ search, jurisdiction, state, county, isActive, dialect }) {
  const where = []
  const params = []

  if (typeof isActive === 'string') {
    const v = isActive.trim().toLowerCase()
    if (v === 'true' || v === '1') {
      where.push('is_active = ?')
      params.push(1)
    } else if (v === 'false' || v === '0') {
      where.push('is_active = ?')
      params.push(0)
    }
  }

  if (jurisdiction) {
    where.push('jurisdiction = ?')
    params.push(jurisdiction)
  }

  if (state) {
    where.push('state = ?')
    params.push(state.toUpperCase())
  }

  if (county) {
    where.push('county = ?')
    params.push(county)
  }

  if (search) {
    const term = `%${search}%`
    where.push(
      '(program_name LIKE ? OR administering_agency LIKE ? OR covered_services LIKE ? OR eligible_population LIKE ?)',
    )
    params.push(term, term, term, term)
  }

  return {
    clause: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
  }
}

router.get('/', async (req, res) => {
  try {
    const track = normalizeTrack(req.query.track)
    const { limit, offset } = validatePagination(req.query)
    const search = typeof req.query.search === 'string' ? req.query.search : null
    const jurisdiction =
      typeof req.query.jurisdiction === 'string' ? req.query.jurisdiction : null
    const state = typeof req.query.state === 'string' ? req.query.state : null
    const county = typeof req.query.county === 'string' ? req.query.county : null
    const isActive = typeof req.query.is_active === 'string' ? req.query.is_active : null

    const fetchTrack = async (t) => {
      const table = tableForTrack(t)
      const { clause, params } = buildFilters({ search, jurisdiction, state, county, isActive, dialect: req.db?.dialect || 'sqlite' })
      const rows = await req.db
        .prepare(
          `
            SELECT *
            FROM ${table}
            ${clause}
            ORDER BY last_verified DESC, updated_at DESC
            LIMIT ?
            OFFSET ?
          `,
        )
        .all(...params, limit, offset)
      const countParams = [...params]
      const total = (await req.db
        .prepare(
          `
            SELECT COUNT(*) AS total
            FROM ${table}
            ${clause}
          `,
        )
        .get(...countParams))?.total
      return { data: rows, total: total ?? rows.length }
    }

    if (track) {
      const result = await fetchTrack(track)
      return res.json({ track, ...result, limit, offset })
    }

    // Never merge tracks: return separate payloads.
    const client = await fetchTrack('CLIENT')
    const provider = await fetchTrack('PROVIDER')
    return res.json({ client, provider, limit, offset })
  } catch (error) {
    routeLogger.error('[programs] list error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/changes', async (req, res) => {
  try {
    const track = normalizeTrack(req.query.track)
    const { limit, offset } = validatePagination(req.query)

    const where = []
    const params = []
    if (track) {
      where.push('funding_track = ?')
      params.push(track)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const rows = await req.db
      .prepare(
        `
          SELECT *
          FROM program_change_events
          ${clause}
          ORDER BY created_at DESC
          LIMIT ?
          OFFSET ?
        `,
      )
      .all(...params, limit, offset)

    const total = (await req.db
      .prepare(
        `
          SELECT COUNT(*) AS total
          FROM program_change_events
          ${clause}
        `,
      )
      .get(...params))?.total

    return res.json({ track: track ?? 'ALL', data: rows, total: total ?? rows.length, limit, offset })
  } catch (error) {
    routeLogger.error('[programs] changes error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:track/:programId', async (req, res) => {
  try {
    const track = normalizeTrack(req.params.track)
    if (!track) return res.status(400).json({ error: 'Invalid track (client/provider)' })

    const programId = req.params.programId
    const table = tableForTrack(track)

    const program = await req.db.prepare(`SELECT * FROM ${table} WHERE program_id = ?`).get(programId)
    if (!program) return res.status(404).json({ error: 'Program not found' })

    const versions = await req.db
      .prepare(
        `
          SELECT id, created_at, fetched_at, http_status, content_type, content_hash, change_type, changed_fields, change_summary
          FROM program_versions
          WHERE funding_track = ? AND program_id = ?
          ORDER BY created_at DESC
          LIMIT 25
        `,
      )
      .all(track, programId)

    const events = await req.db
      .prepare(
        `
          SELECT *
          FROM program_change_events
          WHERE funding_track = ? AND program_id = ?
          ORDER BY created_at DESC
          LIMIT 50
        `,
      )
      .all(track, programId)

    return res.json({ track, program, versions, events })
  } catch (error) {
    routeLogger.error('[programs] detail error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

