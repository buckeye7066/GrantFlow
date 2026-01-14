import express from 'express'
import { validatePagination } from '../utils/validation.js'

const router = express.Router()

function normalizeTrack(track) {
  if (!track) return null
  const t = String(track).trim().toLowerCase()
  if (t === 'client' || t === 'a' || t === 'beneficiary') return 'CLIENT'
  if (t === 'provider' || t === 'b' || t === 'caregiver') return 'PROVIDER'
  if (t === 'CLIENT') return 'CLIENT'
  if (t === 'PROVIDER') return 'PROVIDER'
  return null
}

function tableForTrack(track) {
  return track === 'PROVIDER' ? 'programs_provider' : 'programs_client'
}

function buildFilters({ search, jurisdiction, state, county, isActive }) {
  const where = []
  const params = []

  if (typeof isActive === 'string') {
    const v = isActive.trim().toLowerCase()
    if (v === 'true' || v === '1') where.push(req.db?.dialect === 'postgres' ? 'is_active = TRUE' : 'is_active = 1')
    if (v === 'false' || v === '0') where.push('is_active = 0')
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

router.get('/', (req, res) => {
  try {
    const track = normalizeTrack(req.query.track)
    const { limit, offset } = validatePagination(req.query)
    const search = typeof req.query.search === 'string' ? req.query.search : null
    const jurisdiction =
      typeof req.query.jurisdiction === 'string' ? req.query.jurisdiction : null
    const state = typeof req.query.state === 'string' ? req.query.state : null
    const county = typeof req.query.county === 'string' ? req.query.county : null
    const isActive = typeof req.query.is_active === 'string' ? req.query.is_active : null

    const fetchTrack = (t) => {
      const table = tableForTrack(t)
      const { clause, params } = buildFilters({ search, jurisdiction, state, county, isActive })
      const rows = req.db
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
      const total = req.db
        .prepare(
          `
            SELECT COUNT(*) AS total
            FROM ${table}
            ${clause}
          `,
        )
        .get(...params)?.total
      return { data: rows, total: total ?? rows.length }
    }

    if (track) {
      const result = fetchTrack(track)
      return res.json({ track, ...result, limit, offset })
    }

    // Never merge tracks: return separate payloads.
    const client = fetchTrack('CLIENT')
    const provider = fetchTrack('PROVIDER')
    return res.json({ client, provider, limit, offset })
  } catch (error) {
    console.error('[programs] list error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/changes', (req, res) => {
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

    const rows = req.db
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

    const total = req.db
      .prepare(
        `
          SELECT COUNT(*) AS total
          FROM program_change_events
          ${clause}
        `,
      )
      .get(...params)?.total

    return res.json({ track: track ?? 'ALL', data: rows, total: total ?? rows.length, limit, offset })
  } catch (error) {
    console.error('[programs] changes error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:track/:programId', (req, res) => {
  try {
    const track = normalizeTrack(req.params.track)
    if (!track) return res.status(400).json({ error: 'Invalid track (client/provider)' })

    const programId = req.params.programId
    const table = tableForTrack(track)

    const program = req.db.prepare(`SELECT * FROM ${table} WHERE program_id = ?`).get(programId)
    if (!program) return res.status(404).json({ error: 'Program not found' })

    const versions = req.db
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

    const events = req.db
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
    console.error('[programs] detail error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

