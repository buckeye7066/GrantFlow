/**
 * approvalLedger.js — the CONSUMER-and-clock for Amy's improvement approval queue.
 *
 * THE DEFECT THIS EXISTS TO CLOSE (2026-08-01)
 * -------------------------------------------
 * `buildApprovalQueue` is rebuilt from scratch on every run and written whole
 * over `system_kv amy_approval_queue`. There was no per-item state anywhere:
 * no first-seen stamp, no age, no record that anything ever acted. So the queue
 * could not tell night 1 from night 30, and the owner's morning email rendered
 * six identical "Needs your approval:" lines with no way to know whether they
 * appeared last night or three weeks ago.
 *
 * Measured in prod on 2026-07-31 (read-only): `amy_recent_runs` shows a
 * non-empty queue on EVERY one of the last 20 runs (size 1 for the eighteen
 * runs from 2026-07-15 through 2026-07-29, then 4, then 6), and the ONLY apply
 * path that exists in the product — `POST /api/amy/relevance-vocabulary` →
 * `applyGenericTitleAdditions` → `persistGenericTitleAdditions` — writes
 * `system_kv amy_generic_title_additions`, a key that DOES NOT EXIST in the
 * production database. Zero approval items have ever been actioned. That is the
 * write-only-queue shape this repo has already paid for twice
 * (`web_parity_gap_queue`; the adapter wishlist): a finding that is right every
 * night and closes nothing.
 *
 * WHAT THIS MODULE ADDS
 * ---------------------
 * 1. A DURABLE LEDGER (`system_kv amy_approval_ledger`) keyed by item id:
 *    first_seen_at / nights_open / runs_seen, and a terminal resolution when an
 *    item STOPS REPRODUCING (`stopped_reproducing`) or an auto-apply lever
 *    validated-and-kept a change for it (`auto_applied`). The queue is
 *    recomputed from scratch every run, so — exactly like the wishlist
 *    convergence overlay — an item that is fixed simply stops being emitted,
 *    and the ledger is what turns "stopped being emitted" into a RECORDED
 *    close instead of a silent disappearance.
 *
 * 2. An ACTIONABILITY REGISTRY. Every lever `buildApprovalQueue` can emit
 *    declares how it can actually be closed. Three honest values:
 *      - AUTO       Amy applies it herself (bounded, re-crawl validated,
 *                   auto-reverting, env-gated). Not an owner ask at all.
 *      - OWNER_API  a real surface the owner can click, named exactly.
 *      - CODE_CHANGE no approval can close it. It is reported as a code change,
 *                   NOT as "needs your approval" — asking a human to approve
 *                   something no approval can apply is the fake-ask that made
 *                   the queue unreadable.
 *    A `TOTALITY` test asserts every emitted lever is registered and every
 *    OWNER_API entry names a route that exists (the registry/totality rule).
 *
 * 3. STALENESS WITH TEETH. An item open >= AMY_APPROVAL_STALE_NIGHTS (7)
 *    whose actionability is not AUTO is reported as stale so it reddens the
 *    morning report instead of blending into the wallpaper.
 *
 * Off switch: `AMY_APPROVAL_LEDGER=0` → the fold is computed and reported but
 * NOT persisted (count-only), mirroring the ENFORCE_* posture.
 *
 * Pure fold + thin kv I/O; no scoring, no network.
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('amy:approvalLedger')

/** system_kv key holding the durable per-item approval ledger. */
export const KV_KEY = 'amy_approval_ledger'

/** How long a RESOLVED entry is retained (days) before it is dropped. */
export const RESOLVED_RETENTION_DAYS = 30

/** Hard cap on ledger entries so a runaway queue can never unbound the kv row. */
export const LEDGER_MAX_ENTRIES = 500

/** How a queue item can actually be closed. */
export const ACTIONABILITY = Object.freeze({
  AUTO: 'auto',
  OWNER_API: 'owner_api',
  CODE_CHANGE: 'code_change',
})

/**
 * Every lever `buildApprovalQueue` can emit, and how it closes.
 *
 * `surface` must be something a human or a machine can actually reach:
 * an env-gated auto-apply lever, or a real route. `why` explains a
 * deliberately human-gated lever — never leave that blank, because an
 * unexplained human gate is how a queue becomes wallpaper.
 */
