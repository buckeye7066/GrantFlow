/**
 * /api/pricing routes.
 *
 * Admin-only endpoints (quote inspection, approval, edits, discount
 * management, mark-presented/accepted/declined, discount-rule CRUD)
 * authenticate via `isAdminUser`. Errors return `{ ok: false, error }`.
 *
 * Two non-admin endpoints:
 *   - GET  /api/pricing/my-estimate/:profileId
 *       returns a gentle non-binding estimate ONLY when
 *       PRICING_SHOW_CLIENT_ESTIMATE=true. Otherwise returns
 *       { available: false, message: "Pricing will be reviewed after intake." }
 *
 *   - POST /api/pricing/recommend
 *       called by Anya intake on completion. Admin or system-only —
 *       requires admin authentication.
 */

import express from 'express'
import { isAdminUser, requireAuthenticatedUser, requireAuthenticatedUserMiddleware } from '../utils/accessControl.js'
import { createLogger } from '../utils/logger.js'
import {
  PRICING_ENV_KEYS,
  QUOTE_STATUS,
  readEnvFlag,
} from '../services/pricing/pricingTypes.js'
import { buildRecommendedQuote, buildClientEstimateMessage } from '../services/pricing/pricingEngine.js'
import { defaultDiscountRules } from '../services/pricing/discountEngine.js'
import {
  persistQuote,
  getQuote,
  listQuotes,
  approveQuote,
  approveDiscount,
  removeDiscount,
  addManualDiscount,
  editLineItem,
  updateQuoteStatus,
} from '../services/pricing/quoteBuilder.js'
import { initializeProfilePricing } from '../services/pricing/profilePricingInitializer.js'
import {
  listForAdmin,
  markDelivered,
  dismiss,
  flushQueuedOnLogin,
} from '../services/pricing/pricingNotificationService.js'
import { isAdminNotificationTarget } from '../services/pricing/pricingTypes.js'

const routeLogger = createLogger('route:pricing')
const router = express.Router()

const requireAdmin = (req, res, next) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!isAdminUser(user)) return res.status(403).json({ ok: false, error: 'admin_only' })
  return next()
}

