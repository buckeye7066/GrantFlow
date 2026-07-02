/**
 * archetypeLearning.js — close the Amy→crawler learning loop.
 *
 * Before this module, an Amy training run produced findings (zero results,
 * institution/hyperlocal recall misses, ineligible ACCEPTs) that were recorded
 * in reports and an approval queue — but NOTHING steered the next real crawl
 * from them. The per-profile learned-gap loop (#785) only fires for a REAL
 * profile that already suffered the gap, and Amy's synthetic profiles are
 * reaped after every run, so their lessons died with them.
 *
 * This module generalizes Amy's lessons by ARCHETYPE (student / veteran /
 * senior / nonprofit / …, from crawler-os/archetypes.js):
 *
 *   PRODUCE  — after each Amy run, fold the cohort evaluations into a rolling
 *              system_kv store (`amy_archetype_learning`): per archetype, the
 *              gap classes the crawler proved weak on, with the evidence and
 *              the Amy run/finding that caused it (audit trail).
 *   CONSUME  — the live crawl (crawlerOsService.attachLearnedGaps) classifies
 *              each real profile's thesis with the SAME classifier and merges
 *              the archetype's learned classes into `thesis.learned_gaps`, so
 *              buildWebQueries targets the weakness on the very next crawl.
 *   MEASURE  — per-run, per-archetype before/after metrics are appended to
 *              `amy_archetype_metrics` (rolling history) so the evolution is
 *              verifiable run-over-run and visible to Sam/Anya + the coverage
 *              audit dashboard.
 *
 * SAFETY: learning can only ADD bounded web queries. The learned classes are
 * whitelisted to SAFE_LEARNED_CLASSES — the classes buildWebQueries consumes
 * additively — so a learned evolution can never disable a compliance gate,
 * weaken an eligibility rule, or touch any score floor.
 */

import { classifyThesisArchetype } from '../../crawler-os/archetypes.js'
import { FINDING_TYPES } from './amyConstants.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('services:amy:archetypeLearning')

/** system_kv key: rolling per-archetype learned gap classes (the steering store). */
export const KV_LEARNING_KEY = 'amy_archetype_learning'

/** system_kv key: rolling per-archetype, per-run metrics history (the proof). */
export const KV_METRICS_KEY = 'amy_archetype_metrics'

/** How many runs of per-archetype metrics to retain. */
export const METRICS_HISTORY_MAX = 30

/**
 * The ONLY gap classes learning may emit. These are exactly the classes
 * buildWebQueries consumes ADDITIVELY (extra targeted queries); nothing here
 * can reach an eligibility gate, score floor, or policy registry.
 */
