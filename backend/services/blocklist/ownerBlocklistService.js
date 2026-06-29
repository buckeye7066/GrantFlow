/**
 * Owner Blocklist — the single canonical denylist for GrantFlow.
 *
 * The OWNER feeds this list from three sources:
 *   - their phone's blocked-number list   (pushed by a Tasker profile)
 *   - their Gmail blocked senders/filters  (pushed by a Google Apps Script,
 *     or pulled server-side when Gmail OAuth is configured)
 *   - manual admin entries                 (names / organizations / domains)
 *
 * A single match here is enforced in three independent places:
 *   1. Auth        — a blocked email/phone cannot start an account, log in, or
 *                    verify a code; an existing account is marked `banned`.
 *   2. Inbound     — a blocked email/phone is rejected at contact intake.
 *   3. Outreach    — email/domain/phone/organization entries are MIRRORED into
 *                    the John + Yana suppression lists those agents already
 *                    honor before contacting anyone, so we inherit their
 *                    enforcement without touching their pipelines.
 *
 * Lookups are dialect-safe (sqlite + postgres) and use SELECT-then-INSERT for
 * idempotency so a duplicate never poisons a Postgres transaction.
 */

import { randomUUID } from 'node:crypto'

import { addSuppression as addJohnSuppression } from '../john/johnSuppressionService.js'
import { addSuppressionEntry as addYanaOutreachSuppression } from '../yanaOutreach/yanaOutreachRunStore.js'

/** Canonical match types. Exact types are indexed; fuzzy types are scanned. */
export const MATCH_TYPE = Object.freeze({
  EMAIL: 'email',
  DOMAIN: 'domain',
  PHONE: 'phone',
  LAST_NAME: 'last_name',
  ORGANIZATION: 'organization',
  NAME: 'name',
})

export const ALL_MATCH_TYPES = Object.freeze(Object.values(MATCH_TYPE))

/** Exact, indexable lookups vs. fuzzy (substring/token) scans. */
const EXACT_TYPES = new Set([MATCH_TYPE.EMAIL, MATCH_TYPE.DOMAIN, MATCH_TYPE.PHONE])
const FUZZY_TYPES = new Set([MATCH_TYPE.LAST_NAME, MATCH_TYPE.ORGANIZATION, MATCH_TYPE.NAME])

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function collapse(s) {
  return String(s || '').trim().replace(/\s+/g, ' ')
}

/** Digits-only; US canonical = last 10 digits so formatting/country code don't matter. */
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (!digits) return ''
  return digits.length > 10 ? digits.slice(-10) : digits
}

function emailDomain(email) {
  const at = String(email || '').lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1).toLowerCase().trim() : ''
}

/** Normalize a value for storage + lookup, by match type. */
export function normalizeValue(matchType, value) {
  const v = collapse(value)
  if (!v) return ''
  switch (matchType) {
    case MATCH_TYPE.EMAIL:
      return v.toLowerCase()
    case MATCH_TYPE.DOMAIN:
      // Accept either a bare domain or a full address.
      return (v.includes('@') ? emailDomain(v) : v.toLowerCase()).replace(/^@/, '')
    case MATCH_TYPE.PHONE:
      return normalizePhone(v)
    case MATCH_TYPE.LAST_NAME:
    case MATCH_TYPE.ORGANIZATION:
    case MATCH_TYPE.NAME:
      return v.toLowerCase()
    default:
      return v
  }
}

// ---------------------------------------------------------------------------
// Fuzzy matching — THE tunable business-logic decision (see docs/OWNER_BLOCKLIST.md)
// ---------------------------------------------------------------------------

/**
 * Decide whether a fuzzy blocklist rule matches a subject's identity.
 *
 * This is intentionally the one piece with real trade-offs:
 *   - too loose  -> false positives (you block an unrelated person named Kemper)
 *   - too strict -> misses ("McMinnville EMS" vs "McMinnville Emergency Medical")
 *
 * Defaults below:
 *   last_name      -> token match: any word in the subject's name OR org equals
 *                     the surname (so "Dana Kemper" and "Kemper & Assoc" match,
 *                     but "Kemperton" does NOT).
 *   organization   -> bidirectional substring containment on normalized text
 *                     ("mcminnville ems" matches "mcminnville ems department").
 *   name           -> exact normalized equality.
 *
 * @param {{match_type:string, match_value:string}} rule
 * @param {{name?:string, organization?:string}} subject  already-lowercased? no — raw
 * @returns {boolean}
 */
