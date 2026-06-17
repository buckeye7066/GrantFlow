import express from 'express'
import { ensureAdmin, ensureAuth } from '../middleware/auth.js'
import { ensureServiceCatalogSchema, listServiceCatalog, seedServiceCatalogFromExtract } from '../services/serviceCatalogStore.js'
import { verifyStripePriceMapping } from '../services/pricing/stripePriceVerifier.js'
import { resolveAllCatalogCharges } from '../services/pricing/chargeResolver.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:adminServiceCatalog')

const router = express.Router()
router.use(ensureAuth)
router.use(ensureAdmin)

router.get('/catalog', async (req, res) => {
  try {
    await seedServiceCatalogFromExtract(req.db)
    const catalog = await listServiceCatalog(req.db, { includeInactive: true })
    res.json({ ok: true, catalog })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message })
  }
})

router.post('/service/:slug/toggle', async (req, res) => {
  try {
    await ensureServiceCatalogSchema(req.db)
    const slug = String(req.params.slug || '').trim()
    const isActive = req.body?.is_active === true
    if (!slug) return res.status(400).json({ ok: false, error: 'slug required' })

    const out = await req.db
      .prepare('UPDATE service_catalog_items SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?')
      .run(req.db?.dialect === 'postgres' ? Boolean(isActive) : isActive ? 1 : 0, slug)
    const changed = Number(out?.changes ?? out?.rowCount ?? 0)
    res.json({ ok: true, updated: changed > 0 })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message })
  }
})

router.get('/stripe-price-verification', async (req, res) => {
  try {
    await ensureServiceCatalogSchema(req.db)
    const report = await verifyStripePriceMapping(req.db)
    res.json({ ok: report.ok, ...report })
  } catch (error) {
    routeLogger.error('stripe-price-verification failed', { error: error?.message })
    res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

router.get('/charge-resolution', async (req, res) => {
  try {
    await ensureServiceCatalogSchema(req.db)
    const rows = await resolveAllCatalogCharges(req.db)
    const blocked = rows.filter((r) => !r.can_checkout)
    res.json({
      ok: blocked.length === 0,
      total: rows.length,
      blocked_count: blocked.length,
      rows,
    })
  } catch (error) {
    routeLogger.error('charge-resolution audit failed', { error: error?.message })
    res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

router.post('/price/:id/map-stripe', async (req, res) => {
  try {
    await ensureServiceCatalogSchema(req.db)
    const id = String(req.params.id || '').trim()
    const stripePriceIdRaw = typeof req.body?.stripe_price_id === 'string' ? req.body.stripe_price_id.trim() : ''
    const stripePriceId = stripePriceIdRaw || null

    if (!id) return res.status(400).json({ ok: false, error: 'id required' })
    if (stripePriceId && !/^price_[A-Za-z0-9]+$/.test(stripePriceId)) {
      return res.status(400).json({ ok: false, error: 'invalid stripe_price_id (expected price_*)' })
    }

    const out = await req.db
      .prepare('UPDATE service_prices SET stripe_price_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(stripePriceId, id)
    const changed = Number(out?.changes ?? out?.rowCount ?? 0)
    res.json({ ok: true, updated: changed > 0 })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message })
  }
})

export default router

