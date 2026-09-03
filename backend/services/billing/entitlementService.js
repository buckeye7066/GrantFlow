import { randomUUID } from 'node:crypto'
import { CAPABILITY_KEYS } from '../../../shared/tierCatalog.js'
import { computeEffectiveBilling, ensureBillingAccount, mapAccountRow } from '../billingAccounts.js'
import { tierById } from '../../../shared/tierCatalog.js'
import { isFreeWeekActive } from '../../../shared/freeWeek.js'
import { decideBillingEntitlement } from './entitlementDecision.js'

const CAPABILITIES = Object.freeze(Object.values(CAPABILITY_KEYS))
const CAPABILITY_SET = new Set(CAPABILITIES)
const ADDON_SOURCES = new Set(['admin', 'stripe', 'service_purchase', 'promotion', 'migration'])

function asLower(value) {
  return String(value || '').trim().toLowerCase()
}

function asIso(value, { future = false, now = new Date() } = {}) {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    const error = new Error('invalid_timestamp')
    error.code = 'invalid_timestamp'
    error.status = 400
    throw error
  }
  if (future && date.getTime() <= now.getTime()) {
    const error = new Error('expiration_must_be_future')
    error.code = 'expiration_must_be_future'
    error.status = 400
    throw error
  }
  return date.toISOString()
}

function encodeMetadata(db, value) {
  if (value === null || value === undefined) return null
  const safe = typeof value === 'object' ? value : { value: String(value) }
  return JSON.stringify(safe)
}

