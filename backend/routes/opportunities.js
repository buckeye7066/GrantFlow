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
import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { getDb } from '../db/index.js'

const router = Router()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const JSON_STORE = path.resolve(__dirname, '..', 'data', 'opportunities.json')

router.get('/', async (req, res, next) => {
  let db = null
  try {
    db = getDb()
  } catch (error) {
    db = null
  }

  if (db) {
    try {
      const rows = db
        .prepare(
          `SELECT id, title, description, amount, deadline, contact_url, source_url, updated_at
           FROM funding_sources
           ORDER BY datetime(updated_at) DESC`,
        )
        .all()
      if (rows.length) {
        return res.json({ data: rows })
      }
    } catch (error) {
      // fall through to JSON fallback
    }
  }

  try {
    const raw = await fs.readFile(JSON_STORE, 'utf8')
    if (!raw) {
      return res.json({ data: [] })
    }
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return res.json({ data: parsed })
    }
    const aggregated = []
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value)) aggregated.push(...value)
    }
    return res.json({ data: aggregated })
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.json({ data: [] })
    }
    next(error)
  }
})

export default router