export const LEVER_REGISTRY = Object.freeze({
  source_keyword_coverage: Object.freeze({
    actionability: ACTIONABILITY.AUTO,
    surface: 'amyAgent applyCoverage (crawlerCoverageEditor) — re-crawl validated, auto-reverts on no gain; env AMY_APPLY_COVERAGE=0 disables',
    why: null,
  }),
  scoring_weights: Object.freeze({
    actionability: ACTIONABILITY.AUTO,
    surface: 'amyAgent applyWeights (matchThresholdEditor) — re-crawl validated on the topical subscale, auto-reverts on no gain; env AMY_APPLY_WEIGHTS=0 disables',
    why: null,
  }),
  relevance_precision: Object.freeze({
    actionability: ACTIONABILITY.OWNER_API,
    surface: 'POST /api/amy/relevance-vocabulary (Admin → Agent Amy → Improvement approval queue → the item\'s Apply control)',
    why: 'Amy can only flag a title as generic when the vocabulary ALREADY matches it, so mining new phrases from flagged titles is circular — a human must read false_positive_titles and name the phrase. The lever can suppress real programs if a phrase over-blocks.',
  }),
  eligibility_gate: Object.freeze({
    actionability: ACTIONABILITY.CODE_CHANGE,
    surface: null,
    why: 'The eligibility gate is code in the canonical match engine. There is no data-only knob that can reject an ineligible ACCEPT, so no approval can close this item — it is reported as a code change.',
  }),
  adapter_source_health: Object.freeze({
    actionability: ACTIONABILITY.CODE_CHANGE,
    surface: null,
    why: 'A failing adapter needs adapter/retry/API-key work in the source registry. Amy cannot write an adapter, so no approval can close this item.',
  }),
})

/** Resolutions a ledger entry can terminate with. */
export const RESOLUTION = Object.freeze({
  STOPPED_REPRODUCING: 'stopped_reproducing',
  AUTO_APPLIED: 'auto_applied',
})

/** Nights open before a non-AUTO item is escalated as stale. */
export function staleNights() {
  const n = Number(process.env.AMY_APPROVAL_STALE_NIGHTS)
  if (!Number.isFinite(n)) return 7
  return Math.max(1, Math.min(365, Math.trunc(n)))
}

/** Persist the fold? `AMY_APPROVAL_LEDGER=0` → compute + report only. */
export function ledgerPersistEnabled() {
  return String(process.env.AMY_APPROVAL_LEDGER ?? '1').toLowerCase() !== '0'
}

/** ET calendar day key — the same owner-clock day the cohort scoreboard uses. */
export function etDayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date)
}

/** Registry lookup that never throws on an unknown lever. */
export function leverActionability(lever) {
  const entry = LEVER_REGISTRY[String(lever || '')]
  if (!entry) {
    // An unregistered lever is honestly UNKNOWN, never silently "auto".
    return { actionability: ACTIONABILITY.CODE_CHANGE, surface: null, why: 'Unregistered lever — no declared apply path (see LEVER_REGISTRY).', unregistered: true }
  }
  return { ...entry, unregistered: false }
}

/** True when the item is a genuine ask of the owner (a surface exists). */
export function isOwnerActionable(lever) {
  return leverActionability(lever).actionability === ACTIONABILITY.OWNER_API
}

function toIso(at) {
  if (!at) return new Date().toISOString()
  if (at instanceof Date) return at.toISOString()
  return String(at)
}

/**
 * PURE fold: age this run's queue into the durable ledger.
 *
 * @param {object|null} prev   previous ledger value ({ entries: {...} })
 * @param {object} args
 * @param {Array<object>} args.items    this run's approval queue
 * @param {string} [args.runId]
 * @param {string|Date} [args.at]
 * @returns {{ ledger:object, decorated:Array<object>, closed:Array<object>, stale:Array<object>, duplicate:boolean }}
 *   `decorated` is the SAME items with first_seen_at / nights_open /
 *   actionability / apply_surface attached (never a filtered subset — a
 *   structural gap must stay visible).
 */
