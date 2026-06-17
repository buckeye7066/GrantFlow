/**
 * John — global suppression list.
 *
 * Stored in `john_suppression_list`. Lookups are exact-match against
 * lower-cased values for emails / domains / phones, and trim+lowercase for
 * organization names. The agent calls `isSuppressed(...)` before composing
 * any draft.
 */

import { ALL_SUPPRESSION_TYPES, SUPPRESSION_TYPE } from './johnTypes.js'

function normaliseValue(type, value) {
  const v = String(value || '').trim()
  if (!v) return ''
  if (
    type === SUPPRESSION_TYPE.EMAIL ||
    type === SUPPRESSION_TYPE.DOMAIN ||
    type === SUPPRESSION_TYPE.ORGANIZATION
  ) {
    return v.toLowerCase()
  }
  if (type === SUPPRESSION_TYPE.PHONE) {
    return v.replace(/[^0-9+]/g, '')
  }
  return v
}

function assertType(type) {
  if (!ALL_SUPPRESSION_TYPES.includes(type)) {
    const err = new Error(`Unknown suppression type: ${type}`)
    err.code = 'JOHN_SUPPRESSION_INVALID_TYPE'
    throw err
  }
}

export async function addSuppression(db, { type, value, reason, source, added_by_user_id } = {}) {
  assertType(type)
  const v = normaliseValue(type, value)
  if (!v) {
    const err = new Error('Suppression value cannot be empty')
    err.code = 'JOHN_SUPPRESSION_EMPTY_VALUE'
    throw err
  }
  // Idempotent insert: ignore unique violations on (type, value).
  try {
    const stmt = db.prepare(`
      INSERT INTO john_suppression_list (suppression_type, value, reason, source, added_by_user_id)
      VALUES (?, ?, ?, ?, ?)
    `)
    await stmt.run(type, v, reason || null, source || null, added_by_user_id || null)
  } catch (err) {
    // Re-raise unless this is a duplicate row.
    const msg = String(err?.message || '')
    if (!/UNIQUE|duplicate/i.test(msg)) throw err
  }
  return { ok: true, type, value: v }
}

export async function listSuppression(db, { limit = 200 } = {}) {
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200))
  const rows = await db
    .prepare(`SELECT * FROM john_suppression_list ORDER BY created_at DESC LIMIT ?`)
    .all(lim)
  return rows || []
}

export async function isSuppressedAsync(db, { type, value } = {}) {
  if (!type || !value) return false
  if (!ALL_SUPPRESSION_TYPES.includes(type)) return false
  const v = normaliseValue(type, value)
  if (!v) return false
  const row = await db
    .prepare(`SELECT 1 AS one FROM john_suppression_list WHERE suppression_type = ? AND value = ? LIMIT 1`)
    .get(type, v)
  return !!row
}

/**
 * Build a sync-feeling suppression checker for the safety classifier. It
 * pre-loads all suppression rows once per call (small table, ~thousands at
 * most) and returns an object with `isSuppressed({type, value})`.
 */
export async function makeSuppressionChecker(db) {
  const rows = await listSuppression(db, { limit: 1000 })
  const set = new Set(rows.map((r) => `${r.suppression_type}:${normaliseValue(r.suppression_type, r.value)}`))
  return {
    rows,
    isSuppressed({ type, value } = {}) {
      if (!type || !value) return false
      if (!ALL_SUPPRESSION_TYPES.includes(type)) return false
      const v = normaliseValue(type, value)
      if (!v) return false
      return set.has(`${type}:${v}`)
    },
  }
}
