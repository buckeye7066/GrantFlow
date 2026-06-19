import crypto from 'crypto'
import { safeParseJSON } from '../utils/safeJson.js'
import { TIERS as CATALOG_TIERS, orgTierForSeats } from '../../shared/tierCatalog.js'
import { countSeats } from './billing/seatTier.js'
import { ADMIN_EMAILS } from '../config/constants.js'

const ORG_TIER_IDS = new Set(['small_org', 'mid_size', 'large_org'])

/**
 * Resolve what a profile is actually billed per month, wiring the seat count
 * into the amount: an organization account's monthly follows its seat-derived
 * tier (1 → small, 2–5 → mid, 6+ → large), unless an admin set a custom price or
 * the account is pro bono. Discounts apply on top. Pure read — never mutates.
 */
export async function computeEffectiveBilling(db, profileId, account) {
  const tier = account?.tier || null
  const isOrgTier = tier && ORG_TIER_IDS.has(tier.id)
  let seatCount = null
  let seatTierId = null
  let baseMonthly = Number(tier?.base_monthly_cents) || 0
  let basis = 'assigned_tier'

  if (isOrgTier) {
    try {
      const rows = await db.prepare('SELECT email FROM profile_emails WHERE profile_id = ?').all(String(profileId))
      seatCount = countSeats(rows, ADMIN_EMAILS)
      const seatTier = orgTierForSeats(seatCount || 1)
      if (seatTier) { seatTierId = seatTier.id; baseMonthly = seatTier.monthly_cents; basis = 'seats' }
    } catch { /* fall back to the assigned tier price */ }
  }

  let effective = baseMonthly
  if (Number.isInteger(account?.custom_monthly_cents)) { effective = account.custom_monthly_cents; basis = 'custom_override' }
  const proBono = Boolean(account?.is_pro_bono)
  if (proBono) { effective = 0; basis = 'pro_bono' }

  const discountPct = Math.max(0, Math.min(100, Number(account?.discount_percent) || 0))
  const net = proBono ? 0 : Math.max(0, Math.round(effective * (1 - discountPct / 100)))

  return {
    basis,
    seat_count: seatCount,
    seat_tier_id: seatTierId,
    base_monthly_cents: baseMonthly,
    effective_monthly_cents: effective,
    discount_percent: discountPct,
    net_monthly_cents: net,
    is_pro_bono: proBono,
  }
}

