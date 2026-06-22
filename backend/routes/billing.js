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
import {
  getProfileTypeDisplayLabel,
  resolveEffectiveProfileType,
} from '../services/profileHelpers.js'
import { computeEffectiveBilling } from '../services/billingAccounts.js'
import { formatError } from '../middleware/errorHandler.js'
import {
  ensureProfileAccess as ensureProfileAccessByEmail,
  getAccessibleProfileIds,
} from '../utils/accessControl.js'
import { fullCatalog } from '../../shared/tierCatalog.js'
import { normalizeCadence, BILLING_CADENCES } from '../services/billing/invoiceSchedule.js'
import {
  ensureInvoiceSchema,
  runBillingCycle,
  markInvoicePaid,
  backfillBillingAnchor,
  grantFreePeriod,
  grantFreePeriodGlobal,
  revokeFreePeriod,
  describeFreePeriod,
  acknowledgeFreeNotice,
  FREE_PERIOD_DAYS,
} from '../services/billing/invoiceService.js'
import {
  suspendProfile,
  reactivateProfile,
  banProfileUser,
  unbanProfileUser,
} from '../services/billing/accountStatus.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:billing')

const router = express.Router()

function toDbBool(db, value) {
  const b = Boolean(value)
  // better-sqlite3 can be strict about bound param types; use 0/1 for sqlite.
  return db?.dialect === 'postgres' ? b : b ? 1 : 0
}

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