function decodeMetadata(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

export function publicBillingAddon(row) {
  if (!row) return null
  return {
    id: row.id,
    capability_key: row.capability_key,
    source: row.source,
    starts_at: row.starts_at ?? null,
    expires_at: row.expires_at ?? null,
  }
}

function changesOf(result) {
  const count = Number(result?.changes ?? result?.rowCount ?? 0)
  return Number.isFinite(count) ? count : 0
}

export function assertCapabilityKey(capabilityKey) {
  const key = String(capabilityKey || '').trim()
  if (!CAPABILITY_SET.has(key)) {
    const error = new Error('unknown_capability')
    error.code = 'unknown_capability'
    error.status = 400
    throw error
  }
  return key
}

async function readProfileState(db, profileId) {
  return await db.prepare('SELECT id, status FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
}

async function readPaymentAccessStatus(db, profileId) {
  const row = await db.prepare(
    'SELECT access_status FROM profile_pricing WHERE profile_id = ? LIMIT 1',
  ).get(String(profileId))
  // A missing ROW is allowed for profiles that predate quote-based onboarding;
  // a failed QUERY is not. Let query/schema failures reach the resolver's
  // fail-closed `entitlement_authority_unavailable` result.
  return row?.access_status || null
}

export async function listActiveBillingAddons(db, profileId, { now = new Date() } = {}) {
  const rows = await db.prepare(`
    SELECT *
      FROM billing_addon_entitlements
     WHERE profile_id = ?
       AND status = 'active'
       AND (starts_at IS NULL OR starts_at <= ?)
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at ASC
  `).all(String(profileId), now.toISOString(), now.toISOString())
  return (rows || []).map((row) => ({ ...row, metadata: decodeMetadata(row.metadata) }))
}

export async function listBillingAddons(db, profileId, { includeInactive = false, now = new Date() } = {}) {
  try {
    const rows = includeInactive
      ? await db.prepare(`
          SELECT *
            FROM billing_addon_entitlements
           WHERE profile_id = ?
           ORDER BY created_at DESC
        `).all(String(profileId))
      : await db.prepare(`
          SELECT *
            FROM billing_addon_entitlements
           WHERE profile_id = ?
             AND status = 'active'
             AND (starts_at IS NULL OR starts_at <= ?)
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY created_at DESC
        `).all(String(profileId), now.toISOString(), now.toISOString())
    return (rows || []).map((row) => ({ ...row, metadata: decodeMetadata(row.metadata) }))
  } catch (error) {
    error.code = error.code || 'billing_addon_ledger_unavailable'
    throw error
  }
}

async function loadEntitlementAuthority(db, profileId, now) {
  const profile = await readProfileState(db, profileId)
  if (!profile) return { profile: null }
  const [accountRow, paymentAccessStatus, activeAddons] = await Promise.all([
    ensureBillingAccount(db, profileId),
    readPaymentAccessStatus(db, profileId),
    listActiveBillingAddons(db, profileId, { now }),
  ])
  const account = mapAccountRow(accountRow)
  const effectiveBilling = await computeEffectiveBilling(db, profileId, account)
  const effectiveTier = tierById(effectiveBilling?.tier_id)
  const freeUntilMs = Date.parse(account?.free_until || '')
  const freePeriodActive = Number.isFinite(freeUntilMs) && freeUntilMs > now.getTime()
  const promotionActive = isFreeWeekActive(process.env) || freePeriodActive
  const requiresPayment = Number(effectiveBilling?.net_monthly_cents || 0) > 0 && !promotionActive

  return {
    profile,
    account,
    effectiveBilling,
    effectiveTier,
    paymentAccessStatus,
    activeAddons,
    promotionActive,
    requiresPayment,
  }
}

export function buildEntitlementDecisionInput(authority, key) {
  // An active promotion/free period removes the payment prerequisite for its
  // duration. New profiles commonly still carry pending_agreement or
  // pending_payment in profile_pricing; passing that stale workflow state into
  // decideBillingEntitlement() would reject before the promotion grant is
  // evaluated. Profile suspension/blocked status remains a separate, earlier
  // fail-closed check in the decision function.
  const paymentAccessStatus = authority?.promotionActive === true && authority?.requiresPayment === false
    ? null
    : authority?.requiresPayment && !authority?.paymentAccessStatus
      ? 'not_active'
      : authority?.paymentAccessStatus
  return {
    paymentAccessStatus,
    input: {
      profileStatus: authority?.profile?.status,
      paymentAccessStatus,
      tierAllows: authority?.effectiveTier?.capabilities?.[key] === true,
      activeAddons: authority?.activeAddons || [],
      promotionActive: authority?.promotionActive === true,
      capabilityKey: key,
    },
  }
}

function decisionFromAuthority(profileId, key, authority) {
  if (!authority.profile) {
    return { profile_id: String(profileId), capability: key, allowed: false, source: null, reason: 'profile_not_found' }
  }
  // Access and invoicing must consult the SAME effective tier. Previously the
  // invoice used the profile-type/budget tier while this gate used the manually
  // assigned billing_accounts tier, so a profile could be charged for one plan
  // and receive another plan's capabilities.
  const { paymentAccessStatus, input } = buildEntitlementDecisionInput(authority, key)
  const decision = decideBillingEntitlement(input)
  return {
    profile_id: String(profileId),
    capability: key,
    tier_id: authority.effectiveTier?.id || authority.effectiveBilling?.tier_id || null,
    assigned_tier_id: authority.account?.tier?.id || authority.account?.tier_id || null,
    billing_basis: authority.effectiveBilling?.basis || null,
    profile_status: authority.profile.status || null,
    payment_access_status: paymentAccessStatus,
    active_addons: authority.activeAddons
      .filter((row) => row.capability_key === key)
      .map(publicBillingAddon),
    ...decision,
  }
}

function unavailableDecision(profileId, key) {
  return {
    profile_id: profileId ? String(profileId) : null,
    capability: key,
    allowed: false,
    source: null,
    reason: 'entitlement_authority_unavailable',
    unavailable: true,
  }
}

export async function resolveProfileEntitlement(db, {
  profileId,
  capabilityKey,
  isAdmin = false,
  now = new Date(),
} = {}) {
  const key = assertCapabilityKey(capabilityKey)
  if (isAdmin === true) {
    return { profile_id: profileId || null, capability: key, allowed: true, source: 'admin', reason: null }
  }
  if (!db || !profileId) {
    return unavailableDecision(profileId, key)
  }
  try {
    const authority = await loadEntitlementAuthority(db, profileId, now)
    return decisionFromAuthority(profileId, key, authority)
  } catch {
    return unavailableDecision(profileId, key)
  }
}

export async function resolveAllProfileEntitlements(db, args = {}) {
  const profileId = args.profileId || null
  let decisions
  if (args.isAdmin === true) {
    decisions = CAPABILITIES.map((capability) => ({
      profile_id: profileId,
      capability,
      allowed: true,
      source: 'admin',
      reason: null,
    }))
  } else if (!db || !profileId) {
    decisions = CAPABILITIES.map((capability) => unavailableDecision(profileId, capability))
  } else {
    try {
      const authority = await loadEntitlementAuthority(db, profileId, args.now || new Date())
      decisions = CAPABILITIES.map((capability) => decisionFromAuthority(profileId, capability, authority))
    } catch {
      decisions = CAPABILITIES.map((capability) => unavailableDecision(profileId, capability))
    }
  }
  return {
    profile_id: profileId,
    capabilities: Object.fromEntries(decisions.map((decision) => [decision.capability, decision])),
    allowed: decisions.filter((decision) => decision.allowed).map((decision) => decision.capability),
    locked: decisions.filter((decision) => !decision.allowed).map((decision) => decision.capability),
  }
}

async function insertEntitlementEvent(db, { profileId, entitlementId, eventType, capabilityKey, actor, details }) {
  await db.prepare(`
    INSERT INTO billing_entitlement_events
      (id, profile_id, entitlement_id, event_type, capability_key, actor, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    String(profileId),
    entitlementId ? String(entitlementId) : null,
    String(eventType),
    String(capabilityKey),
    actor ? String(actor) : null,
    encodeMetadata(db, details),
  )
}

async function withBillingTransaction(db, work) {
  if (typeof db?.withTransaction === 'function') {
    return db.withTransaction((tx) => work(tx || db))
  }
  if (db?.dialect === 'sqlite' && typeof db?.exec === 'function') {
    await db.exec('BEGIN IMMEDIATE')
    try {
      const result = await work(db)
      await db.exec('COMMIT')
      return result
    } catch (error) {
      try { await db.exec('ROLLBACK') } catch { /* preserve the original error */ }
      throw error
    }
  }
  const error = new Error('billing_entitlement_transaction_unavailable')
  error.code = 'billing_entitlement_transaction_unavailable'
  error.status = 503
  throw error
}

export async function grantBillingAddon(db, {
  profileId,
  capabilityKey,
  source = 'admin',
  sourceReference = null,
  startsAt = null,
  expiresAt = null,
  grantedBy = null,
  reason = null,
  metadata = null,
  now = new Date(),
} = {}) {
  const key = assertCapabilityKey(capabilityKey)
  const normalizedSource = asLower(source) || 'admin'
  if (!ADDON_SOURCES.has(normalizedSource)) {
    const error = new Error('invalid_addon_source')
    error.code = 'invalid_addon_source'
    error.status = 400
    throw error
  }
  const profile = await readProfileState(db, profileId)
  if (!profile) {
    const error = new Error('profile_not_found')
    error.code = 'profile_not_found'
    error.status = 404
    throw error
  }
  const start = asIso(startsAt, { now }) || now.toISOString()
  const expiry = asIso(expiresAt, { future: true, now })
  const id = randomUUID()
  try {
    return await withBillingTransaction(db, async (tx) => {
      await tx.prepare(`
        INSERT INTO billing_addon_entitlements
          (id, profile_id, capability_key, status, source, source_reference,
           starts_at, expires_at, granted_by, reason, metadata, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        String(profileId),
        key,
        normalizedSource,
        sourceReference ? String(sourceReference) : null,
        start,
        expiry,
        grantedBy ? String(grantedBy) : null,
        reason ? String(reason).slice(0, 500) : null,
        encodeMetadata(tx, metadata),
        now.toISOString(),
      )
      await insertEntitlementEvent(tx, {
        profileId,
        entitlementId: id,
        eventType: 'granted',
        capabilityKey: key,
        actor: grantedBy,
        details: { source: normalizedSource, source_reference: sourceReference, starts_at: start, expires_at: expiry, reason },
      })
      const entitlement = await tx.prepare('SELECT * FROM billing_addon_entitlements WHERE id = ?').get(id)
      return { created: true, entitlement: { ...entitlement, metadata: decodeMetadata(entitlement?.metadata) } }
    })
  } catch (error) {
    if (!sourceReference) throw error
    const existing = await db.prepare(`
      SELECT * FROM billing_addon_entitlements
       WHERE profile_id = ? AND capability_key = ? AND source = ? AND source_reference = ?
       LIMIT 1
    `).get(String(profileId), key, normalizedSource, String(sourceReference))
    if (!existing) throw error
    return { created: false, entitlement: { ...existing, metadata: decodeMetadata(existing.metadata) } }
  }
}

