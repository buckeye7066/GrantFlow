import express from 'express'
import crypto from 'node:crypto'
import { ensureAuth } from '../middleware/auth.js'
import {
  seedServiceCatalogFromExtract,
  listServiceCatalog,
  getLatestServiceTerms,
  ensureServiceCatalogSchema,
  MILESTONE_PHASES,
} from '../services/serviceCatalogStore.js'
import { roundBillableMinutes } from '../services/hourlyRounding.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:services')

const router = express.Router()

// Ensure catalog exists (fast + idempotent). This keeps fresh deploys usable.
router.use(async (req, _res, next) => {
  try {
    await seedServiceCatalogFromExtract(req.db)
  } catch (error) {
    console.warn('[services] failed to ensure catalog seed:', error?.message || String(error))
    // Continue with degraded functionality - catalog operations may fail
    req.catalogSeedFailed = true
  }
  next()
})

router.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'services',
    status: 'healthy',
    endpoints: ['/api/services/catalog', '/api/services/terms'],
  })
})

router.get('/catalog', async (req, res) => {
  try {
    const includeInactive = String(req.query?.include_inactive || '').toLowerCase() === 'true'
    const catalog = await listServiceCatalog(req.db, { includeInactive })
    res.json({ ok: true, catalog })
  } catch (error) {
    routeLogger.error('[services] GET /catalog error:', error?.message || String(error))
    res.status(500).json({ ok: false, error: 'Failed to load service catalog' })
  }
})

router.get('/terms', ensureAuth, async (req, res) => {
  try {
    const terms = await getLatestServiceTerms(req.db)
    res.json({ ok: true, terms })
  } catch (error) {
    routeLogger.error('[services] GET /terms error:', error?.message || String(error))
    res.status(500).json({ ok: false, error: 'Failed to load service terms' })
  }
})

async function getClientCategoryForProfile(db, profileId, userId) {
  const row = await db
    .prepare(
      `
        SELECT p.id, p.primary_type, o.applicant_type, o.annual_budget
        FROM profiles p
        LEFT JOIN organizations o ON o.id = p.organization_id
        WHERE p.id = ? AND p.user_id = ?
        LIMIT 1
      `,
    )
    .get(String(profileId), String(userId))
  if (!row) return null

  const applicantType = String(row.applicant_type || row.primary_type || '').toLowerCase()
  if (['individual_need', 'medical_assistance', 'family', 'high_school_student', 'college_student', 'graduate_student'].includes(applicantType)) {
    return 'individual'
  }
  const budget = Number(row.annual_budget)
  if (Number.isFinite(budget)) {
    if (budget < 250000) return 'small'
    if (budget <= 2000000) return 'mid'
    return 'large'
  }
  // Conservative default (business/org without budget provided)
  return 'large'
}

router.post('/purchases', ensureAuth, async (req, res) => {
  await ensureServiceCatalogSchema(req.db)

  const userId = req.ctx?.userId ?? req.user?.userId ?? null
  if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required' })

  const body = req.body ?? {}
  const serviceSlug = typeof body.service_slug === 'string' ? body.service_slug.trim() : ''
  const profileId = typeof body.profile_id === 'string' ? body.profile_id.trim() : (req.ctx?.activeProfileId ? String(req.ctx.activeProfileId) : '')

  let clientCategory = typeof body.client_category === 'string' ? body.client_category.trim() : ''
  if (!clientCategory && profileId) {
    clientCategory = (await getClientCategoryForProfile(req.db, profileId, req.ctx?.userId ?? req.user?.userId ?? null)) || ''
  }

  if (!serviceSlug) return res.status(400).json({ ok: false, error: 'service_slug required' })
  if (!clientCategory) return res.status(400).json({ ok: false, error: 'client_category required' })
  if (!['individual', 'small', 'mid', 'large'].includes(clientCategory)) {
    return res.status(400).json({ ok: false, error: 'invalid client_category' })
  }

  const svc = await req.db
    .prepare('SELECT id, pricing_model FROM service_catalog_items WHERE slug = ? LIMIT 1')
    .get(serviceSlug)
  if (!svc) return res.status(404).json({ ok: false, error: 'service not found' })

  const terms = await getLatestServiceTerms(req.db)
  const purchaseId = crypto.randomUUID()

  // Pre-validate all milestone prices before writing anything
  let milestonePrices = []
  if (String(svc.pricing_model) === 'milestone') {
    for (const phase of MILESTONE_PHASES) {
      const price = await req.db
        .prepare(
          `
            SELECT amount_cents
            FROM service_prices
            WHERE service_id = ?
              AND client_category = ?
              AND milestone_phase = ?
              AND active = 1
            LIMIT 1
          `,
        )
        .get(String(svc.id), clientCategory, phase)
      if (!price) {
        return res.status(500).json({ ok: false, error: `missing milestone price for ${phase}` })
      }
      milestonePrices.push({ phase, amount_cents: Number(price.amount_cents) })
    }
  }

  // All prices confirmed â now write atomically
  const insertPurchase = req.db.prepare(
    `
      INSERT INTO service_purchases (
        id, user_id, profile_id, organization_id,
        service_id, client_category, pricing_model,
        status, agreed_terms_version, agreed_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, (SELECT organization_id FROM profiles WHERE id = ?),
        ?, ?, ?,
        'draft', ?, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `,
  )

  const insertMilestone = req.db.prepare(
    `
      INSERT INTO milestone_payments (
        id, purchase_id, phase, amount_cents, currency, status, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 'usd', 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `,
  )

  const runTransaction = req.db.transaction(() => {
    insertPurchase.run(
      purchaseId,
      req.ctx?.userId ?? req.user?.userId ?? null,
      profileId || null,
      profileId || null,
      String(svc.id),
      clientCategory,
      String(svc.pricing_model),
      terms?.version || null,
    )
    for (const { phase, amount_cents } of milestonePrices) {
      insertMilestone.run(crypto.randomUUID(), purchaseId, phase, amount_cents)
    }
  })

  runTransaction()

  res.status(201).json({
    ok: true,
    purchase: {
      id: purchaseId,
      service_slug: serviceSlug,
      pricing_model: String(svc.pricing_model),
      client_category: clientCategory,
      status: 'draft',
      terms_version: terms?.version || null,
    },
  })
})

