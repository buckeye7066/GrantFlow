/**
 * /api/access-gate routes.
 *
 * Frontend uses these to decide whether to render the full app or
 * redirect to /PricingRequired. The auditor uses them to verify the
 * gate is functioning.
 *
 * - GET  /api/access-gate/status                — current user + profile
 * - POST /api/access-gate/initialize-pricing   — admin/system; bootstraps pricing for a profile
 * - POST /api/access-gate/agreement/accept     — record service-agreement acceptance
 * - POST /api/access-gate/payment-success      — admin-only; mark a profile paid (e.g. from a webhook handler)
 * - POST /api/access-gate/admin-waive          — admin marks a profile as admin_waived
 */

import express from 'express'
import { isAdminUser, requireAuthenticatedUser, requireAuthenticatedUserMiddleware } from '../utils/accessControl.js'
import { createLogger } from '../utils/logger.js'
import {
  getAccessStatus,
  acceptAgreement,
  markPaid,
} from '../services/pricing/pricingAccessGate.js'
import {
  initializeProfilePricing,
  adminWaiveProfile,
  recordPaymentAccessEvent,
} from '../services/pricing/profilePricingInitializer.js'
import {
  PAYMENT_ACCESS_EVENT,
  SERVICE_AGREEMENT_VERSION,
} from '../services/pricing/pricingTypes.js'

const routeLogger = createLogger('route:access-gate')
const router = express.Router()

router.get('/status', async (req, res) => {
  try {
    const user = req.user || null
    const profileId =
      req.query.profileId ||
      req.query.profile_id ||
      user?.activeProfileId ||
      user?.profile_id ||
      null
    const status = await getAccessStatus(req.db, { user, profileId })
    return res.status(200).json({ ok: true, ...status })
  } catch (err) {
    routeLogger.error('access_status_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/agreement/accept', requireAuthenticatedUserMiddleware, async (req, res) => {
  try {
    const user = req.user
    const { profile_id: profileId, agreement_text: agreementText } = req.body || {}
    if (!profileId) return res.status(400).json({ ok: false, error: 'profile_id_required' })
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress
    const ua = req.headers['user-agent'] || ''
    const r = await acceptAgreement(req.db, {
      profileId,
      userId: user?.id || null,
      ip: typeof ip === 'string' ? ip : Array.isArray(ip) ? ip[0] : null,
      userAgent: ua,
      agreementText,
    })
    await recordPaymentAccessEvent(req.db, {
      userId: user?.id || null,
      profileId,
      quoteId: null,
      eventType: PAYMENT_ACCESS_EVENT.AGREEMENT_ACCEPTED,
      details: { agreement_version: SERVICE_AGREEMENT_VERSION },
    })
    return res.status(r?.ok ? 200 : 400).json(r)
  } catch (err) {
    routeLogger.error('agreement_accept_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

// Admin/system only beyond this point.
router.use((req, res, next) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!isAdminUser(user)) return res.status(403).json({ ok: false, error: 'admin_only' })
  return next()
})

router.post('/initialize-pricing', async (req, res) => {
  try {
    const {
      profile,
      profile_id: profileId,
      intake_answers: intakeAnswers,
      organization,
      matches,
      user,
      discount_inputs: discountInputs,
      intake_session_id: intakeSessionId,
      source,
    } = req.body || {}
    const profilePayload = profile || (profileId ? { id: profileId } : null)
    if (!profilePayload?.id) {
      return res.status(400).json({ ok: false, error: 'profile_id_required' })
    }
    const r = await initializeProfilePricing(req.db, {
      profile: profilePayload,
      intakeAnswers: intakeAnswers || {},
      organization: organization || {},
      matches: matches || [],
      user: user || null,
      discountInputs: discountInputs || {},
      intakeSessionId: intakeSessionId || null,
      source: source || 'admin_api',
    })
    return res.status(r?.ok ? 200 : 400).json(r)
  } catch (err) {
    routeLogger.error('initialize_pricing_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/payment-success', async (req, res) => {
  try {
    const { profile_id: profileId, quote_id: quoteId } = req.body || {}
    if (!profileId) return res.status(400).json({ ok: false, error: 'profile_id_required' })
    const paid = await markPaid(req.db, { profileId })
    await recordPaymentAccessEvent(req.db, {
      userId: null,
      profileId,
      quoteId: quoteId || null,
      eventType: PAYMENT_ACCESS_EVENT.PAYMENT_SUCCEEDED,
      details: { actor: req.user?.email || 'admin' },
    })
    await recordPaymentAccessEvent(req.db, {
      userId: null,
      profileId,
      quoteId: quoteId || null,
      eventType: PAYMENT_ACCESS_EVENT.ACCESS_GRANTED,
      details: { reason: 'payment_succeeded' },
    })
    return res.status(paid?.ok ? 200 : 400).json(paid)
  } catch (err) {
    routeLogger.error('payment_success_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/admin-waive', async (req, res) => {
  try {
    const { profile_id: profileId } = req.body || {}
    if (!profileId) return res.status(400).json({ ok: false, error: 'profile_id_required' })
    const r = await adminWaiveProfile(req.db, profileId, { actor: req.user })
    return res.status(r?.ok ? 200 : 400).json(r)
  } catch (err) {
    routeLogger.error('admin_waive_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

export default router
