import express from 'express'

import { ensureAuth } from '../middleware/auth.js';

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:nfPrograms')

const router = express.Router();

router.use(ensureAuth);

function normalizeTrack(track) {
  if (!track) return null
  const t = String(track).trim().toUpperCase()
  if (t === 'TRACK_A' || t === 'A') return 'TRACK_A'
  if (t === 'TRACK_B' || t === 'B') return 'TRACK_B'
  return null
}

function tableForTrack(track) {
  return track === 'TRACK_B' ? 'nf_programs_b' : 'nf_programs_a'
}

function parseJson(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function decorate(row) {
  if (!row) return null
  return {
    ...row,
    eligible_population: parseJson(row.eligible_population, []),
    covered_services: parseJson(row.covered_services, []),
    income_limits: parseJson(row.income_limits, null),
    diagnosis_requirements: parseJson(row.diagnosis_requirements, null),
    age_requirements: parseJson(row.age_requirements, null),
    provider_requirements: parseJson(row.provider_requirements, null),
    funding_amounts: parseJson(row.funding_amounts, null),
    change_log: parseJson(row.change_log, []),
    raw_source_refs: parseJson(row.raw_source_refs, []),
  }
}

function buildFilters(query) {
  const where = []
  const params = []

  const jurisdiction = typeof query.jurisdiction === 'string' ? query.jurisdiction.trim().toLowerCase() : null
  const state = typeof query.state === 'string' ? query.state.trim().toUpperCase() : null
  const county = typeof query.county === 'string' ? query.county.trim() : null
  const programType = typeof query.program_type === 'string' ? query.program_type.trim().toLowerCase() : null
  const search = typeof query.search === 'string' ? query.search.trim() : null

  if (jurisdiction) {
    where.push('jurisdiction = ?')
    params.push(jurisdiction)
  }
  if (state) {
    where.push('state = ?')
    params.push(state)
  }
  if (county) {
    where.push('county = ?')
    params.push(county)
  }
  if (programType) {
    where.push('program_type = ?')
    params.push(programType)
  }
  if (search) {
    const term = `%${search}%`
    where.push(
      '(program_name LIKE ? OR administering_agency LIKE ? OR source_url LIKE ?)',
    )
    params.push(term, term, term)
  }

  // Basic eligible_population filter (JSON text contains)
  if (typeof query.eligible_population === 'string' && query.eligible_population.trim()) {
    where.push('eligible_population LIKE ?')
    params.push(`%${query.eligible_population.trim()}%`)
  }

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

router.get('/', async (req, res) => {
  try {
    const track = normalizeTrack(req.query.track)
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit ?? 50, 10) || 50))
    const offset = Math.max(0, Number.parseInt(req.query.offset ?? 0, 10) || 0)

    const fetchTrack = async (t) => {
      const table = tableForTrack(t)
      const { clause, params } = buildFilters(req.query)
      const ALLOWED_TABLES = new Set(['nf_programs_a', 'nf_programs_b'])
      if (!ALLOWED_TABLES.has(table)) throw new Error(`Invalid table name: ${table}`)

      const rows = await req.db
        .prepare(
          // NULLS LAST is explicit because the dialects disagree: Postgres
          // defaults to NULLS FIRST on DESC, SQLite puts NULLs last. Without it
          // the "freshest VERIFIED programs" list was headed in PROD by rows
          // that were NEVER verified, while every local/SQLite test showed the
          // intended order — provenance ordering must mean the same thing on
          // both dialects.
          `SELECT * FROM ${table} ${clause} ORDER BY last_verified DESC NULLS LAST, updated_at DESC NULLS LAST LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset)
      const total = (await req.db
        .prepare(
          `SELECT COUNT(*) AS total FROM ${table} ${clause}`,
        )
        .get(...params))?.total
      return { data: (rows || []).map(decorate), total: total ?? (rows || []).length }
    }

    if (track) {
      const result = await fetchTrack(track)
      return res.json({ track, ...result, limit, offset })
    }

    // Never merge: return separate arrays.
    return res.json({
      track_a: await fetchTrack('TRACK_A'),
      track_b: await fetchTrack('TRACK_B'),
      limit,
      offset,
    })
  } catch (error) {
    routeLogger.error('[nfPrograms] list error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:track/:programId', async (req, res) => {
  try {
    const track = normalizeTrack(req.params.track)
    if (!track) return res.status(400).json({ error: 'Invalid track' })
    const table = tableForTrack(track)
    const ALLOWED_TABLES = new Set(['nf_programs_a', 'nf_programs_b'])
    if (!ALLOWED_TABLES.has(table)) return res.status(400).json({ error: 'Invalid table' })

    const row = await req.db
      .prepare(`SELECT * FROM ${table} WHERE program_id = ?`)
      .get(req.params.programId)
    if (!row) return res.status(404).json({ error: 'Program not found' })

    const versions = await req.db
      .prepare(
        `
          SELECT *
          FROM nf_program_versions
          WHERE program_id = ? AND funding_track = ?
          ORDER BY created_at DESC
          LIMIT 50
        `,
      )
      .all(req.params.programId, track)

    res.json({ program: decorate(row), versions })
  } catch (error) {
    routeLogger.error('[nfPrograms] detail error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

