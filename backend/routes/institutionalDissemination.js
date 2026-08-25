import express from 'express'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { buildInstitutionalNewsletterBundle } from '../services/dissemination/institutionalNewsletter.js'

const router = express.Router()
router.use(ensureAuth)
router.use(ensureAdmin)

router.post('/newsletter-bundle', (req, res, next) => {
  try {
    return res.json(buildInstitutionalNewsletterBundle(req.body || {}))
  } catch (error) {
    if (!error.status) error.status = 400
    return next(error)
  }
})

export default router
