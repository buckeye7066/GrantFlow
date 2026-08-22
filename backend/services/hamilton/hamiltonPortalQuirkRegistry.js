/**
 * hamiltonPortalQuirkRegistry.js
 *
 * Owner order 2026-08-22: "Teach Anya to look for the quirks that block Hamilton
 * and fix them." Two lanes, and this module owns Lane 1.
 *
 *   LANE 1 (AUTONOMOUS — this file): a per-host DATA registry. When Hamilton
 *   blocks on a portal quirk (an eligibility checkbox, an oddly-named field, a
 *   date format, a submit control), Anya writes a VALIDATED DATA row that the
 *   engine's fill loop consults next time on that host. There is NO code, NO
 *   eval, NO url, NO handler function — a quirk handler is a bounded set of
 *   allowlisted DATA fields, so it can never execute anything. That is exactly
 *   why writing it is safe to do autonomously. Mirrors the safety model of
 *   `hamiltonBotBypassRegistry` (which does the same for browser-launch knobs).
 *
 *   LANE 2 (HUMAN-APPROVED — see hamiltonPortalQuirkObserver): when a quirk
 *   recurs ACROSS many hosts it needs a general CODE capability (like
 *   `ageAffirmationVerdict`). Anya never self-merges that: she surfaces a code
 *   brief in the owner's morning report for approval on next login.
 *
 * ENGINE INTEGRATION SEAM: the engine calls `getPortalQuirkHandlers(db, host)`
 * inside its fill loop and applies the returned data-only handlers. This module
 * never launches a browser or touches the DOM.
 */

import crypto from 'node:crypto'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-portal-quirks')

// The only quirk kinds a handler may declare.
export const ALLOWED_QUIRK_KINDS = Object.freeze(['checkbox_rule', 'field_meaning', 'date_format', 'submit_selector'])

// checkbox_rule.action — how the fill loop should treat a matched checkbox.
//   age_affirmation       → evaluate the label with ageAffirmationVerdict (age from vault/profile)
//   eligibility_affirmation → tick when the profile provably satisfies it (residency/enrollment)
//   attestation_agree     → tick under standing-attestation consent (info-true / agree-terms class)
//   ignore                → never tick (a marketing / opt-in box)
export const ALLOWED_CHECKBOX_ACTIONS = Object.freeze(['age_affirmation', 'eligibility_affirmation', 'attestation_agree', 'ignore'])

// field_meaning.action — map a host's odd field label to a canonical meaning the
// fill loop already knows how to source from the profile/vault.
export const ALLOWED_FIELD_MEANINGS = Object.freeze([
  'first_name', 'last_name', 'full_name', 'email', 'phone', 'address1', 'city', 'state', 'zip',
  'date_of_birth', 'grad_date', 'enrollment_status', 'citizenship', 'school_name', 'gpa', 'major', 'ignore',
])

// date_format.format — the shape a host's date field wants.
export const ALLOWED_DATE_FORMATS = Object.freeze(['MM/DD/YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM-DD-YYYY', 'MMDDYYYY'])

// A submit_selector must be a plain CSS selector (used only in querySelector).
// Reject anything that could be markup/script/an attribute smuggling a payload.
const SELECTOR_RX = /^[a-zA-Z0-9 .#>_:="'[\]-]{1,120}$/
const DATA_INJECTION_RX = /<|>=|javascript:|\$\{|`|\beval\b|function\s*\(|=>/i

export function hostKey(host) {
  const h = String(host || '').toLowerCase().trim()
  try {
    // Accept a bare host OR a URL.
    const parsed = h.includes('://') ? new URL(h) : new URL(`https://${h}`)
    const parts = parsed.hostname.split('.').filter(Boolean)
    return parts.length >= 2 ? parts.slice(-2).join('.') : parsed.hostname
  } catch { return h.replace(/^www\./, '').split('/')[0] }
}

