/**
 * behaviorLearning.js — User-behavior learning as SOFT preference signals.
 *
 * Architecture P2 + canonical rule #12: when a user SAVES / APPLIES-TO /
 * DISMISSES-REJECTS opportunities, those actions nudge future matching toward
 * what they value. This is SOFT preference learning, NOT hard filtering:
 *
 *   - saves a housing grant      → ↑ housing weight
 *   - applies to a scholarship   → ↑ student/education weight
 *   - rejects a loan             → ↓ loan-like sources
 *   - saves a local foundation   → ↑ local-foundation priority
 *   - ignores broad national     → ↓ generic national
 *
 * The output is a SMALL, BOUNDED preference vector consumed by matchEngine's
 * scoreOpportunity (optional `preferenceSignals` input). It can only add or
 * subtract a few clamped points AFTER the weighted score; it NEVER eliminates a
 * match, and when there is no behavior data the vector is empty → ZERO change.
 *
 * Everything here is best-effort: recordBehaviorEvent never throws, and
 * getProfilePreferenceSignals returns an empty (no-op) vector on any failure or
 * when the feature is disabled. The whole feature is gated behind
 * BEHAVIOR_LEARNING_ENABLED.
 *
 * Self-healing schema: ensureBehaviorEventsSchema runs the same DDL as the
 * boot-time invariant idempotently, so recording works even on a DB where the
 * invariant step hasn't run yet (mirrors pipelineDismissals.js posture).
 */

import crypto from 'node:crypto'
import { safeParseArrayField } from './profileHelpers.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { createLogger } from '../utils/logger.js'
import {
  BEHAVIOR_SIGNAL_MAX,
  BEHAVIOR_NUDGE_MAX,
  BEHAVIOR_WEIGHT_APPLIED,
  BEHAVIOR_WEIGHT_SAVED,
  BEHAVIOR_WEIGHT_DISMISSED,
  BEHAVIOR_WEIGHT_IGNORED,
  BEHAVIOR_RECENCY_WINDOW_DAYS,
  BEHAVIOR_DECAY_HALF_LIFE_DAYS,
  BEHAVIOR_MAX_EVENTS,
} from '../config/matchThresholds.js'

const log = createLogger('service:behaviorLearning')

export const BEHAVIOR_ACTIONS = ['saved', 'applied', 'dismissed', 'ignored']

const ACTION_WEIGHT = {
  saved: BEHAVIOR_WEIGHT_SAVED,
  applied: BEHAVIOR_WEIGHT_APPLIED,
  dismissed: BEHAVIOR_WEIGHT_DISMISSED,
  ignored: BEHAVIOR_WEIGHT_IGNORED,
}

/**
 * Feature gate. Default ON — the nudge is mathematically a no-op when there is
 * no behavior data, so enabling it by default is safe and lets the system learn
 * from real activity without an operator flag flip. Set
 * BEHAVIOR_LEARNING_ENABLED=0 (or false/off/no) to hard-disable.
 */
export function isBehaviorLearningEnabled() {
  const raw = String(process.env.BEHAVIOR_LEARNING_ENABLED ?? '').trim().toLowerCase()
  if (raw === '') return true // default ON
  return !['0', 'false', 'off', 'no'].includes(raw)
}

// ---------------------------------------------------------------------------
// Schema self-heal (mirrors the boot-time invariant in ensureSchemaInvariants)
// ---------------------------------------------------------------------------

const ensuredDbs = new WeakSet()
const ensurePromises = new WeakMap()

export async function ensureBehaviorEventsSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredDbs.has(db)) return
  if (ensurePromises.has(db)) return ensurePromises.get(db)

  const ensurePromise = (async () => {
    const isPostgres = db?.dialect === 'postgres'
    const createTable = isPostgres
      ? `
          CREATE TABLE IF NOT EXISTS behavior_events (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            action TEXT NOT NULL
              CHECK (action IN ('saved', 'applied', 'dismissed', 'ignored')),
            opportunity_source TEXT,
            opportunity_categories JSONB,
            need_types JSONB,
            is_local BOOLEAN,
            ts TIMESTAMPTZ NOT NULL DEFAULT now()
          );
        `
      : `
          CREATE TABLE IF NOT EXISTS behavior_events (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            action TEXT NOT NULL
              CHECK (action IN ('saved', 'applied', 'dismissed', 'ignored')),
            opportunity_source TEXT,
            opportunity_categories TEXT,
            need_types TEXT,
            is_local INTEGER,
            ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
        `
    await db.prepare(createTable).run()
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_behavior_events_profile ON behavior_events(profile_id);')
      .run()
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_behavior_events_profile_ts ON behavior_events(profile_id, ts);')
      .run()
    ensuredDbs.add(db)
  })()

  ensurePromises.set(db, ensurePromise)
  try {
    return await ensurePromise
  } finally {
    ensurePromises.delete(db)
  }
}