export function foldApprovalLedger(prev, { items = [], runId = null, at = null } = {}) {
  const nowIso = toIso(at)
  const dayKey = etDayKey(new Date(nowIso))
  const base = prev && typeof prev === 'object' ? prev : {}
  const prevEntries = base.entries && typeof base.entries === 'object' ? base.entries : {}
  const list = Array.isArray(items) ? items : []

  // Idempotence: re-folding the SAME run must not age anything a second time.
  // Without this a retried/duplicated run would inflate runs_seen and (on a
  // day boundary) nights_open, and a stale escalation would fire on a number
  // nothing in the world produced.
  if (runId && Array.isArray(base.runs) && base.runs.includes(runId)) {
    return {
      ledger: base,
      decorated: list.map((it) => decorateOne(it, prevEntries[String(it?.id)] || null)),
      closed: [],
      stale: openStale(prevEntries),
      duplicate: true,
    }
  }

  const entries = {}
  const seenIds = new Set()
  const closed = []

  for (const item of list) {
    const id = String(item?.id || '')
    if (!id) continue
    seenIds.add(id)
    const prevEntry = prevEntries[id] || null
    const days = new Set(Array.isArray(prevEntry?.days) ? prevEntry.days : [])
    days.add(dayKey)
    const reopened = Boolean(prevEntry?.resolved_at)
    entries[id] = {
      id,
      lever: item?.lever ?? prevEntry?.lever ?? null,
      category: item?.category ?? prevEntry?.category ?? null,
      severity: item?.severity ?? prevEntry?.severity ?? null,
      // A REOPENED item restarts its clock but keeps the fact it reopened:
      // "closed then came back" is a different story from "never closed".
      first_seen_at: reopened ? nowIso : (prevEntry?.first_seen_at || nowIso),
      last_seen_at: nowIso,
      days: [...days].sort().slice(-RESOLVED_RETENTION_DAYS),
      nights_open: reopened ? 1 : days.size,
      runs_seen: reopened ? 1 : (Number(prevEntry?.runs_seen) || 0) + 1,
      reopened_count: (Number(prevEntry?.reopened_count) || 0) + (reopened ? 1 : 0),
      last_run_id: runId,
      resolved_at: null,
      resolution: null,
      // An auto-apply lever that validated-and-kept a change for this item is
      // recorded, but the item is NOT closed by it: the close is earned next
      // run by the finding no longer reproducing. Claiming the fix worked on
      // the strength of having applied it is exactly the "green while doing
      // nothing" failure this repo keeps paying for.
      last_auto_applied_at: item?.auto_applied ? nowIso : (prevEntry?.last_auto_applied_at || null),
      auto_applied_runs: (Number(prevEntry?.auto_applied_runs) || 0) + (item?.auto_applied ? 1 : 0),
    }
  }

  // Anything in the ledger that did NOT reproduce this run is CLOSED.
  for (const [id, entry] of Object.entries(prevEntries)) {
    if (seenIds.has(id)) continue
    if (entry?.resolved_at) {
      // Already terminal — retain briefly, then drop.
      if (withinRetention(entry.resolved_at, nowIso)) entries[id] = entry
      continue
    }
    const resolution = entry?.last_auto_applied_at ? RESOLUTION.AUTO_APPLIED : RESOLUTION.STOPPED_REPRODUCING
    const closedEntry = { ...entry, resolved_at: nowIso, resolution, last_run_id: runId }
    entries[id] = closedEntry
    closed.push(closedEntry)
  }

  const trimmed = trimEntries(entries)
  const runs = [...(Array.isArray(base.runs) ? base.runs : []), ...(runId ? [runId] : [])].slice(-50)

  return {
    ledger: { entries: trimmed, runs, updated_at: nowIso, updated_run_id: runId },
    decorated: list.map((it) => decorateOne(it, trimmed[String(it?.id)] || null)),
    closed,
    stale: openStale(trimmed),
    duplicate: false,
  }
}

function withinRetention(resolvedAt, nowIso) {
  const t = Date.parse(resolvedAt)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(t) || !Number.isFinite(now)) return false
  return now - t <= RESOLVED_RETENTION_DAYS * 86400000
}

