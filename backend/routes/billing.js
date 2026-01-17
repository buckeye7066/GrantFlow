import express from 'express'
import {
  mapTierRow,
  mapAccountRow,
  ensureBillingSchema,
  ensureBillingAccount,
  selectAccount,
  fetchAccountEvents,
  logBillingAccountEvent,
} from '../services/billingAccounts.js'
import { formatError } from '../middleware/errorHandler.js'

const router = express.Router()

function requireAuth(req, res, next) {
  if (!req.user || req.user.role === 'guest') {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  return next()
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin privileges required' })
  }
  return next()
}

function canAccessProfile(req, profileRow) {
  if (!profileRow) return false
  if (req.user?.role === 'admin') return true
  if (req.user?.profileId && req.user.profileId === profileRow.id) return true
  if (req.user?.userId && profileRow.user_id && req.user.userId === profileRow.user_id) return true
  return false
}

router.use(requireAuth)

router.get('/tiers', async (req, res) => {
  try {
    await ensureBillingSchema(req.db)
    const tiers = (
      await req.db
      .prepare(
        `
          SELECT *
          FROM billing_tiers
          ORDER BY base_monthly_cents IS NULL, base_monthly_cents ASC, name ASC
        `,
      )
      .all()
    ).map(mapTierRow)
    res.json(tiers)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.post('/tiers', requireAdmin, async (req, res) => {
  try {
    await ensureBillingSchema(req.db)
    const {
      id,
      name,
      description = null,
      base_monthly_cents = null,
      hourly_rate_cents = null,
      enable_pipeline_automation = false,
      enable_item_funding = false,
      enable_document_ai = false,
    } = req.body ?? {}

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' })
    }

    const tierId = id?.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '_')

    await req.db
      .prepare(
        `
          INSERT INTO billing_tiers (
            id,
            name,
            description,
            base_monthly_cents,
            hourly_rate_cents,
            enable_pipeline_automation,
            enable_item_funding,
            enable_document_ai
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        tierId,
        name.trim(),
        description ?? null,
        Number.isFinite(base_monthly_cents) ? base_monthly_cents : null,
        Number.isFinite(hourly_rate_cents) ? hourly_rate_cents : null,
        Boolean(enable_pipeline_automation),
        Boolean(enable_item_funding),
        Boolean(enable_document_ai),
      )

    const tier = await req.db.prepare('SELECT * FROM billing_tiers WHERE id = ?').get(tierId)
    res.status(201).json(mapTierRow(tier))
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.put('/tiers/:id', requireAdmin, async (req, res) => {
  try {
    await ensureBillingSchema(req.db)
    const tierId = req.params.id
    const existing = await req.db.prepare('SELECT * FROM billing_tiers WHERE id = ?').get(tierId)
    if (!existing) {
      return res.status(404).json({ error: 'Tier not found' })
    }

    const {
      name = existing.name,
      description = existing.description,
      base_monthly_cents = existing.base_monthly_cents,
      hourly_rate_cents = existing.hourly_rate_cents,
      enable_pipeline_automation = Boolean(existing.enable_pipeline_automation),
      enable_item_funding = Boolean(existing.enable_item_funding),
      enable_document_ai = Boolean(existing.enable_document_ai),
    } = req.body ?? {}

    await req.db
      .prepare(
        `
          UPDATE billing_tiers
          SET name = ?,
              description = ?,
              base_monthly_cents = ?,
              hourly_rate_cents = ?,
              enable_pipeline_automation = ?,
              enable_item_funding = ?,
              enable_document_ai = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
      )
      .run(
        String(name).trim(),
        description ?? null,
        Number.isFinite(base_monthly_cents) ? base_monthly_cents : null,
        Number.isFinite(hourly_rate_cents) ? hourly_rate_cents : null,
        Boolean(enable_pipeline_automation),
        Boolean(enable_item_funding),
        Boolean(enable_document_ai),
        tierId,
      )

    const tier = await req.db.prepare('SELECT * FROM billing_tiers WHERE id = ?').get(tierId)
    res.json(mapTierRow(tier))
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.get('/accounts', requireAdmin, async (req, res) => {
  try {
    await ensureBillingSchema(req.db)
    const orderBy =
      req.db?.dialect === 'postgres'
        ? 'ORDER BY p.display_name ASC'
        : 'ORDER BY p.display_name COLLATE NOCASE ASC'

    const rows = (
      await req.db
        .prepare(
          `
            SELECT
              ba.*,
              bt.name AS tier_name,
              bt.description AS tier_description,
              bt.base_monthly_cents AS tier_monthly,
              bt.hourly_rate_cents AS tier_hourly,
              bt.enable_pipeline_automation AS tier_enable_pipeline_automation,
              bt.enable_item_funding AS tier_enable_item_funding,
              bt.enable_document_ai AS tier_enable_document_ai,
              p.display_name AS profile_name,
              p.primary_type AS profile_type
            FROM billing_accounts ba
            JOIN billing_tiers bt ON bt.id = ba.tier_id
            JOIN profiles p ON p.id = ba.profile_id
            ${orderBy}
          `,
        )
        .all()
    ).map((row) => ({
      ...mapAccountRow(row),
      profile_name: row.profile_name,
      profile_type: row.profile_type,
    }))

    res.json(rows)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.get('/accounts/:profileId', async (req, res) => {
  try {
    await ensureBillingSchema(req.db)
    const profileId = req.params.profileId
    const profile = await req.db
      .prepare(
        `
          SELECT id, user_id, display_name
          FROM profiles
          WHERE id = ?
        `,
      )
      .get(profileId)

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    if (!canAccessProfile(req, profile)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const accountRow = await ensureBillingAccount(req.db, profileId)
    const events = await fetchAccountEvents(req.db, accountRow.id)

    res.json({
      account: mapAccountRow(accountRow),
      events,
    })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.put('/accounts/:profileId', requireAdmin, async (req, res) => {
  try {
    await ensureBillingSchema(req.db)
    const profileId = req.params.profileId
    const profile = await req.db
      .prepare(
        `
          SELECT id, display_name
          FROM profiles
          WHERE id = ?
        `,
      )
      .get(profileId)

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const tierId = req.body?.tier_id
    if (!tierId) {
      return res.status(400).json({ error: 'tier_id is required' })
    }

    const tier = await req.db.prepare('SELECT * FROM billing_tiers WHERE id = ?').get(tierId)
    if (!tier) {
      return res.status(400).json({ error: 'Specified tier does not exist' })
    }

    const accountRow = await ensureBillingAccount(req.db, profileId)
    const previous = { ...accountRow }

    const {
      discount_type = accountRow.discount_type ?? 'none',
      discount_percent = accountRow.discount_percent ?? 0,
      is_pro_bono = Boolean(accountRow.is_pro_bono),
      pro_bono_reason = accountRow.pro_bono_reason ?? null,
      assigned_reason = req.body?.assigned_reason ?? accountRow.assigned_reason,
      custom_monthly_cents = accountRow.custom_monthly_cents,
      custom_hourly_cents = accountRow.custom_hourly_cents,
      metadata = accountRow.metadata ? JSON.parse(accountRow.metadata) : null,
    } = req.body ?? {}

    const allowedDiscounts = new Set(['none', 'student', 'minister', 'hardship', 'custom'])
    if (!allowedDiscounts.has(discount_type ?? 'none')) {
      return res.status(400).json({ error: 'Invalid discount_type' })
    }

    const sanitizedDiscountPercent = Number.isFinite(discount_percent) ? Math.max(0, discount_percent) : 0
    const sanitizedMetadata =
      metadata && typeof metadata === 'object' ? JSON.stringify(metadata) : accountRow.metadata ?? null

    await req.db
      .prepare(
        `
          UPDATE billing_accounts
          SET tier_id = ?,
              assigned_by = ?,
              assigned_reason = ?,
              discount_type = ?,
              discount_percent = ?,
              is_pro_bono = ?,
              pro_bono_reason = ?,
              custom_monthly_cents = ?,
              custom_hourly_cents = ?,
              metadata = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
      )
      .run(
        tierId,
        req.user.userId ?? req.user.email ?? req.user.full_name ?? 'admin',
        assigned_reason ?? null,
        discount_type,
        sanitizedDiscountPercent,
        Boolean(is_pro_bono),
        pro_bono_reason ?? null,
        Number.isFinite(req.body?.custom_monthly_cents) ? req.body.custom_monthly_cents : custom_monthly_cents,
        Number.isFinite(req.body?.custom_hourly_cents) ? req.body.custom_hourly_cents : custom_hourly_cents,
        sanitizedMetadata,
        accountRow.id,
      )

    const updated = await selectAccount(req.db, profileId)

    await logBillingAccountEvent(req.db, updated.id, {
      changed_by: req.user.userId ?? req.user.email ?? req.user.full_name ?? 'admin',
      previous_tier_id: previous.tier_id,
      new_tier_id: updated.tier_id,
      previous_discount_type: previous.discount_type ?? 'none',
      new_discount_type: updated.discount_type ?? 'none',
      previous_discount_percent: previous.discount_percent ?? 0,
      new_discount_percent: updated.discount_percent ?? 0,
      previous_pro_bono: Boolean(previous.is_pro_bono),
      new_pro_bono: Boolean(updated.is_pro_bono),
      notes: req.body?.notes ?? null,
    })

    const events = await fetchAccountEvents(req.db, updated.id)

    res.json({
      account: mapAccountRow(updated),
      events,
    })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

export default router