// ── User-facing endpoints (auth required, no admin) ────────────────────────
router.get('/my-estimate/:profileId', requireAuthenticatedUserMiddleware, async (req, res) => {
  try {
    if (!readEnvFlag(PRICING_ENV_KEYS.PRICING_SHOW_CLIENT_ESTIMATE, false)) {
      return res.status(200).json({
        ok: true,
        available: false,
        message: 'Pricing will be reviewed after intake.',
      })
    }
    const quotes = await listQuotes(req.db, { limit: 1 })
    const own = (quotes.items || []).find((q) => q.profile_id === req.params.profileId)
    if (!own) {
      return res.status(200).json({
        ok: true,
        available: false,
        message: 'Anya is preparing suggested next steps based on your matches.',
      })
    }
    return res.status(200).json({
      ok: true,
      available: true,
      message: buildClientEstimateMessage(own),
      pricing_catalog_version: own.pricing_catalog_version,
    })
  } catch (err) {
    routeLogger.error('my_estimate_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

// ── Admin-only endpoints ───────────────────────────────────────────────────
router.use(requireAdmin)

router.get('/discount-rules', (req, res) => {
  return res.status(200).json({ ok: true, rules: defaultDiscountRules() })
})

router.post('/discount-rules', (req, res) => {
  // Currently a no-op write that echoes back the submission. Persistence
  // belongs in a dedicated DB-backed rule editor (next PR); this endpoint
  // exists so admin UIs can be wired against a stable URL today.
  return res.status(200).json({ ok: true, accepted: true, rule: req.body || null })
})

router.get('/quotes', async (req, res) => {
  try {
    const status = req.query.status || null
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
    const offset = Math.max(Number(req.query.offset) || 0, 0)
    const result = await listQuotes(req.db, { status, limit, offset })
    return res.status(200).json({ ok: true, ...result })
  } catch (err) {
    routeLogger.error('list_quotes_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.get('/quotes/:quoteId', async (req, res) => {
  try {
    const quote = await getQuote(req.db, req.params.quoteId)
    if (!quote) return res.status(404).json({ ok: false, error: 'quote_not_found' })
    return res.status(200).json({ ok: true, quote })
  } catch (err) {
    routeLogger.error('get_quote_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/quotes/:quoteId/approve', async (req, res) => {
  try {
    const r = await approveQuote(req.db, req.params.quoteId)
    return res.status(r?.ok ? 200 : 400).json({ ok: Boolean(r?.ok), ...r })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/quotes/:quoteId/edit', async (req, res) => {
  try {
    const { line_item_id: lineItemId, updates } = req.body || {}
    if (!lineItemId) return res.status(400).json({ ok: false, error: 'line_item_id_required' })
    const r = await editLineItem(req.db, req.params.quoteId, lineItemId, updates || {})
    return res.status(200).json({ ok: true, ...r })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/quotes/:quoteId/discount', async (req, res) => {
  try {
    const { action, discount_id: discountId, ...rest } = req.body || {}
    if (action === 'approve' && discountId) {
      const r = await approveDiscount(req.db, req.params.quoteId, discountId)
      return res.status(200).json({ ok: true, ...r })
    }
    if (action === 'remove' && discountId) {
      const r = await removeDiscount(req.db, req.params.quoteId, discountId)
      return res.status(200).json({ ok: true, ...r })
    }
    if (action === 'add') {
      const r = await addManualDiscount(req.db, req.params.quoteId, rest)
      return res.status(200).json({ ok: true, ...r })
    }
    return res.status(400).json({ ok: false, error: 'invalid_action' })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/quotes/:quoteId/mark-presented', async (req, res) => {
  try {
    const r = await updateQuoteStatus(req.db, req.params.quoteId, QUOTE_STATUS.PRESENTED_TO_CLIENT)
    return res.status(200).json({ ok: true, ...r })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/quotes/:quoteId/mark-accepted', async (req, res) => {
  try {
    const r = await updateQuoteStatus(req.db, req.params.quoteId, QUOTE_STATUS.ACCEPTED)
    return res.status(200).json({ ok: true, ...r })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/quotes/:quoteId/mark-declined', async (req, res) => {
  try {
    const r = await updateQuoteStatus(req.db, req.params.quoteId, QUOTE_STATUS.DECLINED)
    return res.status(200).json({ ok: true, ...r })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

/**
 * Internal endpoint Anya calls on intake completion.
 * Body: { profile_id, intake_session_id, matches, intake_answers, profile?, organization? }
 */
router.post('/recommend', async (req, res) => {
  try {
    const {
      profile_id: profileId,
      intake_session_id: intakeSessionId = null,
      matches = [],
      intake_answers: intakeAnswers = {},
      profile = {},
      organization = {},
      discount_inputs: discountInputs = {},
      source = 'pricing_recommend_endpoint',
    } = req.body || {}

    if (!profileId) return res.status(400).json({ ok: false, error: 'profile_id_required' })

    // Prefer the integrated initializer (creates profile_pricing +
    // service_agreement + admin notification + access events). Falls
    // back to a quote-only flow if the access-gate tables aren't
    // installed yet.
    const profilePayload = profile && profile.id ? profile : { ...profile, id: profileId }
    const initialized = await initializeProfilePricing(req.db, {
      profile: profilePayload,
      intakeAnswers,
      organization,
      matches,
      user: req.user || null,
      discountInputs,
      intakeSessionId,
      source,
    })

    if (initialized?.ok) {
      return res.status(200).json({
        ok: true,
        ...initialized,
      })
    }

    if (initialized?.error && initialized.error !== 'pricing_tables_not_installed') {
      return res.status(400).json({ ok: false, error: initialized.error })
    }

    // Fallback: pricing-engine-only path (used when migration 080 hasn't run yet).
    const quote = buildRecommendedQuote({
      profile,
      intakeAnswers,
      organization,
      matches,
      discountInputs,
    })

    const persisted = await persistQuote(req.db, {
      userId: req.user?.id || null,
      profileId,
      intakeSessionId,
      quote,
    })

    return res.status(200).json({
      ok: true,
      quote_id: persisted?.id || null,
      persisted: Boolean(persisted?.ok),
      client_category: quote.client_category,
      recommended_package_name: quote.recommended_package_name,
      subtotal: quote.subtotal,
      discount_total: quote.discount_total,
      total: quote.total,
      admin_review_required: quote.admin_review_required,
      reasons: quote.reasons,
    })
  } catch (err) {
    routeLogger.error('recommend_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

// ── Admin pricing notifications ─────────────────────────────────────────────

router.get('/admin-notifications', async (req, res) => {
  try {
    if (!isAdminNotificationTarget(req.user?.email)) {
      return res.status(200).json({ ok: true, items: [], not_admin_target: true })
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100)
    const status = req.query.status || null
    const r = await listForAdmin(req.db, { user: req.user, limit, status })
    return res.status(200).json(r)
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/admin-notifications/flush-queued', async (req, res) => {
  try {
    const r = await flushQueuedOnLogin(req.db, { user: req.user })
    return res.status(r?.ok ? 200 : 400).json(r)
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/admin-notifications/:id/delivered', async (req, res) => {
  try {
    const r = await markDelivered(req.db, { user: req.user, id: req.params.id, mode: req.body?.mode })
    return res.status(r?.ok ? 200 : 400).json(r)
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/admin-notifications/:id/dismiss', async (req, res) => {
  try {
    const r = await dismiss(req.db, { user: req.user, id: req.params.id })
    return res.status(r?.ok ? 200 : 400).json(r)
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

export default router
