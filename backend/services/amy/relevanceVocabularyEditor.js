// backend/services/amy/relevanceVocabularyEditor.js
//
// The APPLY path for Amy's `relevance_precision` lever.
//
// Before this existed, a `relevance_precision` approval item was permanently
// inert: no POST route, no UI control, and not among amyAgent's auto-apply
// levers. It re-rendered identically after every run and nothing could ever
// action it. This editor gives that lever somewhere to write.
//
// What it writes: ADDITIVE generic-title phrases (owner-approved) on top of the
// frozen baseline in backend/config/genericTitleVocabulary.js. The canonical
// engine's generic-only ACCEPT cap and Amy's false-positive detector both read
// that registry, so an approved phrase immediately stops generically-titled
// rows carrying it from claiming ACCEPT for a specific profile — which is
// exactly what the item's rationale asks for.
//
// PERSISTENCE — deliberately kv-only, unlike matchThresholdEditor:
// matchThresholdEditor rewrites a source FILE, but it is wired to nothing live
// (only tests import it), and crawlerCoverageEditor's own comment states the
// reason a file edit is not enough: "the file edit is ephemeral on a container
// filesystem". Prod is Railway. So the durable record is `system_kv` + the live
// in-memory mirror + boot hydration — the half of the coverage precedent that
// actually survives a redeploy. The previous value travels in the return so a
// revert needs no backup file.
//
// SAFETY: additive-only over a frozen baseline (a guard that already holds can
// never be removed by this lever), phrases are sanitized to literal text before
// they reach the matcher, and the cap they drive only demotes ACCEPT -> REVIEW,
// never REJECT.

import {
  getGenericTitleAdditions,
  setGenericTitleAdditions,
  sanitizeGenericTitleAdditions,
} from '../../config/genericTitleVocabulary.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('amy:relevance-vocabulary')

export const KV_KEY = 'amy_generic_title_additions'

async function ensureKv(db) {
  await db
    .prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    .run()
}

/** The live owner-approved additions. */
export function readGenericTitleAdditions() {
  return getGenericTitleAdditions()
}

/** Persist the live additions to system_kv so they survive restarts/redeploys. */
export async function persistGenericTitleAdditions(db) {
  if (!db) return false
  try {
    await ensureKv(db)
    const value = JSON.stringify(getGenericTitleAdditions() || [])
    const now = new Date().toISOString()
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, KV_KEY)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, value, now)
    }
    return true
  } catch {
    return false
  }
}

/** Load persisted additions into the live registry on boot. */
export async function hydrateGenericTitleAdditions(db) {
  if (!db) return null
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return null
    const applied = setGenericTitleAdditions(parsed)
    return applied
  } catch {
    return null
  }
}

/**
 * Apply an additive set of generic-title phrases.
 *
 * @param {string[]} next  the FULL desired additions list (not a delta)
 * @param {{ db?:object }} [ctx]
 * @returns {Promise<{applied:boolean, from:string[], to:string[], reason?:string}>}
 */
export async function applyGenericTitleAdditions(next, ctx = {}) {
  const from = getGenericTitleAdditions()
  const sanitized = sanitizeGenericTitleAdditions(next)
  if (sanitized.length === 0 && (next?.length ?? 0) > 0) {
    return { applied: false, from, to: from, reason: 'no_valid_phrases' }
  }
  const same =
    sanitized.length === from.length && sanitized.every((p, i) => p === from[i])
  if (same) return { applied: false, from, to: from, reason: 'no_change' }

  // Live-apply so the next crawl in THIS process sees it...
  const to = setGenericTitleAdditions(sanitized)
  // ...and persist so it survives the next redeploy.
  if (ctx.db) await persistGenericTitleAdditions(ctx.db)
  log.info('applied generic-title additions (relevance_precision lever)', { from, to })
  return { applied: true, from, to }
}

/**
 * Revert to a previous additions list. Live revert first (authoritative), then
 * persist — mirroring revertCoverageOverrides.
 */
export async function revertGenericTitleAdditions(previous, ctx = {}) {
  const to = setGenericTitleAdditions(Array.isArray(previous) ? previous : [])
  if (ctx.db) await persistGenericTitleAdditions(ctx.db)
  log.info('reverted generic-title additions', { to })
  return { reverted: true, to }
}

export default {
  KV_KEY,
  readGenericTitleAdditions,
  applyGenericTitleAdditions,
  revertGenericTitleAdditions,
  persistGenericTitleAdditions,
  hydrateGenericTitleAdditions,
}