export function mapTierRow(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    base_monthly_cents: row.base_monthly_cents,
    hourly_rate_cents: row.hourly_rate_cents,
    enable_pipeline_automation: Boolean(row.enable_pipeline_automation),
    enable_item_funding: Boolean(row.enable_item_funding),
    enable_document_ai: Boolean(row.enable_document_ai),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function ensureBillingSchema(db) {
  // Billing needs to be resilient across environments where the DB exists but migrations were not run yet.
  // We keep this scoped to billing tables only (no general auto-migration for Postgres).
  const isPostgres = db?.dialect === 'postgres'

  if (isPostgres) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS billing_tiers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        base_monthly_cents INTEGER,
        hourly_rate_cents INTEGER,
        enable_pipeline_automation BOOLEAN DEFAULT FALSE,
        enable_item_funding BOOLEAN DEFAULT FALSE,
        enable_document_ai BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS billing_accounts (
        -- IDs are provided by app code (crypto.randomUUID). Avoid requiring pgcrypto permissions here.
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        tier_id TEXT NOT NULL REFERENCES billing_tiers(id),
        assigned_by TEXT,
        assigned_reason TEXT,
        discount_type TEXT CHECK(discount_type IN ('none', 'student', 'minister', 'hardship', 'custom')),
        discount_percent DOUBLE PRECISION DEFAULT 0,
        is_pro_bono BOOLEAN DEFAULT FALSE,
        pro_bono_reason TEXT,
        custom_monthly_cents INTEGER,
        custom_hourly_cents INTEGER,
        metadata TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_accounts_profile ON billing_accounts(profile_id);
      CREATE INDEX IF NOT EXISTS idx_billing_accounts_tier ON billing_accounts(tier_id);

      CREATE TABLE IF NOT EXISTS billing_account_events (
        -- IDs are provided by app code (crypto.randomUUID). Avoid requiring pgcrypto permissions here.
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT now(),
        account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
        changed_by TEXT,
        previous_tier_id TEXT,
        new_tier_id TEXT,
        previous_discount_type TEXT,
        new_discount_type TEXT,
        previous_discount_percent DOUBLE PRECISION,
        new_discount_percent DOUBLE PRECISION,
        previous_pro_bono BOOLEAN,
        new_pro_bono BOOLEAN,
        notes TEXT
      );
    `)
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS billing_tiers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        base_monthly_cents INTEGER,
        hourly_rate_cents INTEGER,
        enable_pipeline_automation BOOLEAN DEFAULT 0,
        enable_item_funding BOOLEAN DEFAULT 0,
        enable_document_ai BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS billing_accounts (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        tier_id TEXT NOT NULL REFERENCES billing_tiers(id),
        assigned_by TEXT,
        assigned_reason TEXT,
        discount_type TEXT CHECK(discount_type IN ('none', 'student', 'minister', 'hardship', 'custom')),
        discount_percent REAL DEFAULT 0,
        is_pro_bono BOOLEAN DEFAULT 0,
        pro_bono_reason TEXT,
        custom_monthly_cents INTEGER,
        custom_hourly_cents INTEGER,
        metadata TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_accounts_profile ON billing_accounts(profile_id);
      CREATE INDEX IF NOT EXISTS idx_billing_accounts_tier ON billing_accounts(tier_id);

      CREATE TABLE IF NOT EXISTS billing_account_events (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
        changed_by TEXT,
        previous_tier_id TEXT,
        new_tier_id TEXT,
        previous_discount_type TEXT,
        new_discount_type TEXT,
        previous_discount_percent REAL,
        new_discount_percent REAL,
        previous_pro_bono BOOLEAN,
        new_pro_bono BOOLEAN,
        notes TEXT
      );
    `)
  }

  // Schema drift guard: `CREATE TABLE IF NOT EXISTS` is a no-op when an OLDER
  // billing_tiers already exists, so the feature-flag columns added later are
  // never backfilled. The GET /accounts query selects bt.enable_* and threw
  // "column does not exist" -> HTTP 500 (the Billing console "No billing
  // accounts yet" masked this). Additively ensure those columns on both dialects.
  await ensureBillingTierColumns(db, isPostgres)

  await seedBillingTiersIfMissing(db)
  await syncCanonicalOrgTierPricing(db)
}

/**
 * Give the seat-driven organization tiers their canonical monthly price on
 * environments that were seeded BEFORE the catalog priced them (they shipped at
 * $0). Only updates rows still at 0/NULL, so it never clobbers an admin's custom
 * price. Idempotent — safe to run every boot.
 */
async function syncCanonicalOrgTierPricing(db) {
  try {
    const orgTiers = CATALOG_TIERS.filter((t) => t.family === 'organization')
    for (const t of orgTiers) {
      await db
        .prepare(
          `UPDATE billing_tiers
              SET base_monthly_cents = ?
            WHERE id = ? AND (base_monthly_cents IS NULL OR base_monthly_cents = 0)`,
        )
        .run(t.monthly_cents, t.id)
    }
  } catch (err) {
    console.error('[billingAccounts] syncCanonicalOrgTierPricing failed:', err?.message ?? err)
  }
}

const BILLING_TIER_FLAG_COLUMNS = [
  'enable_pipeline_automation',
  'enable_item_funding',
  'enable_document_ai',
]