export function fuzzyRuleMatches(rule, subject) {
  const ruleVal = rule.match_value // already normalized (lowercased) at store time
  const name = String(subject.name || '').toLowerCase()
  const org = String(subject.organization || '').toLowerCase()

  if (rule.match_type === MATCH_TYPE.LAST_NAME) {
    const tokens = `${name} ${org}`.split(/[^a-z0-9]+/i).filter(Boolean)
    return tokens.includes(ruleVal)
  }
  if (rule.match_type === MATCH_TYPE.ORGANIZATION) {
    if (!org) return false
    const a = org.replace(/\s+/g, ' ').trim()
    const b = ruleVal.replace(/\s+/g, ' ').trim()
    if (!a || !b) return false
    return a.includes(b) || b.includes(a)
  }
  if (rule.match_type === MATCH_TYPE.NAME) {
    return !!name && name.replace(/\s+/g, ' ').trim() === ruleVal
  }
  return false
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function fetchByExact(db, matchType, value) {
  const v = normalizeValue(matchType, value)
  if (!v) return null
  try {
    return await db
      .prepare(`SELECT * FROM owner_blocklist WHERE match_type = ? AND match_value = ? LIMIT 1`)
      .get(matchType, v)
  } catch {
    return null // table not migrated yet — fail open for reads
  }
}

let _fuzzyCache = { at: 0, rows: null }
async function loadFuzzyRules(db) {
  // The fuzzy set (surnames/orgs/names) is tiny; cache briefly to avoid a scan
  // on every auth hit. Cache is per-process and best-effort.
  const now = Date.now()
  if (_fuzzyCache.rows && now - _fuzzyCache.at < 30_000) return _fuzzyCache.rows
  let rows = []
  try {
    rows = await db
      .prepare(
        `SELECT * FROM owner_blocklist WHERE match_type IN ('last_name','organization','name')`,
      )
      .all()
  } catch {
    rows = []
  }
  _fuzzyCache = { at: now, rows: rows || [] }
  return _fuzzyCache.rows
}

/** Invalidate the fuzzy cache after a write. */
function bustFuzzyCache() {
  _fuzzyCache = { at: 0, rows: null }
}

/**
 * Check an identity against the blocklist.
 * @returns {Promise<{blocked:boolean, enforcement:string|null, matches:Array}>}
 */
export async function checkIdentity(db, { email, phone, name, organization, lastName } = {}) {
  const matches = []

  // Exact, indexed lookups.
  if (email) {
    const row = await fetchByExact(db, MATCH_TYPE.EMAIL, email)
    if (row) matches.push(row)
    const dom = emailDomain(email)
    if (dom) {
      const drow = await fetchByExact(db, MATCH_TYPE.DOMAIN, dom)
      if (drow) matches.push(drow)
    }
  }
  if (phone) {
    const row = await fetchByExact(db, MATCH_TYPE.PHONE, phone)
    if (row) matches.push(row)
  }

  // Fuzzy scan (surnames / orgs / full names).
  const subject = {
    name: name || '',
    organization: organization || '',
  }
  if (lastName) subject.name = `${subject.name} ${lastName}`.trim()
  if (subject.name || subject.organization) {
    const rules = await loadFuzzyRules(db)
    for (const rule of rules) {
      if (fuzzyRuleMatches(rule, subject)) matches.push(rule)
    }
  }

  // `block` wins over `audit` if any blocking rule matched.
  const blocking = matches.filter((m) => (m.enforcement || 'block') === 'block')
  return {
    blocked: blocking.length > 0,
    enforcement: matches.length ? (blocking.length ? 'block' : 'audit') : null,
    matches,
  }
}

export async function listEntries(db, { limit = 500 } = {}) {
  const lim = Math.max(1, Math.min(5000, Number(limit) || 500))
  try {
    const rows = await db
      .prepare(`SELECT * FROM owner_blocklist ORDER BY created_at DESC LIMIT ?`)
      .all(lim)
    return rows || []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Mirror an entry into the John + Yana suppression lists (outreach enforcement). */
async function mirrorToOutreach(db, { matchType, value, reason }) {
  const johnType = { email: 'email', domain: 'domain', phone: 'phone', organization: 'organization' }[
    matchType
  ]
  if (!johnType) return // last_name / name have no outreach-suppression analogue
  try {
    await addJohnSuppression(db, { type: johnType, value, reason, source: 'owner_blocklist' })
  } catch (err) {
    console.warn('[ownerBlocklist] John mirror failed:', err?.message || err)
  }
  try {
    await addYanaOutreachSuppression(db, { identifier_type: johnType, identifier_value: value, reason })
  } catch (err) {
    console.warn('[ownerBlocklist] Yana mirror failed:', err?.message || err)
  }
}

/**
 * Add (or no-op upsert) a blocklist entry. SELECT-then-INSERT keeps Postgres
 * transactions safe. Mirrors email/domain/phone/org into outreach suppression.
 */
export async function addEntry(
  db,
  { match_type, value, reason = null, source = 'manual', enforcement = 'block', added_by_user_id = null } = {},
) {
  if (!ALL_MATCH_TYPES.includes(match_type)) {
    const err = new Error(`Unknown blocklist match_type: ${match_type}`)
    err.code = 'BLOCKLIST_INVALID_TYPE'
    throw err
  }
  const v = normalizeValue(match_type, value)
  if (!v) {
    const err = new Error('Blocklist value cannot be empty')
    err.code = 'BLOCKLIST_EMPTY_VALUE'
    throw err
  }
  const enf = enforcement === 'audit' ? 'audit' : 'block'

  const existing = await db
    .prepare(`SELECT id FROM owner_blocklist WHERE match_type = ? AND match_value = ? LIMIT 1`)
    .get(match_type, v)

  if (!existing) {
    const id = randomUUID()
    await db
      .prepare(
        `INSERT INTO owner_blocklist
           (id, match_type, match_value, match_value_raw, reason, source, enforcement, added_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, match_type, v, collapse(value), reason, source, enf, added_by_user_id)
    bustFuzzyCache()
  }

  if (enf === 'block') {
    await mirrorToOutreach(db, { matchType: match_type, value: v, reason: reason || 'owner_blocklist' })
  }
  return { ok: true, match_type, value: v, created: !existing }
}

export async function removeEntry(db, { match_type, value } = {}) {
  const v = normalizeValue(match_type, value)
  if (!v) return { ok: false }
  await db.prepare(`DELETE FROM owner_blocklist WHERE match_type = ? AND match_value = ?`).run(match_type, v)
  bustFuzzyCache()
  return { ok: true }
}

/** Record an enforcement hit for audit. Best-effort; never throws. */
export async function recordHit(db, { match, context, subject = {} } = {}) {
  try {
    await db
      .prepare(
        `INSERT INTO owner_blocklist_hits
           (id, blocklist_id, match_type, match_value, context, subject_email, subject_phone,
            subject_name, subject_organization, enforcement)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        match?.id || null,
        match?.match_type || null,
        match?.match_value || null,
        context || null,
        subject.email || null,
        subject.phone || null,
        subject.name || null,
        subject.organization || null,
        match?.enforcement || 'block',
      )
  } catch (err) {
    console.warn('[ownerBlocklist] recordHit failed (non-fatal):', err?.message || err)
  }
}

/** Mark an existing account as banned. Best-effort; safe before migration. */
export async function markUserBlockedByEmail(db, email, reason) {
  const e = normalizeValue(MATCH_TYPE.EMAIL, email)
  if (!e) return
  try {
    await db
      .prepare(
        `UPDATE users SET status = 'banned', blocked_reason = ?, blocked_at = CURRENT_TIMESTAMP
         WHERE LOWER(primary_email) = ?`,
      )
      .run(reason || 'owner_blocklist', e)
  } catch (err) {
    // Column may not exist yet (pre-migration) — the auth block still applies.
    console.warn('[ownerBlocklist] markUserBlockedByEmail skipped:', err?.message || err)
  }
}

/**
 * Convenience for auth/inbound hooks: check, and if blocked, record the hit and
 * (optionally) mark the account banned. Returns the same shape as checkIdentity.
 */
export async function enforce(db, subject, { context, banAccount = false } = {}) {
  const result = await checkIdentity(db, subject)
  if (result.blocked) {
    const primary = result.matches.find((m) => (m.enforcement || 'block') === 'block')
    await recordHit(db, { match: primary, context, subject })
    if (banAccount && subject.email) {
      await markUserBlockedByEmail(db, subject.email, `owner_blocklist:${primary?.match_type || 'match'}`)
    }
  }
  return result
}

/** Seed entries the owner always wants blocked. Idempotent. */
export const SEED_ENTRIES = Object.freeze([
  { match_type: 'last_name', value: 'Kemper', reason: 'Owner blocklist — surname' },
  { match_type: 'organization', value: "Van Buren County Sheriff's Office", reason: 'Owner blocklist — organization' },
  { match_type: 'organization', value: 'Van Buren County Government', reason: 'Owner blocklist — organization' },
  { match_type: 'organization', value: 'McMinnville Fire Department', reason: 'Owner blocklist — organization' },
  { match_type: 'organization', value: 'McMinnville EMS', reason: 'Owner blocklist — organization' },
])

export async function ensureSeedEntries(db) {
  for (const entry of SEED_ENTRIES) {
    await addEntry(db, { ...entry, source: 'seed' })
  }
  return { ok: true, seeded: SEED_ENTRIES.length }
}