/** Keep every OPEN entry; drop the oldest resolved ones first when over cap. */
function trimEntries(entries) {
  const all = Object.values(entries)
  if (all.length <= LEDGER_MAX_ENTRIES) return entries
  const open = all.filter((e) => !e.resolved_at)
  const resolved = all
    .filter((e) => e.resolved_at)
    .sort((a, b) => String(b.resolved_at).localeCompare(String(a.resolved_at)))
  const keep = [...open, ...resolved].slice(0, LEDGER_MAX_ENTRIES)
  return Object.fromEntries(keep.map((e) => [e.id, e]))
}

/** Open entries that have outlived the stale bar and cannot self-apply. */
function openStale(entries) {
  const bar = staleNights()
  return Object.values(entries || {})
    .filter((e) => !e?.resolved_at)
    .filter((e) => Number(e?.nights_open) >= bar)
    .filter((e) => leverActionability(e?.lever).actionability !== ACTIONABILITY.AUTO)
    .sort((a, b) => (Number(b.nights_open) || 0) - (Number(a.nights_open) || 0))
}

function decorateOne(item, entry) {
  const meta = leverActionability(item?.lever)
  return {
    ...item,
    actionability: meta.actionability,
    apply_surface: meta.surface,
    human_gate_reason: meta.why,
    // requires_approval must mean "a human CAN approve this", not "a human is
    // being asked to". An AUTO or CODE_CHANGE lever is never an owner ask.
    requires_approval: meta.actionability === ACTIONABILITY.OWNER_API,
    first_seen_at: entry?.first_seen_at ?? null,
    nights_open: Number(entry?.nights_open) || 0,
    runs_seen: Number(entry?.runs_seen) || 0,
    reopened_count: Number(entry?.reopened_count) || 0,
    stale: Boolean(
      entry
      && Number(entry.nights_open) >= staleNights()
      && meta.actionability !== ACTIONABILITY.AUTO,
    ),
  }
}

/** Attach ledger age + registry actionability without folding (read paths). */
export function decorateApprovalQueue(items = [], ledger = null) {
  const entries = ledger?.entries && typeof ledger.entries === 'object' ? ledger.entries : {}
  return (Array.isArray(items) ? items : []).map((it) => decorateOne(it, entries[String(it?.id)] || null))
}

// ── kv I/O (mirrors amyReportStore) ────────────────────────────────────────

async function ensureTable(db) {
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
  } catch {
    // Richer shape on some dialects — fine.
  }
}

export async function readApprovalLedger(db) {
  if (!db) return null
  try {
    await ensureTable(db)
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    log.warn('readApprovalLedger failed', { error: err?.message })
    return null
  }
}

export async function saveApprovalLedger(db, ledger) {
  if (!db || !ledger) return false
  try {
    await ensureTable(db)
    const now = new Date().toISOString()
    const value = JSON.stringify(ledger)
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, KV_KEY)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, value, now)
    }
    return true
  } catch (err) {
    log.warn('saveApprovalLedger failed', { error: err?.message })
    return false
  }
}

/**
 * Fold this run's queue into the durable ledger and return the DECORATED queue.
 * Best-effort: a store failure never fails an Amy run, and the decoration still
 * carries registry actionability so the report can never regress to the old
 * ageless "Needs your approval" line.
 */
export async function recordApprovalQueue(db, { items = [], runId = null, at = null } = {}) {
  const prev = await readApprovalLedger(db)
  const fold = foldApprovalLedger(prev, { items, runId, at })
  if (!fold.duplicate && ledgerPersistEnabled()) {
    await saveApprovalLedger(db, fold.ledger)
  }
  return { ...fold, persisted: !fold.duplicate && ledgerPersistEnabled() }
}

export default {
  KV_KEY,
  ACTIONABILITY,
  LEVER_REGISTRY,
  RESOLUTION,
  foldApprovalLedger,
  decorateApprovalQueue,
  leverActionability,
  isOwnerActionable,
  readApprovalLedger,
  saveApprovalLedger,
  recordApprovalQueue,
  staleNights,
  ledgerPersistEnabled,
}