function cleanText(value, max) {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * Validate + normalize a proposed quirk handler down to allowlisted DATA only.
 * Returns { ok, handler, rejected } — a bad field is NAMED in `rejected`, never
 * silently kept. A handler can carry no code, no url, no script, no function.
 */
export function validateQuirkHandler(raw) {
  const rejected = []
  if (!raw || typeof raw !== 'object') return { ok: false, handler: null, rejected: ['not_an_object'] }
  const kind = String(raw.kind || '')
  if (!ALLOWED_QUIRK_KINDS.includes(kind)) return { ok: false, handler: null, rejected: [`kind:${kind || 'missing'}`] }

  const match = cleanText(raw.match, 200)
  if (kind !== 'submit_selector' && !match) rejected.push('match:empty')
  if (match && DATA_INJECTION_RX.test(match)) rejected.push('match:injection')

  const handler = { kind, match }
  if (kind === 'checkbox_rule') {
    const action = String(raw.action || '')
    if (!ALLOWED_CHECKBOX_ACTIONS.includes(action)) rejected.push(`action:${action || 'missing'}`)
    else handler.action = action
  } else if (kind === 'field_meaning') {
    const action = String(raw.action || '')
    if (!ALLOWED_FIELD_MEANINGS.includes(action)) rejected.push(`action:${action || 'missing'}`)
    else handler.action = action
  } else if (kind === 'date_format') {
    const format = String(raw.format || '')
    if (!ALLOWED_DATE_FORMATS.includes(format)) rejected.push(`format:${format || 'missing'}`)
    else handler.format = format
  } else if (kind === 'submit_selector') {
    const selector = cleanText(raw.selector, 120)
    if (!selector || !SELECTOR_RX.test(selector) || DATA_INJECTION_RX.test(selector)) rejected.push('selector:invalid')
    else handler.selector = selector
  }
  if (rejected.length > 0) return { ok: false, handler: null, rejected }
  return { ok: true, handler, rejected: [] }
}

function nowFn(db) { return db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP' }

async function ensureSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  const isPg = db?.dialect === 'postgres'
  const idDefault = isPg ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const ts = isPg ? 'TIMESTAMPTZ' : 'DATETIME'
  const now = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_portal_quirks (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      host TEXT NOT NULL,
      kind TEXT NOT NULL,
      match_text TEXT,
      action TEXT,
      format TEXT,
      selector TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT,
      created_at ${ts} DEFAULT ${now},
      updated_at ${ts} DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_portal_quirks_host ON hamilton_portal_quirks(host);
    CREATE TABLE IF NOT EXISTS hamilton_portal_quirk_encounters (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      host TEXT NOT NULL,
      blocker_kind TEXT,
      signature TEXT NOT NULL,
      sample TEXT,
      hits INTEGER NOT NULL DEFAULT 1,
      handled ${isPg ? 'BOOLEAN' : 'INTEGER'} NOT NULL DEFAULT ${isPg ? 'false' : '0'},
      first_seen ${ts} DEFAULT ${now},
      last_seen ${ts} DEFAULT ${now}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uidx_quirk_enc_host_sig ON hamilton_portal_quirk_encounters(host, signature);
  `)
}

/** A stable signature for a blocked-run quirk (host-agnostic so cross-host patterns cluster). */
export function quirkSignature(blockerKind, sampleText) {
  const norm = cleanText(sampleText, 400).toLowerCase().replace(/[0-9]+/g, '#').replace(/[^a-z# ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  return crypto.createHash('sha1').update(`${blockerKind || ''}|${norm}`).digest('hex').slice(0, 16)
}

/** Record that Hamilton hit a quirk on a host. Idempotent per (host, signature). */
export async function recordObservedQuirk(db, { host, blockerKind = null, sample = null } = {}) {
  await ensureSchema(db)
  const h = hostKey(host)
  if (!h) return null
  const sig = quirkSignature(blockerKind, sample)
  const existing = await db.prepare('SELECT id, hits FROM hamilton_portal_quirk_encounters WHERE host = ? AND signature = ?').get(h, sig)
  if (existing) {
    await db.prepare(`UPDATE hamilton_portal_quirk_encounters SET hits = hits + 1, last_seen = ${nowFn(db)} WHERE id = ?`).run(existing.id)
    return { host: h, signature: sig, hits: (existing.hits || 0) + 1 }
  }
  await db.prepare(
    'INSERT INTO hamilton_portal_quirk_encounters (host, blocker_kind, signature, sample) VALUES (?, ?, ?, ?)',
  ).run(h, blockerKind, sig, cleanText(sample, 400))
  return { host: h, signature: sig, hits: 1 }
}

/** The active, validated data-only handlers the engine applies for a host. */
export async function getPortalQuirkHandlers(db, host) {
  await ensureSchema(db)
  const h = hostKey(host)
  if (!h) return []
  const rows = await db.prepare(
    "SELECT kind, match_text, action, format, selector FROM hamilton_portal_quirks WHERE host = ? AND status = 'active'",
  ).all(h).catch(() => [])
  const out = []
  for (const r of rows || []) {
    const v = validateQuirkHandler({ kind: r.kind, match: r.match_text, action: r.action, format: r.format, selector: r.selector })
    if (v.ok) out.push({ host: h, ...v.handler }) // re-validate on read — a row can never smuggle in what the validator rejects
  }
  return out
}

/** Create/replace a validated data-only quirk handler for a host. */
export async function setQuirkHandler(db, host, rawHandler, { status = 'active', source = 'anya' } = {}) {
  await ensureSchema(db)
  const h = hostKey(host)
  const v = validateQuirkHandler(rawHandler)
  if (!v.ok) { log.warn('quirk_handler_rejected', { host: h, rejected: v.rejected }); return { ok: false, rejected: v.rejected } }
  const { kind, match = null, action = null, format = null, selector = null } = v.handler
  const existing = await db.prepare(
    'SELECT id FROM hamilton_portal_quirks WHERE host = ? AND kind = ? AND COALESCE(match_text, \'\') = COALESCE(?, \'\')',
  ).get(h, kind, match)
  if (existing) {
    await db.prepare(
      `UPDATE hamilton_portal_quirks SET action = ?, format = ?, selector = ?, status = ?, source = ?, updated_at = ${nowFn(db)} WHERE id = ?`,
    ).run(action, format, selector, status, source, existing.id)
  } else {
    await db.prepare(
      'INSERT INTO hamilton_portal_quirks (host, kind, match_text, action, format, selector, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(h, kind, match, action, format, selector, status, source)
  }
  return { ok: true, host: h, handler: v.handler }
}

export const _internal = { hostKey, quirkSignature, SELECTOR_RX, DATA_INJECTION_RX }
