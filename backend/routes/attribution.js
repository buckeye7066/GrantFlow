/**
 * routes/attribution.js — PromoPilot promotion-to-conversion bridge.
 *
 * POST /api/attribution/claim
 *   Body: { touch_id } — the `pp_touch` query param PromoPilot's /r/ redirect
 *   appends to promoted landing URLs (random id, carries no identity).
 *   Associates the touch with the signed-in user (system_kv) and reports a
 *   SIGNUP conversion to PromoPilot when the account is newly created.
 *
 * Contract: attribution must NEVER interfere with product flow — the service
 * layer never throws, the network send is fire-and-forget, and missing env
 * config makes everything a clean no-op.
 */

import express from 'express'
import rateLimit from 'express-rate-limit'
import { ensureAuth } from '../middleware/auth.js'
import { claimPromoTouchForUser, isValidPromoTouchId } from '../services/promoAttribution.js'

const router = express.Router()

// One claim per landing is the honest cadence; 30/5min absorbs retries.
const claimLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
})

router.post('/claim', claimLimiter, ensureAuth, async (req, res) => {
  const touchId = String(req.body?.touch_id ?? '')
  if (!isValidPromoTouchId(touchId)) {
    return res.status(400).json({ error: 'invalid_touch_id' })
  }
  const userId = req.user?.userId ?? req.user?.id ?? null
  if (!userId) return res.status(401).json({ error: 'unauthorized' })
  const result = await claimPromoTouchForUser(req.db, { userId, touchId })
  // The claim is best-effort by contract — a store failure is reported as
  // ok:false but never as an HTTP error the frontend would surface.
  return res.json({ ok: result?.ok === true })
})

export default router