export async function revokeBillingAddon(db, {
  profileId,
  entitlementId,
  revokedBy = null,
  reason = null,
  now = new Date(),
} = {}) {
  return await withBillingTransaction(db, async (tx) => {
    const row = await tx.prepare(`
      SELECT * FROM billing_addon_entitlements
       WHERE id = ? AND profile_id = ? LIMIT 1
    `).get(String(entitlementId), String(profileId))
    if (!row) return { revoked: false, reason: 'not_found' }
    if (row.status !== 'active') return { revoked: false, reason: 'not_active', entitlement: row }
    const result = await tx.prepare(`
      UPDATE billing_addon_entitlements
         SET status = 'revoked', revoked_at = ?, revoked_by = ?, reason = COALESCE(?, reason), updated_at = ?
       WHERE id = ? AND profile_id = ? AND status = 'active'
    `).run(
      now.toISOString(),
      revokedBy ? String(revokedBy) : null,
      reason ? String(reason).slice(0, 500) : null,
      now.toISOString(),
      String(entitlementId),
      String(profileId),
    )
    if (changesOf(result) !== 1) return { revoked: false, reason: 'concurrent_change' }
    await insertEntitlementEvent(tx, {
      profileId,
      entitlementId,
      eventType: 'revoked',
      capabilityKey: row.capability_key,
      actor: revokedBy,
      details: { reason },
    })
    return { revoked: true, entitlement_id: String(entitlementId) }
  })
}

export { CAPABILITIES as BILLING_CAPABILITIES }
export { decideBillingEntitlement } from './entitlementDecision.js'
