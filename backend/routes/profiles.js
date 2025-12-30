import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { getDb } from '../db/index.js'

const router = Router()

const PROFILE_STRING_FIELDS = [
  'profile_type',
  'display_name',
  'notes',
  'full_name',
  'dob',
  'job_title',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'zip',
  'contact_email',
  'contact_phone',
  'website',
  'mission_statement',
  'ein',
  'duns',
  'cage_code',
  'naics_codes',
  'service_area',
  'demographics_served',
  'program_focus_areas',
  'compliance_notes',
  'certifications',
  'created_by',
  'owner_id',
  'case_manager_id',
  'admin_id',
  'status',
  'last_contacted_at',
]

const PROFILE_NUMERIC_FIELDS = new Set(['annual_budget', 'staff_count', 'volunteer_count'])
const PROFILE_BOOLEAN_FIELDS = new Set(['phi_access_required'])
const PROFILE_JSON_FIELDS = new Set(['application_data'])

const PROFILE_DEFAULTS = {
  profile_type: 'organization',
  notes: '',
  phi_access_required: 0,
}

function resolveDb(res) {
  try {
    return getDb()
  } catch (error) {
    const status = error.status ?? 503
    res
      .status(status)
      .json({ error: error.message ?? 'Database unavailable. Install better-sqlite3 to enable persistence.' })
    return null
  }
}

function normalizeValue(key, value) {
  if (value === undefined) return undefined
  if (value === null || value === '') return null

  if (PROFILE_JSON_FIELDS.has(key)) {
    try {
      return JSON.stringify(value)
    } catch (error) {
      return null
    }
  }

  if (PROFILE_BOOLEAN_FIELDS.has(key)) {
    return value ? 1 : 0
  }

  if (PROFILE_NUMERIC_FIELDS.has(key)) {
    const numeric = Number(value)
    return Number.isNaN(numeric) ? null : numeric
  }

  return String(value)
}

function mapProfile(row) {
  if (!row) return null

  let applicationData = {}
  if (row.application_data) {
    try {
      applicationData = JSON.parse(row.application_data)
    } catch (error) {
      applicationData = {}
    }
  }

  return {
    id: row.id,
    profile_type: row.profile_type,
    display_name: row.display_name,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    full_name: row.full_name,
    dob: row.dob,
    job_title: row.job_title,
    address_line1: row.address_line1,
    address_line2: row.address_line2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    contact_email: row.contact_email,
    contact_phone: row.contact_phone,
    website: row.website,
    mission_statement: row.mission_statement,
    ein: row.ein,
    duns: row.duns,
    cage_code: row.cage_code,
    naics_codes: row.naics_codes,
    annual_budget: row.annual_budget === null ? null : Number(row.annual_budget),
    staff_count: row.staff_count === null ? null : Number(row.staff_count),
    volunteer_count: row.volunteer_count === null ? null : Number(row.volunteer_count),
    service_area: row.service_area,
    demographics_served: row.demographics_served,
    program_focus_areas: row.program_focus_areas,
    compliance_notes: row.compliance_notes,
    certifications: row.certifications,
    phi_access_required: Boolean(row.phi_access_required),
    created_by: row.created_by,
    owner_id: row.owner_id,
    case_manager_id: row.case_manager_id,
    admin_id: row.admin_id,
    last_contacted_at: row.last_contacted_at,
    status: row.status,
    application_data: applicationData,
  }
}

router.get('/', (req, res, next) => {
  try {
    const db = resolveDb(res)
    if (!db) return
    const rows = db
      .prepare(
        `SELECT * FROM profiles ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC`,
      )
      .all()
    res.json({ data: rows.map(mapProfile) })
  } catch (error) {
    next(error)
  }
})

router.post('/', (req, res, next) => {
  try {
    const body = req.body || {}
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : ''

    if (!displayName) {
      return res.status(400).json({ error: 'display_name is required' })
    }

    const db = resolveDb(res)
    if (!db) return

    const timestamp = new Date().toISOString()
    const id = uuid()

    const record = {
      id,
      created_at: timestamp,
      updated_at: timestamp,
      ...PROFILE_DEFAULTS,
    }

    for (const key of PROFILE_STRING_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        const value = normalizeValue(key, body[key])
        record[key] = value === undefined ? null : value
      } else if (!Object.prototype.hasOwnProperty.call(record, key)) {
        record[key] = null
      }
    }

    for (const key of PROFILE_NUMERIC_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        record[key] = normalizeValue(key, body[key])
      } else {
        record[key] = null
      }
    }

    for (const key of PROFILE_BOOLEAN_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        record[key] = normalizeValue(key, body[key])
      } else {
        record[key] = PROFILE_DEFAULTS[key] ?? 0
      }
    }

    for (const key of PROFILE_JSON_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        record[key] = normalizeValue(key, body[key])
      } else {
        record[key] = null
      }
    }

    const columns = Object.keys(record)
    const placeholders = columns.map((key) => `@${key}`).join(', ')
    const stmt = db.prepare(`INSERT INTO profiles (${columns.join(', ')}) VALUES (${placeholders})`)

    stmt.run(record)

    const created = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id)
    res.status(201).json({ data: mapProfile(created) })
  } catch (error) {
    next(error)
  }
})

router.get('/:id', (req, res, next) => {
  try {
    const db = resolveDb(res)
    if (!db) return
    const record = db
      .prepare('SELECT * FROM profiles WHERE id = ?')
      .get(req.params.id)

    if (!record) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    res.json({ data: mapProfile(record) })
  } catch (error) {
    next(error)
  }
})

router.patch('/:id', (req, res, next) => {
  try {
    const db = resolveDb(res)
    if (!db) return
    const existing = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id)

    if (!existing) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const body = req.body || {}
    const updates = {}

    for (const key of [
      ...PROFILE_STRING_FIELDS,
      ...PROFILE_NUMERIC_FIELDS,
      ...PROFILE_BOOLEAN_FIELDS,
      ...PROFILE_JSON_FIELDS,
    ]) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        const value = normalizeValue(key, body[key])
        updates[key] = value === undefined ? null : value
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ data: mapProfile(existing) })
    }

    updates.updated_at = new Date().toISOString()

    const assignments = Object.keys(updates)
      .map((key) => `${key} = @${key}`)
      .join(', ')

    const stmt = db.prepare(`UPDATE profiles SET ${assignments} WHERE id = @id`)
    stmt.run({
      ...updates,
      id: req.params.id,
    })

    const updated = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id)
    res.json({ data: mapProfile(updated) })
  } catch (error) {
    next(error)
  }
})

export default router
