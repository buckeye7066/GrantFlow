import crypto from 'crypto'
import { safeParseJSON } from '../utils/safeJson.js'

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

    // Product tiers (existing UI expectations)
    await insert.run(
      'foundation',
      'Foundation',
      'Baseline research support with curated grant discovery and shared AI document enrichment.',
      0,
      0,
      toDbBool(false),
      toDbBool(true),
      toDbBool(true),
    )
    await insert.run(
      'growth',
      'Growth',
      'Expanded automation, itemized funding intelligence, and AI-supported document ingestion.',
      9900,
      15000,
      toDbBool(true),
      toDbBool(true),
      toDbBool(true),
    )
    await insert.run(
      'enterprise',
      'Enterprise',
      'Full-service concierge with custom automation rules and dedicated analyst support.',
      24900,
      22500,
      toDbBool(true),
      toDbBool(true),
      toDbBool(true),
    )

    // Client category tiers (from your service menu / payment sheet)
    await insert.run(
      'individual',
      'Individual',
      'Individuals/families seeking assistance.',
      0,
      8500,
      toDbBool(false),
      toDbBool(true),
      toDbBool(true),
    )
    await insert.run(
      'small_org',
      'Small Org',
      'Annual budget under $250,000.',
      0,
      8500,
      toDbBool(false),
      toDbBool(true),
      toDbBool(true),
    )
    await insert.run(
      'mid_size',
      'Mid-Size',
      'Annual budget $250,000 - $2,000,000.',
      0,
      11500,
      toDbBool(true),
      toDbBool(true),
      toDbBool(true),
    )
    await insert.run(
      'large_org',
      'Large Org',
      'Annual budget over $2,000,000.',
      0,
      15000,
      toDbBool(true),
      toDbBool(true),
      toDbBool(true),
    )
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