router.get('/purchases', ensureAuth, async (req, res) => {
  await ensureServiceCatalogSchema(req.db)
  const userId = req.ctx?.userId ?? req.user?.userId ?? null
  if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required' })

  const rows = await req.db
    .prepare(
      `
        SELECT sp.*, sci.slug AS service_slug, sci.name AS service_name
        FROM service_purchases sp
        JOIN service_catalog_items sci ON sci.id = sp.service_id
        WHERE sp.user_id = ?
        ORDER BY sp.created_at DESC
        LIMIT 100
      `,
    )
    .all(String(userId))

  const purchases = []
  for (const row of rows || []) {
    const pid = String(row.id)
    let milestones = []
    try {
      milestones = await req.db
        .prepare('SELECT * FROM milestone_payments WHERE purchase_id = ? ORDER BY phase ASC')
        .all(pid)
    } catch (error) {
      routeLogger.error(`Failed to fetch milestones for purchase ${pid}:`, error)
      milestones = []
    }

    let time = { total: 0 }
    try {
      time = await req.db
        .prepare('SELECT COALESCE(SUM(rounded_minutes), 0) AS total FROM hourly_time_entries WHERE purchase_id = ?')
        .get(pid)
    } catch (error) {
      routeLogger.error(`Failed to fetch time entries for purchase ${pid}:`, error)
      time = { total: 0 }
    }

    let invoices = []
    try {
      invoices = await req.db
        .prepare('SELECT * FROM hourly_invoices WHERE purchase_id = ? ORDER BY created_at DESC LIMIT 10')
        .all(pid)
    } catch (error) {
      routeLogger.error(`Failed to fetch invoices for purchase ${pid}:`, error)
      invoices = []
    }

    purchases.push({
      id: pid,
      service_slug: row.service_slug,
      service_name: row.service_name,
      client_category: row.client_category,
      pricing_model: row.pricing_model,
      status: row.status,
      stripe_checkout_session_id: row.stripe_checkout_session_id || null,
      stripe_payment_intent_id: row.stripe_payment_intent_id || null,
      milestones: (milestones || []).map((m) => ({
        id: String(m.id),
        phase: m.phase,
        amount_cents: Number(m.amount_cents),
        status: m.status,
        stripe_checkout_session_id: m.stripe_checkout_session_id || null,
        stripe_payment_intent_id: m.stripe_payment_intent_id || null,
      })),
      hourly: {
        total_rounded_minutes: Number(time?.total || 0),
        invoices: (invoices || []).map((inv) => ({
          id: String(inv.id),
          total_rounded_minutes: Number(inv.total_rounded_minutes),
          units: Number(inv.units),
          amount_cents: Number(inv.amount_cents),
          status: inv.status,
          stripe_checkout_session_id: inv.stripe_checkout_session_id || null,
          stripe_payment_intent_id: inv.stripe_payment_intent_id || null,
        })),
      },
      created_at: row.created_at || null,
    })
  }

  res.json({ ok: true, purchases })
})

router.post('/hourly/time-entry', ensureAuth, async (req, res) => {
  await ensureServiceCatalogSchema(req.db)
  const body = req.body ?? {}
  const purchaseId = typeof body.purchase_id === 'string' ? body.purchase_id.trim() : ''
  const minutes = Number(body.minutes)
  const note = typeof body.note === 'string' ? body.note.trim() : null

  if (!purchaseId) return res.status(400).json({ ok: false, error: 'purchase_id required' })
  if (!Number.isFinite(minutes) || minutes <= 0) return res.status(400).json({ ok: false, error: 'minutes must be > 0' })

  const p = await req.db
    .prepare('SELECT id, user_id, pricing_model FROM service_purchases WHERE id = ? LIMIT 1')
    .get(purchaseId)
  if (!p) return res.status(404).json({ ok: false, error: 'purchase not found' })
  const userId = req.ctx?.userId ?? req.user?.userId ?? null
  if (!userId || String(p.user_id) !== String(userId)) return res.status(403).json({ ok: false, error: 'Not authorized' })
  if (String(p.pricing_model) !== 'hourly') return res.status(400).json({ ok: false, error: 'purchase is not hourly' })

  const rounded = roundBillableMinutes(minutes, { minimumMinutes: 15, incrementMinutes: 6 })
  const id = crypto.randomUUID()
  await req.db.prepare(
    `
      INSERT INTO hourly_time_entries (id, purchase_id, minutes, rounded_minutes, note, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `,
  ).run(id, purchaseId, Math.floor(minutes), rounded, note)

  res.status(201).json({ ok: true, entry: { id, purchase_id: purchaseId, minutes: Math.floor(minutes), rounded_minutes: rounded, note } })
})

export default router