async function ensureBillingTierColumns(db, isPostgres) {
  try {
    if (isPostgres) {
      for (const col of BILLING_TIER_FLAG_COLUMNS) {
        await db.exec(`ALTER TABLE billing_tiers ADD COLUMN IF NOT EXISTS ${col} BOOLEAN DEFAULT FALSE`)
      }
      return
    }
    // SQLite has no ADD COLUMN IF NOT EXISTS — check the live schema first.
    const cols = new Set(
      (await db.prepare(`PRAGMA table_info(billing_tiers)`).all()).map((r) => r.name),
    )
    for (const col of BILLING_TIER_FLAG_COLUMNS) {
      if (!cols.has(col)) {
        await db.exec(`ALTER TABLE billing_tiers ADD COLUMN ${col} BOOLEAN DEFAULT 0`)
      }
    }
  } catch (error) {
    // Best-effort: the /accounts handler also has a resilient fallback, so a
    // failure here must never break billing reads.
    console.warn('[billing] ensureBillingTierColumns failed (non-fatal):', error?.message || error)
  }
}

export function mapAccountRow(row) {
  if (!row) return null
  const parseMetadata = (value) => {
    if (!value) return null
    if (typeof value === 'object') return value
    if (typeof value !== 'string') return null
    // Avoid throwing on legacy/corrupt values.
    try {
      return JSON.parse(value)
    } catch {
      return safeParseJSON(value, null)
    }
  }
  return {
    id: row.id,
    profile_id: row.profile_id,
    tier_id: row.tier_id,
    assigned_by: row.assigned_by,
    assigned_reason: row.assigned_reason,
    discount_type: row.discount_type ?? 'none',
    discount_percent: row.discount_percent ?? 0,
    is_pro_bono: Boolean(row.is_pro_bono),
    pro_bono_reason: row.pro_bono_reason,
    custom_monthly_cents: row.custom_monthly_cents,
    custom_hourly_cents: row.custom_hourly_cents,
    metadata: parseMetadata(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    tier: row.tier_name
      ? {
          id: row.tier_id,
          name: row.tier_name,
          description: row.tier_description,
          base_monthly_cents: row.tier_monthly,
          hourly_rate_cents: row.tier_hourly,
          enable_pipeline_automation: Boolean(row.tier_enable_pipeline_automation),
          enable_item_funding: Boolean(row.tier_enable_item_funding),
          enable_document_ai: Boolean(row.tier_enable_document_ai),
        }
      : null,
  }
}

export async function selectAccount(db, profileId) {
  return await db
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
          bt.enable_document_ai AS tier_enable_document_ai
        FROM billing_accounts ba
        LEFT JOIN billing_tiers bt ON bt.id = ba.tier_id
        WHERE ba.profile_id = ?
      `,
    )
    .get(profileId)
}

async function seedBillingTiersIfMissing(db) {
  // Seed the minimum tiers so billing endpoints don't 500.
  // This is intentionally idempotent.
  try {
    const rows = await db.prepare('SELECT COUNT(*) as c FROM billing_tiers').get()
    const count = rows?.c ?? 0
    if (count > 0) return
  } catch {
    // billing_tiers table might not exist yet; ignore and let schema migration handle it
    return
  }

  try {
    const insertSql =
      db?.dialect === 'postgres'
        ? `
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
            ON CONFLICT (id) DO NOTHING
          `
        : `
            INSERT OR IGNORE INTO billing_tiers (
              id,
              name,
              description,
              base_monthly_cents,
              hourly_rate_cents,
              enable_pipeline_automation,
              enable_item_funding,
              enable_document_ai
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `

    const insert = db.prepare(insertSql)
    const toDbBool = (value) => (db?.dialect === 'postgres' ? value : value ? 1 : 0)

    // Seed every tier straight from the canonical catalog (shared/tierCatalog.js)
    // so billing_tiers can never drift from the single source of truth.
    for (const t of CATALOG_TIERS) {
      await insert.run(
        t.id,
        t.name,
        t.summary,
        t.monthly_cents,
        t.hourly_cents,
        toDbBool(t.capabilities.enable_pipeline_automation),
        toDbBool(t.capabilities.enable_item_funding),
        toDbBool(t.capabilities.enable_document_ai),
      )
    }
  } catch (err) {
    // Log the failure so operators can diagnose billing tier seed issues.
    console.error('[billingAccounts] seedBillingTiersIfMissing: failed to insert seed tiers:', err?.message ?? err)
  }
}

async function resolveTierIdForInsert(db, requestedTierId) {
  const tierExists = await db.prepare('SELECT id FROM billing_tiers WHERE id = ?').get(requestedTierId)
  if (tierExists) return requestedTierId

  // Try seeding, then re-check.
  await seedBillingTiersIfMissing(db)
  const tierExistsAfterSeed = await db.prepare('SELECT id FROM billing_tiers WHERE id = ?').get(requestedTierId)
  if (tierExistsAfterSeed) return requestedTierId

  // Fall back to any available tier so billing account creation never writes a dangling tier_id.
  const fallback = await db
    .prepare(
      `
        SELECT id
        FROM billing_tiers
        ORDER BY base_monthly_cents IS NULL, base_monthly_cents ASC, name ASC
        LIMIT 1
      `,
    )
    .get()
  if (fallback?.id) return fallback.id

  throw new Error(
    `Billing tiers are missing: requested tier '${requestedTierId}' not found and no fallback tier exists. Run DB migrations/seed to populate billing_tiers.`,
  )
}

export async function ensureBillingAccount(db, profileId, { defaultTier = 'foundation', assignedBy = 'system' } = {}) {
  await ensureBillingSchema(db)
  const existing = await selectAccount(db, profileId)
  if (existing) {
    return existing
  }

  const tierId = await resolveTierIdForInsert(db, defaultTier)
  const accountId = crypto.randomUUID()
  await db.prepare(
    `
      INSERT INTO billing_accounts (
        id,
        profile_id,
        tier_id,
        assigned_by,
        assigned_reason,
        discount_type,
        discount_percent,
        is_pro_bono
      ) VALUES (?, ?, ?, ?, ?, 'none', 0, FALSE)
    `,
  ).run(accountId, profileId, tierId, assignedBy, 'Initial tier assignment')

  await logBillingAccountEvent(db, accountId, {
    changed_by: assignedBy,
    previous_tier_id: null,
    new_tier_id: tierId,
    previous_discount_type: null,
    new_discount_type: 'none',
    previous_discount_percent: null,
    new_discount_percent: 0,
    previous_pro_bono: null,
    new_pro_bono: false,
    notes: 'Account created',
  })

  return await selectAccount(db, profileId)
}

export async function logBillingAccountEvent(
  db,
  accountId,
  {
    changed_by = 'system',
    previous_tier_id = null,
    new_tier_id = null,
    previous_discount_type = null,
    new_discount_type = null,
    previous_discount_percent = null,
    new_discount_percent = null,
    previous_pro_bono = null,
    new_pro_bono = null,
    notes = null,
  },
) {
  const toDbBool = (value) => {
    if (value === undefined || value === null) return null
    const b = Boolean(value)
    // better-sqlite3 does NOT accept booleans as bound params; use 0/1.
    return db?.dialect === 'postgres' ? b : b ? 1 : 0
  }

  await db.prepare(
    `
      INSERT INTO billing_account_events (
        id,
        account_id,
        changed_by,
        previous_tier_id,
        new_tier_id,
        previous_discount_type,
        new_discount_type,
        previous_discount_percent,
        new_discount_percent,
        previous_pro_bono,
        new_pro_bono,
        notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    crypto.randomUUID(),
    accountId,
    changed_by,
    previous_tier_id,
    new_tier_id,
    previous_discount_type,
    new_discount_type,
    previous_discount_percent,
    new_discount_percent,
    toDbBool(previous_pro_bono),
    toDbBool(new_pro_bono),
    notes,
  )
}

export async function fetchAccountEvents(db, accountId, limit = 25) {
  return await db
    .prepare(
      `
        SELECT *
        FROM billing_account_events
        WHERE account_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(accountId, limit)
}