// ---------------------------------------------------------------------------
// Opportunity → event-feature extraction
// ---------------------------------------------------------------------------

function normFamily(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return s.length ? s.replace(/[\s-]+/g, '_') : null
}

/**
 * Extract the bounded soft-signal features from an opportunity for storage.
 * Best-effort and dialect-agnostic; returns plain JSON-serializable data.
 */
export function extractOpportunityFeatures(opportunity = {}) {
  const opp = opportunity || {}

  // Source family — prefer explicit source, fall back to record_origin, then a
  // coarse "loan" / "national" family inferred from the row.
  const source =
    normFamily(opp.source) ??
    normFamily(opp.record_origin) ??
    normFamily(opp.opportunity_type) ??
    null

  const categories = [
    ...safeParseArrayField(opp.categories, []),
  ]
    .map((c) => normFamily(c))
    .filter(Boolean)

  const needTypes = [
    ...safeParseArrayField(opp.need_types_supported, []),
    ...safeParseArrayField(opp.need_types, []),
  ]
    .map((n) => normFamily(n))
    .filter(Boolean)

  // is_local: true when the opportunity is explicitly NOT national and carries a
  // state/county/city scope. null when we genuinely cannot tell (neutral).
  let isLocal = null
  const isNational =
    opp.is_national === true || opp.is_national === 1 || opp.is_national === '1' ||
    String(opp.geo_scope ?? opp.geographic_scope ?? '').toLowerCase() === 'national'
  const hasLocalScope = Boolean(
    opp.state || opp.county || opp.city ||
    ['state', 'county', 'city', 'local', 'regional'].includes(
      String(opp.geo_scope ?? opp.geographic_scope ?? '').toLowerCase(),
    ),
  )
  if (isNational) isLocal = false
  else if (hasLocalScope) isLocal = true

  // Loan-like detection feeds a "loan" source-family signal so rejecting a loan
  // can down-weight loan-like sources (rule #12 example).
  const looksLikeLoan = Boolean(
    opp.is_loan === true || opp.is_loan === 1 ||
    /\bloan\b|microloan/i.test(`${opp.title || ''} ${opp.opportunity_type || ''} ${opp.funding_type || ''}`),
  )

  // Local-foundation detection feeds a "local_foundation" source-family signal.
  const looksLikeFoundation = /\bfoundation\b/i.test(`${opp.title || ''} ${opp.sponsor || ''} ${opp.funder || ''}`)

  const sourceFamilies = []
  if (source) sourceFamilies.push(source)
  if (looksLikeLoan) sourceFamilies.push('loan')
  if (looksLikeFoundation && isLocal === true) sourceFamilies.push('local_foundation')
  else if (looksLikeFoundation) sourceFamilies.push('foundation')

  // `opportunity_source` is a SINGLE stored column, so it carries the most
  // decision-relevant source family (rule #12 cares about loans + local
  // foundations more than the generic crawl origin). When the persisted event
  // is read back for aggregation, this string is mapped through the same family
  // set so a "loan" rejection actually down-weights loan-like sources.
  const primarySource = looksLikeLoan
    ? 'loan'
    : looksLikeFoundation && isLocal === true
      ? 'local_foundation'
      : source

  return {
    opportunity_source: primarySource,
    opportunity_categories: categories,
    need_types: needTypes,
    is_local: isLocal,
    _sourceFamilies: sourceFamilies,
  }
}

// ---------------------------------------------------------------------------
// recordBehaviorEvent
// ---------------------------------------------------------------------------

/**
 * Record a single behavior event. Best-effort: NEVER throws, NEVER blocks the
 * caller's normal flow. Returns { recorded: boolean, reason? }.
 *
 * @param {object} db
 * @param {object} args
 * @param {string} args.profileId
 * @param {'saved'|'applied'|'dismissed'|'ignored'} args.action
 * @param {object} args.opportunity raw opportunity (or grant-from-opportunity)
 */
