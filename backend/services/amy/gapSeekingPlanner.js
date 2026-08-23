/**
 * gapSeekingPlanner.js — HOW AMY CHOOSES WHAT TO ASK.
 *
 * The owner's instruction is that Amy's profiles exist to EXPOSE HOLES, not to
 * replay a catalog. This module is the algorithm that makes that literally true:
 * it selects the intersections of the probe space that GrantFlow has been asked
 * about LEAST, biased toward the neighbourhoods where holes have already been
 * found, and it is deterministic for a given (ledger, runId, count) so a night
 * can be reproduced and audited.
 *
 * THE ALGORITHM (pair-driven greedy, deterministic)
 * ------------------------------------------------
 *   1. UNCOVERED := reachablePairs \ coveredPairs        (probeSpace ∖ ledger)
 *   2. Order UNCOVERED by  gapPressure(pair) DESC, then key ASC.
 *        gapPressure(pair) = mean historical gap RATE of the pair's two axis
 *        values. This is the EXPLOIT term: a hole found near `state:WV` or
 *        `entity:veteran` makes another hole in that neighbourhood likelier.
 *   3. For each seed pair, in order, until `count` cells are chosen:
 *        a. skip it if a cell already chosen this run covers it;
 *        b. pin the seed's two axis values;
 *        c. fill each remaining axis with the value maximizing
 *               W_NEW  * (# additional still-uncovered pairs it would retire)
 *             + W_GAP  * gapPressure(axis value)
 *             + W_STALE* staleness(axis value)
 *           ties broken by a seeded RNG over (runId, slot, axis) — never by
 *           insertion order, which would pin the same corner every night;
 *        d. drop the cell if it is not plausible (`isPlausibleCell`).
 *   4. Every chosen cell therefore retires AT LEAST ONE previously-uncovered
 *      pair whenever any remain. That is the property the breadth proof rests
 *      on, and `amyGapSeekingPlanner.test.js` asserts it directly.
 *
 * WHY EXPLORE AND EXPLOIT BOTH. Pure exploitation re-probes the same known-bad
 * corner forever and the gap count never falls; pure exploration wanders and
 * never confirms a fix. The new-pair term is the explore side and it dominates
 * by construction (a fresh axis value retires up to 3 pairs at W_NEW=1.0, which
 * outweighs the maximum W_GAP=2.0 of a fully-gapped but already-covered value),
 * so the planner cannot collapse onto a favourite.
 *
 * BOUNDED AND SAFE. Nothing here touches the DB, the network, or any product
 * rule. It returns CELLS; `intersectionScenario.js` turns a cell into a profile
 * and every downstream gate is unchanged.
 *
 * Pure: `ledger`, `runId`, `count`, `now` in — cells out.
 */

import { makeSeededRng } from './amyMetadata.js'
import {
  AXES,
  ENTITY_IDS,
  IDENTITY_IDS,
  NEED_IDS,
  STATE_IDS,
  NEED_APPLICABILITY,
  entityClass,
  cellKey,
  cellPairs,
  isPlausibleCell,
  enumerateReachablePairs,
} from './probeSpace.js'
import { gapPressureIndex } from './probeCoverageLedger.js'

/** Scoring weights. See the header for why NEW must dominate GAP. */
export const W_NEW = 1.0
export const W_GAP = 2.0
export const W_STALE = 0.5

/** Days after which an axis value counts as fully stale. */
export const STALE_FULL_DAYS = 14

/** The candidate values for each axis. */
const AXIS_VALUES = Object.freeze({
  entity: ENTITY_IDS,
  identity: IDENTITY_IDS,
  need: NEED_IDS,
  state: STATE_IDS,
})

function parsePairKey(pairKey) {
  const [left, right] = String(pairKey ?? '').split('~')
  const split = (s) => {
    const i = String(s ?? '').indexOf(':')
    return i === -1 ? null : { axis: s.slice(0, i), value: s.slice(i + 1) }
  }
  const a = split(left)
  const b = split(right)
  return a && b ? [a, b] : null
}

function stalenessOf(axisEntry, nowMs) {
  if (!axisEntry?.last_at) return 1
  const t = Date.parse(axisEntry.last_at)
  if (!Number.isFinite(t)) return 1
  const days = Math.max(0, (nowMs - t) / 86400000)
  return Math.min(1, days / STALE_FULL_DAYS)
}

