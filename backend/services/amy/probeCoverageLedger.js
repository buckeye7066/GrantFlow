/**
 * probeCoverageLedger.js — the durable memory of WHAT AMY HAS ALREADY ASKED.
 *
 * Without this the adversarial planner would be a random sampler: it could not
 * prefer never-probed space, could not cluster on where gaps were found, and —
 * decisively — could not tell "we found no gaps" from "we stopped looking".
 * The convergence claim in the owner's morning email is only honest if the
 * BREADTH that produced it is reported next to it, and breadth is exactly what
 * this ledger measures.
 *
 * STORAGE: `system_kv amy_probe_coverage`, one row, folded once per run.
 *
 *   pairs  { "<axis:value>~<axis:value>": { first_at, last_at, probes, gaps } }
 *   cells  { "<cellKey>": { first_at, last_at, probes, gaps, last_status } }
 *   axis   { "<axis>:<value>": { probes, gaps } }   ← the gap-PRESSURE index
 *
 * `pairs` is the coverage numerator; `enumerateReachablePairs()` is the
 * denominator. `axis` is what lets the planner exploit: a probe whose entity or
 * state has historically yielded gaps is more likely to yield another one, so
 * the planner biases toward that neighbourhood while the new-pair term keeps it
 * from collapsing onto the same corner.
 *
 * HONESTY RULES BAKED IN
 *  - A run is folded ONCE (`runs` ring): a retried run must not inflate probe
 *    counts, or the coverage percentage becomes a number nothing produced.
 *  - A probe that SKIPPED or THREW is recorded as a probe with an UNKNOWN
 *    outcome — it counts for breadth (we did ask) but never as "clean". Counting
 *    an errored probe as clean is how a broken night reads as convergence.
 *  - Nothing is ever trimmed from `pairs`: coverage is monotone by construction,
 *    so a shrinking numerator can only mean data loss and must be visible.
 *    `cells` IS bounded (the cell space is ~2M) — it is a recency index, not a
 *    coverage claim, and its cap is declared.
 *
 * Pure fold + thin kv I/O; no scoring, no network, no clock of its own.
 */

import { createLogger } from '../../utils/logger.js'
import { AXES, cellKey, cellPairs, enumerateReachablePairs } from './probeSpace.js'

const log = createLogger('amy:probeCoverage')

/** system_kv key holding the durable probe-coverage ledger. */
export const KV_KEY = 'amy_probe_coverage'

/** Recency index bound. `pairs` is deliberately NOT bounded (see header). */
export const CELL_INDEX_MAX = 5000

/** How many run ids the idempotence ring remembers. */
export const RUN_RING = 60

/** Outcome of one probe, from the Amy evaluation status. */
export const PROBE_OUTCOME = Object.freeze({
  CLEAN: 'clean',
  GAP: 'gap',
  UNKNOWN: 'unknown',
})

/**
 * Classify one evaluation into a probe outcome.
 *
 * `ok` with no findings is the only CLEAN result. `zero`/`weak` are gaps. A
 * `skipped`/`error` probe is UNKNOWN: it exercised the space (breadth) but
 * proved nothing about coverage, and must never be counted as a clean night.
 * An `ok` status that still carried findings (a false positive, a recall miss,
 * an amount miss) is a GAP — the profile got results, and they were wrong or
 * incomplete, which is precisely the hole the owner asked Amy to find.
 */
export function classifyProbeOutcome(evaluation) {
  const status = String(evaluation?.status ?? '')
  if (status === 'skipped' || status === 'error') return PROBE_OUTCOME.UNKNOWN
  if (status === 'zero' || status === 'weak') return PROBE_OUTCOME.GAP
  const findings = Array.isArray(evaluation?.findings) ? evaluation.findings : []
  return findings.length > 0 ? PROBE_OUTCOME.GAP : PROBE_OUTCOME.CLEAN
}

function toIso(at) {
  if (!at) return new Date().toISOString()
  if (at instanceof Date) return at.toISOString()
  return String(at)
}

function bump(map, key, { at, gap }) {
  const cur = map[key] || { first_at: at, last_at: at, probes: 0, gaps: 0 }
  cur.last_at = at
  cur.probes += 1
  if (gap) cur.gaps += 1
  map[key] = cur
  return cur
}

/**
 * PURE fold: record this run's probes into the durable coverage ledger.
 *
 * @param {object|null} prev
 * @param {object} args
 * @param {Array<{cell:object, outcome:string}>} args.probes
 * @param {string} [args.runId]
 * @param {string|Date} [args.at]
 * @returns {{ ledger:object, duplicate:boolean, new_pairs:string[], summary:object }}
 */
