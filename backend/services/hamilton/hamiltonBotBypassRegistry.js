/**
 * hamiltonBotBypassRegistry.js
 *
 * Owner doctrine 2026-08-22, condition 3: when Hamilton hits a full-page bot
 * wall the CAPTCHA solver cannot clear, he tells Anya what the block is and Anya
 * evolves GrantFlow to get through it — VALIDATED and PERSISTED so future runs
 * pass that wall.
 *
 * SAFETY — THIS IS NOT ARBITRARY CODE EXECUTION. There is no eval, no runtime
 * code string, no RCE surface. "The code Anya writes" takes exactly two forms:
 *
 *   1. A validated unified DIFF dispatched through the existing
 *      anyaCodeFixDispatch pipeline → review/PR → merge. Real code, but it goes
 *      through the same gate every code change does.
 *   2. A per-host BYPASS STRATEGY row in this registry — a bounded set of
 *      browser-policy knobs from a STRICT ALLOWLIST (user agent, a few launch
 *      args, a stealth flag, wait/retry timings). The browser launcher consults
 *      it on the next run. `validateBypassStrategy` REJECTS anything not on the
 *      allowlist, so a strategy can never carry code, a URL, a script, or a
 *      handler — only data the launcher already knows how to apply.
 *
 * This module owns the registry (encounters + strategies). The orchestrator
 * records encounters and (over a threshold) dispatches the code brief; the
 * launcher consults getActiveBypassStrategy. Nothing here launches a browser or
 * executes anything.
 */

import crypto from 'node:crypto'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-bot-bypass')

// The ONLY knobs a persisted strategy may carry. Anything else is dropped by
// validateBypassStrategy — a strategy is DATA the launcher applies, never code.
export const ALLOWED_BYPASS_KNOBS = Object.freeze(['user_agent', 'extra_args', 'stealth', 'nav_wait_ms', 'nav_retries'])

// Launch args a strategy may add, matched by exact prefix. Deliberately narrow:
// locale/window/feature-flag knobs that affect fingerprint, nothing that can
// exfiltrate, proxy, or execute.
const ALLOWED_ARG_PREFIXES = Object.freeze([
  '--lang=', '--window-size=', '--disable-blink-features=', '--accept-lang=',
  '--force-color-profile=', '--disable-features=', '--user-agent=',
])

function isAllowedArg(arg) {
  const a = String(arg || '')
  if (a.length > 120) return false
  return ALLOWED_ARG_PREFIXES.some((p) => a.startsWith(p))
}

/**
 * Validate + normalize a proposed strategy to ONLY the allowlisted knobs.
 * Returns { ok, strategy, rejected } — `rejected` names any dropped keys so a
 * bad proposal is visible, never silently partially applied.
 */
export function validateBypassStrategy(raw) {
  const rejected = []
  const out = {}
  if (!raw || typeof raw !== 'object') return { ok: false, strategy: {}, rejected: ['not_an_object'] }
  for (const [k, v] of Object.entries(raw)) {
    if (!ALLOWED_BYPASS_KNOBS.includes(k)) { rejected.push(k); continue }
    if (k === 'user_agent') {
      if (typeof v === 'string' && v.length <= 300) out.user_agent = v; else rejected.push('user_agent')
    } else if (k === 'extra_args') {
      const args = Array.isArray(v) ? v.filter(isAllowedArg).slice(0, 8) : []
      if (Array.isArray(v) && args.length !== v.length) rejected.push('extra_args:some_disallowed')
      if (args.length) out.extra_args = args
    } else if (k === 'stealth') {
      out.stealth = v === true
    } else if (k === 'nav_wait_ms') {
      const n = Number(v); if (Number.isFinite(n) && n >= 0 && n <= 30000) out.nav_wait_ms = Math.round(n); else rejected.push('nav_wait_ms')
    } else if (k === 'nav_retries') {
      const n = Number(v); if (Number.isFinite(n) && n >= 0 && n <= 5) out.nav_retries = Math.round(n); else rejected.push('nav_retries')
    }
  }
  return { ok: Object.keys(out).length > 0, strategy: out, rejected }
}

function hostKey(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '') || 'unknown'
}