/**
 * Choose the cells Amy will probe this run.
 *
 * @param {object} args
 * @param {object|null} args.ledger  probe-coverage ledger (probeCoverageLedger)
 * @param {number} args.count        how many cells to return (bounded 0..500)
 * @param {string} args.runId        seeds the tie-break RNG
 * @param {Date|string} [args.now]
 * @returns {{ cells:Array<object>, uncovered_before:number, pairs_targeted:number, exhausted:boolean }}
 */
export function planGapSeekingProbes({ ledger = null, count = 0, runId = 'amy', now = null } = {}) {
  const want = Math.max(0, Math.min(500, Math.trunc(Number(count) || 0)))
  const nowMs = now ? new Date(now).getTime() : Date.now()
  const reachable = enumerateReachablePairs()
  const covered = new Set(Object.keys(ledger?.pairs && typeof ledger.pairs === 'object' ? ledger.pairs : {}))
  const axisIndex = ledger?.axis && typeof ledger.axis === 'object' ? ledger.axis : {}
  const pressure = gapPressureIndex(ledger)

  const uncovered = [...reachable].filter((p) => !covered.has(p))
  const uncoveredBefore = uncovered.length
  if (want === 0) {
    return { cells: [], uncovered_before: uncoveredBefore, pairs_targeted: 0, exhausted: uncoveredBefore === 0 }
  }

  const pairPressure = (pairKey) => {
    const parsed = parsePairKey(pairKey)
    if (!parsed) return 0
    const [a, b] = parsed
    const pa = Number(pressure[`${a.axis}:${a.value}`]) || 0
    const pb = Number(pressure[`${b.axis}:${b.value}`]) || 0
    return (pa + pb) / 2
  }

  // Seed order: highest gap pressure first, then a SEEDED SHUFFLE within the
  // equal-pressure bucket.
  //
  // Sorting ties by key looks harmless and is not. On night one every pressure
  // is 0, so the whole space is one bucket and a key sort makes every seed
  // start `entity:animal_rescue~…` — measured: all 18 probes were animal
  // rescues. The night would have had one entity value in it. The shuffle is a
  // pure function of (runId, pair), so the run stays exactly reproducible while
  // the cohort spreads across the space.
  const seeds = uncovered
    .map((p) => ({ p, w: pairPressure(p), h: makeSeededRng(`${runId}:seed:${p}`)() }))
    .sort((x, y) => (y.w - x.w) || (x.h - y.h) || (x.p < y.p ? -1 : x.p > y.p ? 1 : 0))
    .map((x) => x.p)

  // `remaining` shrinks as this run's own choices retire pairs, so two cells in
  // one run never claim credit for the same pair.
  const remaining = new Set(uncovered)
  const cells = []
  const seenCells = new Set()
  let slot = 0

  const valueScore = (axis, value, pinned, rng) => {
    const probe = { ...pinned, [axis]: value }
    let novel = 0
    for (const other of AXES) {
      if (other === axis || probe[other] === undefined) continue
      const key = pairKeyFor(axis, value, other, probe[other])
      if (remaining.has(key)) novel += 1
    }
    const gp = Number(pressure[`${axis}:${value}`]) || 0
    const st = stalenessOf(axisIndex[`${axis}:${value}`], nowMs)
    return W_NEW * novel + W_GAP * gp + W_STALE * st + rng() * 1e-6
  }

  for (const seed of seeds) {
    if (cells.length >= want) break
    if (!remaining.has(seed)) continue
    const parsed = parsePairKey(seed)
    if (!parsed) continue
    const pinned = {}
    for (const side of parsed) pinned[side.axis] = side.value

    const rng = makeSeededRng(`${runId}:probe:${slot}`)
    const cell = { ...pinned }
    let ok = true
    for (const axis of AXES) {
      if (cell[axis] !== undefined) continue
      const candidates = candidateValues(axis, cell)
      if (candidates.length === 0) { ok = false; break }
      let best = null
      let bestScore = -Infinity
      for (const value of candidates) {
        const s = valueScore(axis, value, cell, rng)
        if (s > bestScore) { bestScore = s; best = value }
      }
      cell[axis] = best
    }
    if (!ok || !isPlausibleCell(cell)) continue
    const key = cellKey(cell)
    if (seenCells.has(key)) continue
    seenCells.add(key)
    for (const p of cellPairs(cell)) remaining.delete(p)
    cells.push({ ...cell, cell_key: key, seed_pair: seed })
    slot += 1
  }

  // The pair space can be exhausted long before `count` cells are chosen (late
  // in convergence). Rather than return fewer probes — which would silently
  // NARROW the search, the exact failure mode the owner named — top up with the
  // STALEST covered cells so breadth per night stays constant and the report can
  // say plainly that the space is exhausted.
  const exhausted = remaining.size === 0 || cells.length < want
  if (cells.length < want) {
    for (const cell of staleTopUp({ ledger, axisIndex, pressure, nowMs, runId, want: want - cells.length, seenCells })) {
      cells.push(cell)
    }
  }

  return {
    cells,
    uncovered_before: uncoveredBefore,
    pairs_targeted: uncoveredBefore - remaining.size,
    exhausted,
  }
}