export function foldProbeCoverage(prev, { probes = [], runId = null, at = null } = {}) {
  const nowIso = toIso(at)
  const base = prev && typeof prev === 'object' ? prev : {}
  const list = Array.isArray(probes) ? probes : []

  if (runId && Array.isArray(base.runs) && base.runs.includes(runId)) {
    return { ledger: base, duplicate: true, new_pairs: [], summary: summarizeCoverage(base) }
  }

  const pairs = { ...(base.pairs && typeof base.pairs === 'object' ? base.pairs : {}) }
  const cells = { ...(base.cells && typeof base.cells === 'object' ? base.cells : {}) }
  const axis = { ...(base.axis && typeof base.axis === 'object' ? base.axis : {}) }
  const newPairs = []

  for (const probe of list) {
    const cell = probe?.cell
    if (!cell) continue
    const outcome = String(probe?.outcome ?? PROBE_OUTCOME.UNKNOWN)
    const gap = outcome === PROBE_OUTCOME.GAP
    const key = cellKey(cell)

    for (const p of cellPairs(cell)) {
      if (!pairs[p]) newPairs.push(p)
      bump(pairs, p, { at: nowIso, gap })
    }
    for (const a of AXES) {
      const v = cell[a]
      if (v === undefined || v === null) continue
      bump(axis, `${a}:${v}`, { at: nowIso, gap })
    }
    const entry = bump(cells, key, { at: nowIso, gap })
    entry.last_status = outcome
  }

  const ledger = {
    pairs,
    cells: trimCells(cells),
    axis,
    runs: [...(Array.isArray(base.runs) ? base.runs : []), ...(runId ? [runId] : [])].slice(-RUN_RING),
    updated_at: nowIso,
    updated_run_id: runId,
    // A monotone history of (day, pairs_covered) so the convergence report can
    // prove breadth is RISING rather than assert it. Appended once per fold.
    breadth_history: [
      ...(Array.isArray(base.breadth_history) ? base.breadth_history : []),
      { at: nowIso, run_id: runId, pairs_covered: Object.keys(pairs).length, cells_probed: Object.keys(cells).length },
    ].slice(-120),
  }

  return { ledger, duplicate: false, new_pairs: newPairs, summary: summarizeCoverage(ledger) }
}

/** Keep the most RECENTLY touched cells; the cell index is recency, not truth. */
function trimCells(cells) {
  const all = Object.entries(cells)
  if (all.length <= CELL_INDEX_MAX) return cells
  all.sort((a, b) => String(b[1]?.last_at ?? '').localeCompare(String(a[1]?.last_at ?? '')))
  return Object.fromEntries(all.slice(0, CELL_INDEX_MAX))
}

/**
 * The convergence numbers, with the breadth term ALWAYS present.
 *
 * `gap_rate` alone is the trap the owner named: it falls both when the system
 * gets better and when Amy narrows her probing. `pairs_covered` /
 * `pairs_covered_delta` is what separates them, and `summarizeCoverage` refuses
 * to report one without the other.
 */
export function summarizeCoverage(ledger) {
  const pairs = ledger?.pairs && typeof ledger.pairs === 'object' ? ledger.pairs : {}
  const cells = ledger?.cells && typeof ledger.cells === 'object' ? ledger.cells : {}
  const total = enumerateReachablePairs().size
  const covered = Object.keys(pairs).length
  let probes = 0
  let gaps = 0
  for (const entry of Object.values(cells)) {
    probes += Number(entry?.probes) || 0
    gaps += Number(entry?.gaps) || 0
  }
  const history = Array.isArray(ledger?.breadth_history) ? ledger.breadth_history : []
  const prevCovered = history.length >= 2 ? Number(history[history.length - 2]?.pairs_covered) || 0 : 0
  return {
    pairs_total: total,
    pairs_covered: covered,
    pairs_covered_pct: total > 0 ? Number((covered / total).toFixed(4)) : 0,
    pairs_covered_delta: history.length >= 2 ? covered - prevCovered : covered,
    cells_probed: Object.keys(cells).length,
    // Recency-window figures: the cell index is bounded, so these describe the
    // recent probe population, not all time. Named so nobody reads them as
    // lifetime totals.
    recent_cell_probes: probes,
    recent_cell_gaps: gaps,
    recent_gap_rate: probes > 0 ? Number((gaps / probes).toFixed(4)) : null,
  }
}

/**
 * Per-axis-value gap pressure in [0,1] — the exploit signal for the planner.
 * A value never probed has NO pressure (0), not high pressure: "unknown" and
 * "known bad" are different facts, and the new-pair term is what handles the
 * unknown.
 */
export function gapPressureIndex(ledger) {
  const axis = ledger?.axis && typeof ledger.axis === 'object' ? ledger.axis : {}
  const out = {}
  for (const [key, entry] of Object.entries(axis)) {
    const probes = Number(entry?.probes) || 0
    if (probes <= 0) continue
    out[key] = Number(((Number(entry?.gaps) || 0) / probes).toFixed(4))
  }
  return out
}

// ── kv I/O (mirrors approvalLedger) ────────────────────────────────────────

async function ensureTable(db) {
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
  } catch {
    // Richer shape on some dialects — fine.
  }
}

export async function readProbeCoverage(db) {
  if (!db) return null
  try {
    await ensureTable(db)
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    log.warn('readProbeCoverage failed', { error: err?.message })
    return null
  }
}

export async function saveProbeCoverage(db, ledger) {
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
    log.warn('saveProbeCoverage failed', { error: err?.message })
    return false
  }
}

/** `AMY_PROBE_COVERAGE=0` → fold + report, do NOT persist (ENFORCE_* posture). */
export function coveragePersistEnabled() {
  return String(process.env.AMY_PROBE_COVERAGE ?? '1').toLowerCase() !== '0'
}

/** Fold this run's probes and persist. Best-effort; never fails a run. */
export async function recordProbeCoverage(db, { probes = [], runId = null, at = null } = {}) {
  const prev = await readProbeCoverage(db)
  const fold = foldProbeCoverage(prev, { probes, runId, at })
  const persist = !fold.duplicate && coveragePersistEnabled()
  if (persist) await saveProbeCoverage(db, fold.ledger)
  return { ...fold, persisted: persist }
}

export default {
  KV_KEY,
  PROBE_OUTCOME,
  classifyProbeOutcome,
  foldProbeCoverage,
  summarizeCoverage,
  gapPressureIndex,
  readProbeCoverage,
  saveProbeCoverage,
  recordProbeCoverage,
  coveragePersistEnabled,
}