async function ensureSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  const isPg = db?.dialect === 'postgres'
  const idDefault = isPg ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const ts = isPg ? 'TIMESTAMPTZ' : 'DATETIME'
  const now = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_bot_bypass_strategies (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      host TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'observed',
      wall_signature TEXT,
      strategy_json TEXT,
      encounters INTEGER NOT NULL DEFAULT 0,
      brief_dispatched INTEGER NOT NULL DEFAULT 0,
      created_at ${ts} DEFAULT ${now},
      updated_at ${ts} DEFAULT ${now}
    );
  `)
}

/**
 * Record that Hamilton hit a bot wall on `host` — increments the encounter
 * count and stores the latest wall signature + the approach that failed.
 * Returns the row (host, encounters, status, has_active_strategy).
 */
export async function recordBotWallEncounter(db, { host, signature = null } = {}) {
  await ensureSchema(db)
  const h = hostKey(host)
  const now = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await db.prepare('SELECT * FROM hamilton_bot_bypass_strategies WHERE host = ?').get(h)
  if (existing) {
    await db.prepare(
      `UPDATE hamilton_bot_bypass_strategies SET encounters = encounters + 1, wall_signature = COALESCE(?, wall_signature), updated_at = ${now} WHERE host = ?`,
    ).run(signature ? String(signature).slice(0, 500) : null, h)
    return { host: h, encounters: (existing.encounters || 0) + 1, status: existing.status, has_active_strategy: existing.status === 'active' && !!existing.strategy_json }
  }
  await db.prepare(
    `INSERT INTO hamilton_bot_bypass_strategies (id, host, status, wall_signature, encounters) VALUES (?, ?, 'observed', ?, 1)`,
  ).run(crypto.randomUUID(), h, signature ? String(signature).slice(0, 500) : null)
  return { host: h, encounters: 1, status: 'observed', has_active_strategy: false }
}

/** The active, validated bypass strategy for a host (or null). The launcher
 * consults this; a non-active or unvalidatable row returns null. */
export async function getActiveBypassStrategy(db, host) {
  if (!db || !host) return null
  await ensureSchema(db)
  const row = await db.prepare('SELECT strategy_json, status FROM hamilton_bot_bypass_strategies WHERE host = ?').get(hostKey(host)).catch(() => null)
  if (!row || row.status !== 'active' || !row.strategy_json) return null
  let parsed
  try { parsed = JSON.parse(row.strategy_json) } catch { return null }
  const { ok, strategy } = validateBypassStrategy(parsed)
  return ok ? strategy : null
}

/**
 * Persist a proposed strategy for a host after Anya (or an operator) proposes
 * it. VALIDATED first — only allowlisted knobs survive. status defaults to
 * 'active' so the next run consults it; pass status:'proposed' to stage it.
 * Returns { ok, strategy, rejected }.
 */
export async function setBypassStrategy(db, host, rawStrategy, { status = 'active' } = {}) {
  await ensureSchema(db)
  const { ok, strategy, rejected } = validateBypassStrategy(rawStrategy)
  if (!ok) { log.warn('bot_bypass_strategy_rejected', { host: hostKey(host), rejected }); return { ok: false, strategy: {}, rejected } }
  const h = hostKey(host)
  const now = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const safeStatus = ['active', 'proposed', 'failed', 'observed'].includes(status) ? status : 'proposed'
  const existing = await db.prepare('SELECT host FROM hamilton_bot_bypass_strategies WHERE host = ?').get(h)
  if (existing) {
    await db.prepare(`UPDATE hamilton_bot_bypass_strategies SET strategy_json = ?, status = ?, updated_at = ${now} WHERE host = ?`)
      .run(JSON.stringify(strategy), safeStatus, h)
  } else {
    await db.prepare(`INSERT INTO hamilton_bot_bypass_strategies (id, host, status, strategy_json, encounters) VALUES (?, ?, ?, ?, 0)`)
      .run(crypto.randomUUID(), h, safeStatus, JSON.stringify(strategy))
  }
  log.info('bot_bypass_strategy_set', { host: h, status: safeStatus, knobs: Object.keys(strategy) })
  return { ok: true, strategy, rejected }
}

export async function markBriefDispatched(db, host) {
  await ensureSchema(db)
  const now = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(`UPDATE hamilton_bot_bypass_strategies SET brief_dispatched = 1, updated_at = ${now} WHERE host = ?`).run(hostKey(host)).catch(() => {})
}

/** Should Hamilton brief Anya for a code-level bypass yet? Only after repeated
 * walls with no active strategy, and only once (brief_dispatched guard). */
export async function shouldBriefAnya(db, host, { threshold = 2 } = {}) {
  await ensureSchema(db)
  const row = await db.prepare('SELECT encounters, status, brief_dispatched FROM hamilton_bot_bypass_strategies WHERE host = ?').get(hostKey(host)).catch(() => null)
  if (!row) return false
  return (row.encounters || 0) >= threshold && row.status !== 'active' && !row.brief_dispatched
}

export const _internal = { hostKey, isAllowedArg, ALLOWED_ARG_PREFIXES }