export const SAFE_LEARNED_CLASSES = Object.freeze(['institution_gap', 'hyperlocal_gap', 'low_results'])

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Archetype for one Amy evaluation (prefers the field evaluateDiscovery
 * recorded from the real thesis; re-classifies when a thesis is present; null
 * for skipped/errored evaluations that never produced a thesis — those carry
 * no coverage signal and must not dilute another archetype's rates).
 */
export function evaluationArchetype(evaluation) {
  if (evaluation?.archetype) return String(evaluation.archetype)
  if (evaluation?.thesis) return classifyThesisArchetype(evaluation.thesis)
  return null
}

/**
 * PURE: per-archetype crawler metrics for ONE Amy run. This is the per-run
 * before/after measurement unit: qualified-result and ineligible-accept counts
 * per archetype, so a later run proves whether an evolution worked.
 *
 * @param {Array<object>} evaluations  from amyReport.evaluateDiscovery()
 * @returns {Record<string, object>} archetype -> metrics
 */
export function buildArchetypeMetrics(evaluations = []) {
  const out = {}
  for (const ev of Array.isArray(evaluations) ? evaluations : []) {
    const key = evaluationArchetype(ev)
    if (!key) continue
    const m = out[key] || {
      profiles: 0,
      ok: 0,
      weak: 0,
      zero: 0,
      skipped: 0,
      error: 0,
      qualified: 0,
      ineligible_accepts: 0,
      false_positives: 0,
      institution_misses: 0,
      hyperlocal_misses: 0,
    }
    m.profiles += 1
    if (m[ev.status] !== undefined) m[ev.status] += 1
    m.qualified += num(ev.accepted)
    m.ineligible_accepts += num(ev.ineligible_accepts)
    m.false_positives += num(ev.false_positives)
    const findings = Array.isArray(ev.findings) ? ev.findings : []
    m.institution_misses += findings.filter((f) => f.type === FINDING_TYPES.INSTITUTION_RECALL_MISS).length
    m.hyperlocal_misses += findings.filter((f) => f.type === FINDING_TYPES.HYPERLOCAL_RECALL_MISS).length
    out[key] = m
  }
  for (const m of Object.values(out)) {
    const covered = m.ok
    m.covered_rate = m.profiles > 0 ? Number((covered / m.profiles).toFixed(4)) : 0
  }
  return out
}

/**
 * PURE: derive the per-archetype LEARNED GAP CLASSES from one run's cohort.
 * Conservative by construction: a class only fires with >= minEvidence affected
 * profiles in the archetype, and only whitelisted classes are ever emitted.
 *
 * Audit trail: every entry records which Amy finding types caused it, the
 * evidence counts, and the run id — so "what changed and why" is answerable.
 *
 * @param {Array<object>} evaluations
 * @param {object} opts { runId, at, minEvidence=2 }
 * @returns {Record<string, object>} archetype -> { classes, caused_by, evidence, run_id, at }
 */
export function buildArchetypeLearningUpdate(evaluations = [], { runId = null, at = null, minEvidence = 2 } = {}) {
  const byArchetype = {}
  for (const ev of Array.isArray(evaluations) ? evaluations : []) {
    const key = evaluationArchetype(ev)
    if (!key) continue
    const agg = byArchetype[key] || { profiles: 0, zero: 0, weak: 0, institution: 0, hyperlocal: 0 }
    agg.profiles += 1
    if (ev.status === 'zero') agg.zero += 1
    if (ev.status === 'weak') agg.weak += 1
    const findings = Array.isArray(ev.findings) ? ev.findings : []
    if (findings.some((f) => f.type === FINDING_TYPES.INSTITUTION_RECALL_MISS)) agg.institution += 1
    if (findings.some((f) => f.type === FINDING_TYPES.HYPERLOCAL_RECALL_MISS)) agg.hyperlocal += 1
    byArchetype[key] = agg
  }

  const update = {}
  for (const [key, agg] of Object.entries(byArchetype)) {
    const classes = []
    const causedBy = []
    if (agg.institution >= minEvidence) {
      classes.push('institution_gap')
      causedBy.push(FINDING_TYPES.INSTITUTION_RECALL_MISS)
    }
    if (agg.hyperlocal >= minEvidence) {
      classes.push('hyperlocal_gap')
      causedBy.push(FINDING_TYPES.HYPERLOCAL_RECALL_MISS)
    }
    // "The crawler finds little for this archetype": half or more of the
    // cohort's profiles came back zero/weak (with real evidence volume).
    const lowCount = agg.zero + agg.weak
    if (lowCount >= minEvidence && lowCount / Math.max(1, agg.profiles) >= 0.5) {
      classes.push('low_results')
      causedBy.push(agg.zero >= agg.weak ? FINDING_TYPES.ZERO_RESULT : FINDING_TYPES.WEAK_MATCH)
    }
    const safe = classes.filter((c) => SAFE_LEARNED_CLASSES.includes(c))
    if (safe.length === 0) continue
    update[key] = {
      classes: safe,
      caused_by: causedBy,
      evidence: {
        profiles: agg.profiles,
        zero: agg.zero,
        weak: agg.weak,
        institution_misses: agg.institution,
        hyperlocal_misses: agg.hyperlocal,
      },
      run_id: runId,
      at,
    }
  }
  return update
}

// ── Persistence (system_kv; dialect-agnostic, mirrors liveCrawlGapLearning) ──

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

async function kvGet(db, key) {
  if (!db?.prepare) return null
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get(key)
    if (!row?.value) return null
    return JSON.parse(row.value)
  } catch (err) {
    log.warn('kvGet failed', { key, error: err?.message })
    return null
  }
}