export async function recordBehaviorEvent(db, { profileId, action, opportunity } = {}) {
  try {
    if (!isBehaviorLearningEnabled()) return { recorded: false, reason: 'disabled' }
    if (!db || typeof db.prepare !== 'function') return { recorded: false, reason: 'no_db' }
    const profile = String(profileId ?? '').trim()
    if (!profile) return { recorded: false, reason: 'no_profile_id' }
    const act = String(action ?? '').trim().toLowerCase()
    if (!BEHAVIOR_ACTIONS.includes(act)) return { recorded: false, reason: 'bad_action' }

    await ensureBehaviorEventsSchema(db)

    const f = extractOpportunityFeatures(opportunity || {})
    const id = crypto.randomUUID()
    const isPostgres = db?.dialect === 'postgres'
    const localVal = f.is_local === null ? null : isPostgres ? f.is_local : f.is_local ? 1 : 0

    await db
      .prepare(
        `INSERT INTO behavior_events
           (id, profile_id, action, opportunity_source, opportunity_categories, need_types, is_local)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        profile,
        act,
        f.opportunity_source,
        JSON.stringify(f.opportunity_categories || []),
        JSON.stringify(f.need_types || []),
        localVal,
      )
    return { recorded: true, id }
  } catch (err) {
    // Best-effort: a learning-signal write must never affect the action path.
    log.warn('recordBehaviorEvent failed (non-fatal)', { error: String(err?.message || err) })
    return { recorded: false, reason: 'error' }
  }
}

// ---------------------------------------------------------------------------
// getProfilePreferenceSignals — aggregate recent events into a soft vector
// ---------------------------------------------------------------------------

function clampSignal(v) {
  return Math.max(-BEHAVIOR_SIGNAL_MAX, Math.min(BEHAVIOR_SIGNAL_MAX, v))
}

function decayWeight(ageDays) {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1
  return Math.pow(0.5, ageDays / BEHAVIOR_DECAY_HALF_LIFE_DAYS)
}

function parseTs(ts) {
  if (ts === null || ts === undefined) return Date.now()
  if (ts instanceof Date) return ts.getTime()
  const n = Date.parse(String(ts))
  return Number.isFinite(n) ? n : Date.now()
}

/**
 * Build an EMPTY (no-op) preference vector. scoreOpportunity treats this as
 * "no behavior data" → zero nudge, identical score.
 */
export function emptyPreferenceSignals() {
  return { categories: {}, needs: {}, sources: {}, locality: 0, eventCount: 0 }
}

/**
 * Aggregate a profile's recent behavior events into a SMALL bounded
 * soft-preference vector. Returns a plain object (cache-friendly):
 *
 *   {
 *     categories: { housing: +2.4, ... },   // per-category nudge (clamped ±MAX)
 *     needs:      { education: +1.8, ... },  // per-need nudge      (clamped ±MAX)
 *     sources:    { loan: -2.1, local_foundation: +1.2, national: -0.8, ... },
 *     locality:   +1.5,                      // overall local-vs-national lean
 *     eventCount: N,
 *   }
 *
 * Each interaction contributes ACTION_WEIGHT[action] × recency-decay to every
 * feature it carries; the per-feature totals are then clamped to
 * ±BEHAVIOR_SIGNAL_MAX. No behavior data → emptyPreferenceSignals() (no-op).
 */
export async function getProfilePreferenceSignals(db, profileId) {
  try {
    if (!isBehaviorLearningEnabled()) return emptyPreferenceSignals()
    if (!db || typeof db.prepare !== 'function') return emptyPreferenceSignals()
    const profile = String(profileId ?? '').trim()
    if (!profile) return emptyPreferenceSignals()

    await ensureBehaviorEventsSchema(db)

    const rows = await db
      .prepare(
        `SELECT action, opportunity_source, opportunity_categories, need_types, is_local, ts
           FROM behavior_events
          WHERE profile_id = ?
          ORDER BY ts DESC
          LIMIT ${Math.max(1, Number(BEHAVIOR_MAX_EVENTS) || 500)}`,
      )
      .all(profile)

    if (!Array.isArray(rows) || rows.length === 0) return emptyPreferenceSignals()

    const now = Date.now()
    const windowMs = BEHAVIOR_RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const categories = {}
    const needs = {}
    const sources = {}
    let localityAccum = 0
    let counted = 0

    const bump = (bag, key, delta) => {
      if (!key) return
      bag[key] = (bag[key] ?? 0) + delta
    }

    for (const row of rows) {
      const act = String(row.action ?? '').toLowerCase()
      const weight = ACTION_WEIGHT[act]
      if (weight === undefined) continue

      const tsMs = parseTs(row.ts)
      const ageDays = (now - tsMs) / (24 * 60 * 60 * 1000)
      if (now - tsMs > windowMs) continue // outside recency window — drop
      const w = weight * decayWeight(ageDays)
      counted++

      const cats = safeParseJSON(row.opportunity_categories, []) || []
      for (const c of Array.isArray(cats) ? cats : []) bump(categories, normFamily(c), w)

      const nts = safeParseJSON(row.need_types, []) || []
      for (const n of Array.isArray(nts) ? nts : []) bump(needs, normFamily(n), w)

      const src = normFamily(row.opportunity_source)
      if (src) bump(sources, src, w)

      // Locality lean + generic-national down-weight.
      const isLocal = row.is_local === true || row.is_local === 1 || row.is_local === '1'
      const isNational = row.is_local === false || row.is_local === 0 || row.is_local === '0'
      if (isLocal) {
        localityAccum += w
        bump(sources, 'local', w)
      } else if (isNational) {
        // ignoring/dismissing broad national → ↓ generic national; saving a
        // national → small ↑. Either way it is the same signed weight.
        localityAccum -= w
        bump(sources, 'national', w)
      }
    }

    if (counted === 0) return emptyPreferenceSignals()

    const clampBag = (bag) => {
      const out = {}
      for (const [k, v] of Object.entries(bag)) {
        const c = clampSignal(v)
        // Drop dead-zero entries so the vector stays small/cache-friendly.
        if (Math.abs(c) >= 0.01) out[k] = Math.round(c * 100) / 100
      }
      return out
    }

    return {
      categories: clampBag(categories),
      needs: clampBag(needs),
      sources: clampBag(sources),
      locality: clampSignal(localityAccum),
      eventCount: counted,
    }
  } catch (err) {
    log.warn('getProfilePreferenceSignals failed (non-fatal)', { error: String(err?.message || err) })
    return emptyPreferenceSignals()
  }
}

// ---------------------------------------------------------------------------
// computePreferenceNudge — the bounded additive nudge for ONE opportunity
// ---------------------------------------------------------------------------

/**
 * Given a profile's preference vector and ONE opportunity, compute the SMALL
 * bounded additive nudge (clamped to ±BEHAVIOR_NUDGE_MAX) plus a human-readable
 * reason. When the vector is empty/absent → { nudge: 0, reason: null } (no-op).
 *
 * This is a PURE function (no DB read) so matchEngine can call it per-opportunity
 * without per-call IO; the vector is loaded once per profile per batch upstream.
 *
 * @returns {{ nudge: number, reason: string|null, contributions: object }}
 */
export function computePreferenceNudge(preferenceSignals, opportunity) {
  const noop = { nudge: 0, reason: null, contributions: {} }
  if (!preferenceSignals || typeof preferenceSignals !== 'object') return noop
  const { categories = {}, needs = {}, sources = {}, locality = 0 } = preferenceSignals
  if (
    Object.keys(categories).length === 0 &&
    Object.keys(needs).length === 0 &&
    Object.keys(sources).length === 0 &&
    !locality
  ) {
    return noop
  }

  const f = extractOpportunityFeatures(opportunity || {})
  const contributions = {}
  let total = 0

  const add = (label, value) => {
    if (!Number.isFinite(value) || value === 0) return
    contributions[label] = (contributions[label] ?? 0) + value
    total += value
  }

  for (const c of f.opportunity_categories || []) add(`category:${c}`, categories[c] ?? 0)
  for (const n of f.need_types || []) add(`need:${n}`, needs[n] ?? 0)
  for (const s of f._sourceFamilies || []) add(`source:${s}`, sources[s] ?? 0)

  if (f.is_local === true) {
    add('locality:local', locality > 0 ? locality : 0)
    add('source:local', sources.local ?? 0)
  } else if (f.is_local === false) {
    // Down-weight generic national for users who skip them.
    add('locality:national', locality < 0 ? locality : 0)
    add('source:national', sources.national ?? 0)
  }

  const nudge = Math.round(Math.max(-BEHAVIOR_NUDGE_MAX, Math.min(BEHAVIOR_NUDGE_MAX, total)))
  if (nudge === 0) return { nudge: 0, reason: null, contributions }

  // Build a short, friendly reason naming the dominant driver.
  let dominantLabel = null
  let dominantAbs = 0
  for (const [label, value] of Object.entries(contributions)) {
    if (Math.abs(value) > dominantAbs) {
      dominantAbs = Math.abs(value)
      dominantLabel = label
    }
  }
  const driver = dominantLabel ? dominantLabel.split(':')[1] : 'your activity'
  const verb = nudge >= 0 ? 'tend to save' : 'tend to skip'
  const reason = `Your activity: ${nudge >= 0 ? '+' : ''}${nudge} (you ${verb} ${String(driver).replace(/_/g, ' ')})`

  return { nudge, reason, contributions }
}
