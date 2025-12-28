import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import {
  getAllProfiles,
  getProfileById,
  createProfile,
  updateProfile,
  deleteProfile,
} from '../db/index.js'

const router = express.Router()

/**
 * GET /api/profiles
 * List all profiles
 */
router.get('/', (req, res, next) => {
  try {
    const profiles = getAllProfiles()
    res.json(profiles)
import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { getDb } from '../db/index.js'

const router = Router()

function resolveDb(res) {
  try {
    return getDb()
  } catch (error) {
    const status = error.status ?? 503
    res
      .status(status)
      .json({ error: error.message ?? 'Database unavailable. Install better-sqlite3 on the server.' })
    return null
  }
}

function mapProfile(row) {
  if (!row) return null
  return {
    id: row.id,
    profile_type: row.profile_type,
    display_name: row.display_name,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    full_name: row.full_name,
    dob: row.dob,
    address_line1: row.address_line1,
    address_line2: row.address_line2,
    city: row.city,
    state: row.state,
    zip: row.zip,
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

/**
 * POST /api/profiles
 * Create new profile
 */
router.post('/', (req, res, next) => {
  try {
    const profileData = {
      id: uuidv4(),
      profile_type: req.body.profile_type || 'organization',
      display_name: req.body.display_name,
      notes: req.body.notes || '',
      full_name: req.body.full_name || null,
      dob: req.body.dob || null,
      address_line1: req.body.address_line1 || null,
      address_line2: req.body.address_line2 || null,
      city: req.body.city || null,
      state: req.body.state || null,
      zip: req.body.zip || null,
    }
    
    if (!profileData.display_name) {
      return res.status(400).json({ error: 'display_name is required' })
    }
    
    const profile = createProfile(profileData)
    res.status(201).json(profile)
router.post('/', (req, res, next) => {
  try {
    const {
      display_name: displayName,
      profile_type: profileType = 'organization',
      notes = '',
      full_name: fullName = null,
      dob = null,
      address_line1: addressLine1 = null,
      address_line2: addressLine2 = null,
      city = null,
      state = null,
      zip = null,
    } = req.body || {}

    if (!displayName || typeof displayName !== 'string') {
      return res.status(400).json({ error: 'display_name is required' })
    }

    const id = uuid()
    const timestamp = new Date().toISOString()
    const db = resolveDb(res)
    if (!db) return
    const stmt = db.prepare(
      `INSERT INTO profiles (
        id, profile_type, display_name, notes, created_at, updated_at,
        full_name, dob, address_line1, address_line2, city, state, zip
      ) VALUES (
        @id, @profile_type, @display_name, @notes, @created_at, @updated_at,
        @full_name, @dob, @address_line1, @address_line2, @city, @state, @zip
      )`,
    )

    stmt.run({
      id,
      profile_type: profileType,
      display_name: displayName,
      notes,
      created_at: timestamp,
      updated_at: timestamp,
      full_name: fullName,
      dob,
      address_line1: addressLine1,
      address_line2: addressLine2,
      city,
      state,
      zip,
    })

    const record = db
      .prepare('SELECT * FROM profiles WHERE id = ?')
      .get(id)
    res.status(201).json({ data: mapProfile(record) })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/profiles/:id
 * Get single profile
 */
router.get('/:id', (req, res, next) => {
  try {
    const profile = getProfileById(req.params.id)
    
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }
    
    res.json(profile)
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

/**
 * PATCH /api/profiles/:id
 * Update profile
 */
router.patch('/:id', (req, res, next) => {
  try {
    const updates = {}
    const allowedFields = [
      'profile_type', 'display_name', 'notes', 'full_name', 'dob',
      'address_line1', 'address_line2', 'city', 'state', 'zip'
    ]
    
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field]
      }
    }
    
    const profile = updateProfile(req.params.id, updates)
    
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }
    
    res.json(profile)
  } catch (error) {
    next(error)
  }
})

/**
 * DELETE /api/profiles/:id
 * Delete profile
 */
router.delete('/:id', (req, res, next) => {
  try {
    const deleted = deleteProfile(req.params.id)
    
    if (!deleted) {
      return res.status(404).json({ error: 'Profile not found' })
    }
    
    res.status(204).send()
router.patch('/:id', (req, res, next) => {
  try {
    const db = resolveDb(res)
    if (!db) return
    const record = db
      .prepare('SELECT * FROM profiles WHERE id = ?')
      .get(req.params.id)

    if (!record) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const allowed = [
      'display_name',
      'notes',
      'profile_type',
      'full_name',
      'dob',
      'address_line1',
      'address_line2',
      'city',
      'state',
      'zip',
    ]

    const updates = {}
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates[key] = req.body[key]
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ data: mapProfile(record) })
    }

    const assignments = Object.keys(updates)
      .map((key) => `${key} = @${key}`)
      .join(', ')

    const stmt = db.prepare(
      `UPDATE profiles SET ${assignments}, updated_at = @updated_at WHERE id = @id`,
    )

    stmt.run({
      ...updates,
      updated_at: new Date().toISOString(),
      id: req.params.id,
    })

    const updated = db
      .prepare('SELECT * FROM profiles WHERE id = ?')
      .get(req.params.id)

    res.json({ data: mapProfile(updated) })
  } catch (error) {
    next(error)
  }
})

export default router