async function kvSet(db, key, obj) {
  await ensureKv(db)
  const now = new Date().toISOString()
  const value = JSON.stringify(obj)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, key)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now)
  }
}

/** Read the rolling archetype learning store (consumed by the live crawl). */
export async function getArchetypeLearning(db) {
  return kvGet(db, KV_LEARNING_KEY)
}

/**
 * Fold one run's learning update into the rolling store. An archetype with a
 * fresh entry is REPLACED (latest evidence wins); an archetype the new run
 * proved HEALTHY (exercised with at least `minEvidence` profiles, no gap
 * classes) is CLEARED — so a fixed weakness stops steering queries instead of
 * steering them forever. A thin cohort (one lucky profile) is NOT allowed to
 * clear a lesson a full run proved: clearing needs the same evidence bar as
 * learning.
 *
 * @param {object} opts { runId, at, cohortArchetypes: string[]|Record<string,number>, minEvidence=2 }
 * @returns {Promise<object>} the new store value
 */
export async function saveArchetypeLearning(db, update, { runId = null, at = null, cohortArchetypes = [], minEvidence = 2 } = {}) {
  if (!db?.prepare) return null
  const prev = (await kvGet(db, KV_LEARNING_KEY)) || {}
  const prevArchetypes = prev.archetypes && typeof prev.archetypes === 'object' ? prev.archetypes : {}
  const nextArchetypes = { ...prevArchetypes }
  // Clear archetypes this run exercised (with enough profiles) and found healthy.
  const clearable = Array.isArray(cohortArchetypes)
    ? cohortArchetypes // legacy list form: every listed archetype may clear
    : Object.entries(cohortArchetypes || {})
        .filter(([, count]) => Number(count) >= minEvidence)
        .map(([key]) => key)
  for (const key of clearable) {
    if (!update?.[key]) delete nextArchetypes[key]
  }
  for (const [key, entry] of Object.entries(update || {})) {
    nextArchetypes[key] = {
      ...entry,
      classes: (entry.classes || []).filter((c) => SAFE_LEARNED_CLASSES.includes(c)),
    }
  }
  const next = {
    archetypes: nextArchetypes,
    updated_run_id: runId,
    updated_at: at || new Date().toISOString(),
    source: 'amy_archetype_learning',
  }
  await kvSet(db, KV_LEARNING_KEY, next)
  return next
}

/**
 * Learned gap classes for one live thesis (whitelisted; empty when nothing
 * learned). Used by crawlerOsService.attachLearnedGaps.
 */
export function learnedClassesForThesis(store, thesis) {
  const key = classifyThesisArchetype(thesis || {})
  const entry = store?.archetypes?.[key]
  const classes = Array.isArray(entry?.classes) ? entry.classes.filter((c) => SAFE_LEARNED_CLASSES.includes(c)) : []
  return { archetype: key, classes, run_id: entry?.run_id ?? null }
}

/** Append one run's per-archetype metrics to the rolling history (capped). */
export async function appendArchetypeMetrics(db, { runId, at, metrics }) {
  if (!db?.prepare) return null
  const prev = (await kvGet(db, KV_METRICS_KEY)) || {}
  const runs = Array.isArray(prev.runs) ? prev.runs : []
  const row = { run_id: runId ?? null, at: at ?? new Date().toISOString(), archetypes: metrics || {} }
  const next = { runs: [row, ...runs].slice(0, METRICS_HISTORY_MAX), updated_at: row.at }
  await kvSet(db, KV_METRICS_KEY, next)
  return next
}

/** Read the per-archetype metrics history (Sam/Anya + coverage audit). */
export async function readArchetypeMetrics(db) {
  return kvGet(db, KV_METRICS_KEY)
}

export default {
  KV_LEARNING_KEY,
  KV_METRICS_KEY,
  METRICS_HISTORY_MAX,
  SAFE_LEARNED_CLASSES,
  evaluationArchetype,
  buildArchetypeMetrics,
  buildArchetypeLearningUpdate,
  getArchetypeLearning,
  saveArchetypeLearning,
  learnedClassesForThesis,
  appendArchetypeMetrics,
  readArchetypeMetrics,
}
