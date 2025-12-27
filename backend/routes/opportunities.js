import express from 'express'
import { getDb } from '../db/index.js'

const router = express.Router()

/**
 * GET /api/opportunities
 * Return funding sources from database
 */
router.get('/', (req, res, next) => {
  try {
    const db = getDb()
    
    // Check if funding_sources table exists
    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='funding_sources'
    `).get()
    
    if (!tableExists) {
      // Return empty array if table doesn't exist
      return res.json([])
    }
    
    // Query funding sources
    const fundingSources = db.prepare(`
      SELECT * FROM funding_sources 
      ORDER BY created_at DESC
    `).all()
    
    res.json(fundingSources)
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/opportunities/:id
 * Get single funding source
 */
router.get('/:id', (req, res, next) => {
  try {
    const db = getDb()
    
    const fundingSource = db.prepare(`
      SELECT * FROM funding_sources WHERE id = ?
    `).get(req.params.id)
    
    if (!fundingSource) {
      return res.status(404).json({ error: 'Funding source not found' })
    }
    
    res.json(fundingSource)
  } catch (error) {
    next(error)
  }
})

export default router