function pairKeyFor(axisA, valueA, axisB, valueB) {
  const ia = AXES.indexOf(axisA)
  const ib = AXES.indexOf(axisB)
  return ia < ib
    ? `${axisA}:${valueA}~${axisB}:${valueB}`
    : `${axisB}:${valueB}~${axisA}:${valueA}`
}

/**
 * The values an axis may take given what is already pinned.
 *
 * The only cross-axis constraint is need↔entity-class, and it is enforced in
 * BOTH directions here so a seed pair can pin either side without producing an
 * implausible cell that then has to be thrown away.
 */
function candidateValues(axis, pinned) {
  const all = AXIS_VALUES[axis] || []
  if (axis === 'need' && pinned.entity) {
    const klass = entityClass(pinned.entity)
    return all.filter((n) => {
      const a = NEED_APPLICABILITY[n]
      return a === 'both' || a === klass
    })
  }
  if (axis === 'entity' && pinned.need) {
    const a = NEED_APPLICABILITY[pinned.need]
    if (a && a !== 'both') return all.filter((e) => entityClass(e) === a)
  }
  return [...all]
}

/**
 * Stalest-first top-up, used ONLY when the uncovered pair space cannot fill the
 * night. Re-probing the oldest cells is how a CLOSED gap is proven still closed;
 * returning fewer profiles instead would make the gap count fall for the wrong
 * reason.
 */
function staleTopUp({ ledger, axisIndex, pressure, nowMs, runId, want, seenCells }) {
  const out = []
  const cellIndex = ledger?.cells && typeof ledger.cells === 'object' ? ledger.cells : {}
  const ranked = Object.entries(cellIndex)
    .map(([key, e]) => ({ key, at: Date.parse(e?.last_at ?? '') || 0, gaps: Number(e?.gaps) || 0 }))
    .sort((a, b) => (a.at - b.at) || (b.gaps - a.gaps) || (a.key < b.key ? -1 : 1))

  for (const row of ranked) {
    if (out.length >= want) break
    if (seenCells.has(row.key)) continue
    const cell = {}
    for (const part of row.key.split('|')) {
      const i = part.indexOf('=')
      if (i > 0) cell[part.slice(0, i)] = part.slice(i + 1)
    }
    if (!isPlausibleCell(cell)) continue
    seenCells.add(row.key)
    out.push({ ...cell, cell_key: row.key, seed_pair: null, top_up: 'stale_recheck' })
  }

  // Nothing in the recency index (a first run against an exhausted ledger is
  // impossible, but a wiped `cells` index is not): synthesize deterministically
  // from the highest-pressure axis values so a night is never short.
  let guard = 0
  while (out.length < want && guard < want * 20) {
    guard += 1
    const rng = makeSeededRng(`${runId}:topup:${out.length}:${guard}`)
    const cell = {}
    for (const axis of AXES) {
      const candidates = candidateValues(axis, cell)
      if (candidates.length === 0) break
      const scored = candidates
        .map((v) => ({
          v,
          s: W_GAP * (Number(pressure[`${axis}:${v}`]) || 0)
            + W_STALE * stalenessOf(axisIndex[`${axis}:${v}`], nowMs)
            + rng(),
        }))
        .sort((a, b) => b.s - a.s)
      cell[axis] = scored[0]?.v
    }
    if (!isPlausibleCell(cell)) continue
    const key = cellKey(cell)
    if (seenCells.has(key)) continue
    seenCells.add(key)
    out.push({ ...cell, cell_key: key, seed_pair: null, top_up: 'synthesized' })
  }
  return out
}

