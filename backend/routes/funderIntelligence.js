import express from 'express'
import { requireAuthenticatedUserMiddleware } from '../utils/accessControl.js'
import {
  FunderIntelligenceError,
  getFunderIntelligence,
} from '../services/funderIntel/funderIntelligenceRepository.js'

const router = express.Router()

router.get('/:ein/intelligence', requireAuthenticatedUserMiddleware, async (req, res) => {
  try {
    const intelligence = await getFunderIntelligence(req.db, {
      ein: req.params.ein,
      taxYear: req.query.tax_year,
      recipientState: req.query.recipient_state,
      limit: req.query.limit,
      offset: req.query.offset,
    })
    return res.json({ intelligence })
  } catch (error) {
    if (error instanceof FunderIntelligenceError) {
      return res.status(400).json({ error: error.message, code: error.code, details: error.details ?? undefined })
    }
    return res.status(500).json({ error: 'Failed to load persisted funder intelligence' })
  }
})

export default router
