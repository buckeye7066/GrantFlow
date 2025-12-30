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
          `SELECT
             id,
             title,
             summary,
             description,
             amount_min,
             amount_max,
             currency,
             deadline,
             geography,
             category,
             tags,
             eligibility,
             source_id,
             contact_email,
             contact_phone,
             source_url,
             last_synced_at,
             created_at,
             updated_at
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