/**
 * The THIN catalog hard-floor kept for regression coverage — the number of
 * catalog profiles reserved BEFORE the adversarial probes take the rest.
 *
 * WHY IT IS THIN NOW (owner directive 2026-08-23): the ADVERSARIAL cohort — the
 * profiles purposely built to break the system so weaknesses are revealed →
 * learned → fixed — is the whole point of Amy's nightly run, so it must be the
 * MAJORITY of the daily target (up to ~50), not a 40% minority. The catalog
 * floor still exists (a fixed archetype must be proven to STAY fixed, and
 * coverage must never drop to zero), but it is now a small, rotating hard floor
 * rather than one reserved slot per category. Env override: `AMY_CATALOG_FLOOR`.
 */
export const CATALOG_FLOOR_DEFAULT = 6

/**
 * Split the nightly target into a THIN catalog floor and an ADVERSARIAL-MAJORITY
 * probe cohort.
 *
 * WAS (until 2026-08-23): the catalog reserved ONE slot per category (~32 of a
 * 50-cohort) and `AMY_ADVERSARIAL_SHARE` defaulted to 0.4, so a 50-profile night
 * built only ~18 adversarial probes — the break-the-system cohort was a
 * minority. NOW: `AMY_ADVERSARIAL_SHARE` defaults to 1.0 and the catalog keeps
 * only a thin hard floor (`AMY_CATALOG_FLOOR`, default 6, never below 1 while any
 * category exists — coverage must not hit zero), so the adversarial probes take
 * the target down to that floor (~44 of 50). Breadth across all categories is
 * preserved OVER NIGHTS by rotating which categories the thin floor covers, not
 * by reserving every category every night.
 *
 * @param {object} args {targetCount, catalogCategories, share}
 * @returns {{ catalog:number, adversarial:number, catalog_floor:number, share_effective:number }}
 */
export function resolveCohortSplit({ targetCount = 0, catalogCategories = 0, share = null } = {}) {
  const total = Math.max(0, Math.trunc(Number(targetCount) || 0))
  const categories = Math.max(0, Math.trunc(Number(catalogCategories) || 0))
  // The catalog floor is a THIN hard floor: enough to prove fixed archetypes
  // stay fixed and to keep coverage above zero, never enough to make catalog the
  // majority. ≥1 whenever any category exists, capped by AMY_CATALOG_FLOOR, and
  // never larger than the categories that exist or the total itself.
  const declaredFloor = Number(process.env.AMY_CATALOG_FLOOR ?? CATALOG_FLOOR_DEFAULT)
  const floorCap = Number.isFinite(declaredFloor) ? Math.max(0, Math.trunc(declaredFloor)) : CATALOG_FLOOR_DEFAULT
  const catalogFloor = categories > 0 ? Math.min(categories, total, Math.max(1, floorCap)) : 0
  // TRAP (the same one CLAUDE.md documents for the portal-lifetime seed):
  // `Number(null)` is 0 and IS finite, so a bare `Number.isFinite(Number(share))`
  // reads an ABSENT share as a declared 0 and the adversarial cohort silently
  // becomes empty — the whole feature off, reporting success. Reject
  // null/''/undefined BEFORE coercing.
  const declared = share === null || share === undefined || share === ''
    ? Number(process.env.AMY_ADVERSARIAL_SHARE ?? 1.0)
    : Number(share)
  const rawShare = Number.isFinite(declared) ? declared : 1.0
  const wanted = Math.round(total * Math.max(0, Math.min(1, rawShare)))
  const adversarial = Math.max(0, Math.min(wanted, total - catalogFloor))
  const catalog = total - adversarial
  return {
    catalog,
    adversarial,
    catalog_floor: catalogFloor,
    share_effective: total > 0 ? Number((adversarial / total).toFixed(4)) : 0,
  }
}

export default { planGapSeekingProbes, resolveCohortSplit, CATALOG_FLOOR_DEFAULT, W_NEW, W_GAP, W_STALE }