function parseSectionData(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function resolveBillingProfileType(row) {
  const profile = {
    display_name: row.profile_name,
    primary_type: row.profile_type,
    applicant_type: row.applicant_type,
  }
  const sections = {
    basic_information: parseSectionData(row.basic_section),
    organization_details: parseSectionData(row.org_section),
  }
  const effectiveType = resolveEffectiveProfileType(profile, sections)
  return {
    profile_type: effectiveType,
    profile_type_label: getProfileTypeDisplayLabel(effectiveType),
  }
}

// PUBLIC: the canonical tier catalog (plans, capabilities, plain-English copy,
// discounts) — drives Pricing.jsx + the "What your plan includes" matrix. No
// auth: it's marketing/pricing information, and the single source of truth lives
// in shared/tierCatalog.js.
router.get('/catalog', (_req, res) => {
  res.json(fullCatalog())
})

router.use(requireAuth)

/**
 * NON-ADMIN read of a profile's billing — only for profiles the caller can
 * access. Read-only: returns the assigned tier + capabilities + the effective
 * (seat-driven, discount/pro-bono-adjusted) monthly amount, but NO mutation
 * path. Admins use the richer /accounts/:profileId. This closes the gap where
 * the Billing overview called the admin-only route and 403'd for normal users.
 */
router.get('/me/:profileId', async (req, res) => {
  try {
    const profileId = String(req.params.profileId)
    const isAdmin = req.user?.role === 'admin' || req.ctx?.isAdmin === true
    if (!isAdmin) {
      const accessible = await getAccessibleProfileIds(req.db, req.user)
      // null = admin/global; otherwise must contain this profile.
      if (accessible !== null && !accessible.has(profileId)) {
        return res.status(403).json({ error: 'Not authorized to view this profile’s billing' })
      }
    }
    await ensureInvoiceSchema(req.db)
    const accountRow = await ensureBillingAccount(req.db, profileId)
    const account = mapAccountRow(accountRow)
    const billing = await computeEffectiveBilling(req.db, profileId, account)
    // Read-only view: tier + capabilities + effective amount. (Internal fields
    // like assigned_by/assigned_reason are admin-only; omit them here.)
    res.json({
      account: {
        profile_id: account.profile_id,
        tier: account.tier,
        discount_type: account.discount_type,
        discount_percent: account.discount_percent,
        is_pro_bono: account.is_pro_bono,
        custom_monthly_cents: account.custom_monthly_cents,
        custom_hourly_cents: account.custom_hourly_cents,
      },
      billing,
      free_period: describeFreePeriod(accountRow),
      read_only: true,
    })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

async function canAccessProfile(req, profileId) {
  if (req.user?.role === 'admin' || req.ctx?.isAdmin === true) return true
  const accessible = await getAccessibleProfileIds(req.db, req.user)
  return accessible === null || accessible.has(String(profileId))
}

// USER: choose / change the billing cadence (weekly | semimonthly | monthly).
// This is the "choose at signup" control — it changes WHEN you're invoiced, not
// the amount, so the user may set it for a profile they can access.
router.put('/me/:profileId/cadence', async (req, res) => {
  try {
    const profileId = String(req.params.profileId)
    if (!(await canAccessProfile(req, profileId))) return res.status(403).json({ error: 'Not authorized' })
    const cadence = normalizeCadence(req.body?.cadence)
    if (!BILLING_CADENCES.includes(cadence)) return res.status(400).json({ error: 'invalid cadence' })
    await ensureInvoiceSchema(req.db)
    await ensureBillingAccount(req.db, profileId)
    await req.db.prepare('UPDATE billing_accounts SET billing_cadence = ? WHERE profile_id = ?').run(cadence, profileId)
    res.json({ ok: true, cadence })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// USER: acknowledge the first-login free-period notice (clears the banner).
router.post('/me/:profileId/free-notice/ack', async (req, res) => {
  try {
    const profileId = String(req.params.profileId)
    if (!(await canAccessProfile(req, profileId))) return res.status(403).json({ error: 'Not authorized' })
    const result = await acknowledgeFreeNotice(req.db, profileId)
    res.json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// USER: read-only list of their invoices.
router.get('/me/:profileId/invoices', async (req, res) => {
  try {
    const profileId = String(req.params.profileId)
    if (!(await canAccessProfile(req, profileId))) return res.status(403).json({ error: 'Not authorized' })
    await ensureInvoiceSchema(req.db)
    const rows = await req.db
      .prepare(`SELECT id, period_key, period_start, period_end, amount_cents, currency, status, issued_at, due_at, paid_at, stripe_payment_link
                  FROM billing_invoices WHERE profile_id = ? ORDER BY issued_at DESC LIMIT 100`)
      .all(profileId)
    res.json({ invoices: rows || [] })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// ADMIN: trigger the billing cycle now (generate due invoices + dunning).
router.post('/admin/run-cycle', requireAdmin, async (req, res) => {
  try {
    const result = await runBillingCycle(req.db, { force: req.body?.force === true })
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// ADMIN: set the billing anchor (when billing starts) for accounts without one.
router.post('/admin/backfill-anchor', requireAdmin, async (req, res) => {
  try {
    const anchor = req.body?.anchor ? new Date(req.body.anchor).toISOString() : new Date().toISOString()
    const result = await backfillBillingAnchor(req.db, anchor)
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// ADMIN: manually mark an invoice paid (fallback when Stripe isn't wired).
router.post('/admin/invoices/:id/mark-paid', requireAdmin, async (req, res) => {
  try {
    const result = await markInvoicePaid(req.db, { invoiceId: String(req.params.id), source: 'admin' })
    res.status(result.ok ? 200 : 404).json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// ADMIN: grant a free period (one week / one month free). The timer starts now.
// Body: { kind: 'week'|'month', scope: 'profile'|'global', profileId?, reason? }
//   - scope 'profile' (default) requires profileId.
//   - scope 'global' applies to every profile's billing account.
router.post('/admin/free/grant', requireAdmin, async (req, res) => {
  try {
    const kind = String(req.body?.kind || 'week').toLowerCase()
    if (!FREE_PERIOD_DAYS[kind]) return res.status(400).json({ error: 'kind must be "week" or "month"' })
    const scope = String(req.body?.scope || 'profile').toLowerCase()
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : null
    const grantedBy = req.user?.email ?? req.user?.userId ?? 'admin'
    if (scope === 'global') {
      const result = await grantFreePeriodGlobal(req.db, { kind, reason, grantedBy })
      return res.json(result)
    }
    const profileId = req.body?.profileId ? String(req.body.profileId) : null
    if (!profileId) return res.status(400).json({ error: 'profileId is required for scope "profile"' })
    const result = await grantFreePeriod(req.db, { profileId, kind, reason, grantedBy })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// ADMIN: revoke a free period. Body: { scope: 'profile'|'global', profileId? }
router.post('/admin/free/revoke', requireAdmin, async (req, res) => {
  try {
    const scope = String(req.body?.scope || 'profile').toLowerCase()
    if (scope === 'global') {
      const result = await revokeFreePeriod(req.db, {})
      return res.json(result)
    }
    const profileId = req.body?.profileId ? String(req.body.profileId) : null
    if (!profileId) return res.status(400).json({ error: 'profileId is required for scope "profile"' })
    const result = await revokeFreePeriod(req.db, { profileId })
    res.json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// ADMIN: manually suspend / reactivate a profile's account.
router.post('/admin/accounts/:profileId/suspend', requireAdmin, async (req, res) => {
  try {
    const by = req.user?.email ?? req.user?.userId ?? 'admin'
    const result = await suspendProfile(req.db, { profileId: String(req.params.profileId), reason: req.body?.reason || 'admin_suspend', suspendedBy: by })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.post('/admin/accounts/:profileId/reactivate', requireAdmin, async (req, res) => {
  try {
    const by = req.user?.email ?? req.user?.userId ?? 'admin'
    const result = await reactivateProfile(req.db, { profileId: String(req.params.profileId), reactivatedBy: by })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// ADMIN: ban / unban the user(s) behind a profile (routes through the owner
// blocklist so login is blocked and outreach suppression is mirrored).
router.post('/admin/accounts/:profileId/ban', requireAdmin, async (req, res) => {
  try {
    const by = req.user?.email ?? req.user?.userId ?? 'admin'
    const result = await banProfileUser(req.db, { profileId: String(req.params.profileId), reason: req.body?.reason || 'owner_ban', bannedBy: by })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.post('/admin/accounts/:profileId/unban', requireAdmin, async (req, res) => {
  try {
    const by = req.user?.email ?? req.user?.userId ?? 'admin'
    const result = await unbanProfileUser(req.db, { profileId: String(req.params.profileId), unbannedBy: by })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

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
        toDbBool(req.db, enable_pipeline_automation),
        toDbBool(req.db, enable_item_funding),
        toDbBool(req.db, enable_document_ai),
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
        toDbBool(req.db, enable_pipeline_automation),
        toDbBool(req.db, enable_item_funding),
        toDbBool(req.db, enable_document_ai),
        tierId,
      )

    const tier = await req.db.prepare('SELECT * FROM billing_tiers WHERE id = ?').get(tierId)
    res.json(mapTierRow(tier))
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Map a billing_accounts JOIN row to the API shape. Drift-safe: a row missing
// the optional profile columns must never throw here.
function mapBillingAccountRow(row) {
  let resolved = { profile_type: null, profile_type_label: null }
  try {
    resolved = resolveBillingProfileType(row)
  } catch {
    // profile-type resolution is best-effort metadata
  }
  const mapped = mapAccountRow(row)
  return {
    ...mapped,
    profile_name: row.profile_name ?? null,
    profile_type: resolved.profile_type,
    profile_type_label: resolved.profile_type_label,
    profile_status: row.profile_status ?? null,
    free_period: describeFreePeriod(mapped),
  }
}

router.get('/accounts', requireAdmin, async (req, res) => {
  // Billing reads must NEVER 500: an empty table returns [], and any schema
  // drift degrades to a resilient query rather than erroring the console.
  await ensureBillingSchema(req.db).catch((error) => {
    routeLogger.warn('[billing] ensureBillingSchema failed (continuing):', error?.message || error)
  })

  // Rich query: full tier flags + profile metadata for the admin console.
  const richQuery = req.db?.dialect === 'postgres'
    ? `SELECT ba.*, bt.name AS tier_name, bt.description AS tier_description, bt.base_monthly_cents AS tier_monthly, bt.hourly_rate_cents AS tier_hourly, bt.enable_pipeline_automation AS tier_enable_pipeline_automation, bt.enable_item_funding AS tier_enable_item_funding, bt.enable_document_ai AS tier_enable_document_ai, p.display_name AS profile_name, p.primary_type AS profile_type, p.status AS profile_status, p.applicant_type AS applicant_type, (SELECT ps.data FROM profile_sections ps WHERE ps.profile_id = p.id AND ps.section_key = 'basic_information' LIMIT 1) AS basic_section, (SELECT ps.data FROM profile_sections ps WHERE ps.profile_id = p.id AND ps.section_key = 'organization_details' LIMIT 1) AS org_section FROM billing_accounts ba LEFT JOIN billing_tiers bt ON bt.id = ba.tier_id LEFT JOIN profiles p ON p.id = ba.profile_id ORDER BY p.display_name ASC`
    : `SELECT ba.*, bt.name AS tier_name, bt.description AS tier_description, bt.base_monthly_cents AS tier_monthly, bt.hourly_rate_cents AS tier_hourly, bt.enable_pipeline_automation AS tier_enable_pipeline_automation, bt.enable_item_funding AS tier_enable_item_funding, bt.enable_document_ai AS tier_enable_document_ai, p.display_name AS profile_name, p.primary_type AS profile_type, p.status AS profile_status, p.applicant_type AS applicant_type, (SELECT ps.data FROM profile_sections ps WHERE ps.profile_id = p.id AND ps.section_key = 'basic_information' LIMIT 1) AS basic_section, (SELECT ps.data FROM profile_sections ps WHERE ps.profile_id = p.id AND ps.section_key = 'organization_details' LIMIT 1) AS org_section FROM billing_accounts ba LEFT JOIN billing_tiers bt ON bt.id = ba.tier_id LEFT JOIN profiles p ON p.id = ba.profile_id ORDER BY p.display_name COLLATE NOCASE ASC`

  try {
    const rows = await req.db.prepare(richQuery).all()
    return res.json(rows.map(mapBillingAccountRow))
  } catch (error) {
    routeLogger.warn('[billing] /accounts rich query failed; using resilient fallback:', error?.message || error)
  }

  // Resilient fallback: only base columns guaranteed by ensureBillingSchema —
  // no tier feature-flags / profile-type columns / profile_sections subqueries
  // that may have drifted. Accounts still render with their core fields.
  try {
    const fallbackQuery =
      `SELECT ba.*, bt.name AS tier_name, bt.description AS tier_description, bt.base_monthly_cents AS tier_monthly, bt.hourly_rate_cents AS tier_hourly, p.display_name AS profile_name, p.status AS profile_status FROM billing_accounts ba LEFT JOIN billing_tiers bt ON bt.id = ba.tier_id LEFT JOIN profiles p ON p.id = ba.profile_id`
    const rows = await req.db.prepare(fallbackQuery).all()
    return res.json(rows.map(mapBillingAccountRow))
  } catch (error) {
    // Last resort: never surface a 500 to the Billing console.
    routeLogger.error('[billing] /accounts fallback failed; returning empty list:', error?.message || error)
    return res.json([])
  }
})

router.get('/accounts/:profileId', requireAdmin, async (req, res) => {
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
      metadata = (() => {
        if (!accountRow.metadata) return null
        try {
          return JSON.parse(accountRow.metadata)
        } catch {
          return null
        }
      })(),
    } = req.body ?? {}

    const allowedDiscounts = new Set(['none', 'student', 'minister', 'hardship', 'custom'])
    if (!allowedDiscounts.has(discount_type ?? 'none')) {
      return res.status(400).json({ error: 'Invalid discount_type' })
    }

    const parsedDiscountPercent = typeof discount_percent === 'string' ? Number.parseFloat(discount_percent) : discount_percent
    const sanitizedDiscountPercent = Number.isFinite(parsedDiscountPercent) ? Math.max(0, parsedDiscountPercent) : 0
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
        toDbBool(req.db, is_pro_bono),
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
