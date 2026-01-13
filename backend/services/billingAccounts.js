import crypto from 'crypto'

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

export function mapAccountRow(row) {
  if (!row) return null
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
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
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

export function selectAccount(db, profileId) {
  return db
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
        JOIN billing_tiers bt ON bt.id = ba.tier_id
        WHERE ba.profile_id = ?
      `,
    )
    .get(profileId)
}

export function ensureBillingAccount(db, profileId, { defaultTier = 'foundation', assignedBy = 'system' } = {}) {
  const existing = selectAccount(db, profileId)
  if (existing) {
    return existing
  }

  const accountId = crypto.randomUUID()
  db.prepare(
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
      ) VALUES (?, ?, ?, ?, ?, 'none', 0, 0)
    `,
  ).run(accountId, profileId, defaultTier, assignedBy, 'Initial tier assignment')

  logBillingAccountEvent(db, accountId, {
    changed_by: assignedBy,
    previous_tier_id: null,
    new_tier_id: defaultTier,
    previous_discount_type: null,
    new_discount_type: 'none',
    previous_discount_percent: null,
    new_discount_percent: 0,
    previous_pro_bono: null,
    new_pro_bono: 0,
    notes: 'Account created',
  })

  return selectAccount(db, profileId)
}

export function logBillingAccountEvent(
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
  db.prepare(
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
    previous_pro_bono,
    new_pro_bono,
    notes,
  )
}

export function fetchAccountEvents(db, accountId, limit = 25) {
  return db
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
