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
  } catch (error) {
    next(error)
  }
})

export default router
