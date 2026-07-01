/**
 * liveCrawlGapLearning.js — make Anya and Sam learn from crawler gaps GLOBALLY,
 * on EVERY live discovery call, not just Amy's synthetic cohort or the nightly
 * coverage sweep.
 *
 * The Amy→Anya→Sam loop already knows how to turn a discovery outcome into
 * structured "gaps" (institution / hyperlocal / low-results / ineligible /
 * surfacing-regression) via `auditProfileResultCoverage`. Until now that audit
 * only ran for synthetic Amy profiles or in the offline nightly sweep, so real
 * production crawls taught the agents nothing in real time.
 *
 * This module hangs a single best-effort hook off the ONE global discovery
 * choke-point (`runProfileDiscoveryLive` in crawlerOsService.js). After every
 * live crawl it:
 *
 *   1. reuses `auditProfileResultCoverage` (NO detection drift) to find gaps,
 *   2. folds the outcome into a rolling, observable learning store in
 *      `system_kv` (key `crawler_gap_learning`) that Sam's diagnostics read,
 *   3. writes the pattern into Anya's brain (`anya_brain_memory`) so Anya learns
 *      per-profile, and
 *   4. records low-coverage telemetry (reusing the existing table) for trending.
 *
 * Everything is best-effort and wrapped so it can NEVER block or fail a crawl —
 * learning is observability, not a critical path.
 *
 * Detection lives in profileResultCoverageAudit.js; the pure store-fold below
 * (`buildGapLearningUpdate`) is separated from I/O so it is unit-testable with
 * plain fixtures, mirroring the rest of the coverageAudit module.
 */

import { DEFAULT_MIN_SCORE } from '../../config/matchThresholds.js'
import { auditProfileResultCoverage } from './profileResultCoverageAudit.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('coverage:liveGapLearning')

/** system_kv key holding the rolling live-crawl gap learning store. */
export const KV_KEY = 'crawler_gap_learning'

/** How many recent gap events to retain in the rolling store. */
export const RECENT_CAP = 50

/** TTL for the per-profile pattern written into Anya's brain. */
const MEMORY_TTL_DAYS = 30

/** The gap classes we learn from, in priority order (worst first). */
export const GAP_CLASSES = Object.freeze([
  'surfacing_regression',
  'ineligible_surfaced_match',
  'institution_gap',
  'hyperlocal_gap',
  'low_results',
])

/** Global on/off (default ON). Set CRAWLER_GAP_LEARNING_ENABLED=false to disable. */
export function isCrawlerGapLearningEnabled() {
  return String(process.env.CRAWLER_GAP_LEARNING_ENABLED ?? 'true').toLowerCase() !== 'false'
}

/** Map a coverage audit → the flat list of gap-class keys present in it. */
export function classifyGaps(audit) {
  if (!audit || typeof audit !== 'object') return []
  const out = []
  if (audit.surfacing_gap) out.push('surfacing_regression')
  if (audit.ineligible_surfaced_match) out.push('ineligible_surfaced_match')
  if (audit.institution_gap) out.push('institution_gap')
  if (audit.hyperlocal_gap) out.push('hyperlocal_gap')
  if (audit.low_results) out.push('low_results')
  return out
}

/**
 * PURE: fold one profile's coverage audit into the rolling learning store.
 * Always counts the call; only records a `recent` entry (and per-class tallies)
 * when the crawl actually surfaced a gap. No I/O — unit-testable with fixtures.
 *
 * @param {object|null} prev   previous store value (from getCrawlerGapLearning)
 * @param {object} audit       an auditProfileResultCoverage(FromData) result
 * @param {object} meta        { profileId, displayName, at }
 * @returns {{ totals:object, recent:Array, updated_at:string }}
 */
export function buildGapLearningUpdate(prev, audit, { profileId, displayName = null, at } = {}) {
  const base = prev && typeof prev === 'object' ? prev : {}
  const prevTotals = base.totals && typeof base.totals === 'object' ? base.totals : {}
  const totals = {
    calls: Number(prevTotals.calls) || 0,
    with_gap: Number(prevTotals.with_gap) || 0,
    by_class: { ...(prevTotals.by_class || {}) },
  }

  totals.calls += 1
  const classes = classifyGaps(audit)
  if (classes.length > 0) {
    totals.with_gap += 1
    for (const c of classes) totals.by_class[c] = (Number(totals.by_class[c]) || 0) + 1
  }

  let recent = Array.isArray(base.recent) ? base.recent.slice() : []
  if (classes.length > 0) {
    recent.unshift({
      profile_id: profileId ?? null,
      display_name: displayName ?? null,
      classes,
      gaps: Array.isArray(audit?.gaps) ? audit.gaps : [],
      surfaced_qualifying: audit?.surfaced_qualifying ?? null,
      needs_rediscovery: Boolean(audit?.needs_rediscovery),
      at: at ?? null,
    })
    recent = recent.slice(0, RECENT_CAP)
  }

  return { totals, recent, updated_at: at ?? base.updated_at ?? null }
}

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

/** Read the rolling learning store (for Sam diagnostics / Anya owner tools). */
export async function getCrawlerGapLearning(db) {
  if (!db?.prepare) return null
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get(KV_KEY)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    return { ...parsed, updated_at: row.updated_at ?? parsed.updated_at ?? null }
  } catch {
    return null
  }
}

async function writeStore(db, store) {
  await ensureKv(db)
  const now = store.updated_at || new Date().toISOString()
  const value = JSON.stringify(store)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, KV_KEY)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, value, now)
  }
}

/**
 * The global hook. Audits the just-crawled profile's RESULT coverage and records
 * any gap into the shared learning store (Sam) + Anya's brain (Anya) + low-
 * coverage telemetry. Best-effort: catches everything and never throws.
 *
 * @param {object} db
 * @param {object} args { profileId, thesis?, displayName? }
 * @returns {Promise<object>} a small summary of what was learned (for logs/tests)
 */
export async function learnFromCrawlGaps(db, { profileId, thesis = null, displayName = null } = {}) {
  if (!isCrawlerGapLearningEnabled()) return { skipped: true, reason: 'disabled' }
  if (!db?.prepare || !profileId) return { skipped: true, reason: 'no_db_or_profile' }

  try {
    // 1. Detect gaps using the EXISTING audit (no detection drift). Passing the
    //    already-built thesis avoids a rebuild; the audit falls back to loading
    //    it when absent.
    const audit = await auditProfileResultCoverage(db, profileId, thesis ? { thesis } : {})
    const at = new Date().toISOString()

    // 2. Fold into the rolling, observable learning store (Sam reads this).
    const prev = await getCrawlerGapLearning(db)
    const next = buildGapLearningUpdate(prev, audit, { profileId, displayName, at })
    await writeStore(db, next)

    if (!audit.has_gap) return { ok: true, has_gap: false }

    const classes = classifyGaps(audit)

    // 3. Anya learns — persist the per-profile pattern into her brain.
    try {
      const { storeMemory } = await import('../anyaBrainService.js')
      const expiresAt = new Date(Date.now() + MEMORY_TTL_DAYS * 86400000).toISOString()
      await storeMemory(db, {
        scope: 'profile',
        scopeId: String(profileId),
        memoryType: 'learned_pattern',
        memoryKey: 'crawler_gap',
        content: {
          gaps: audit.gaps,
          classes,
          needs_rediscovery: Boolean(audit.needs_rediscovery),
          surfaced_qualifying: audit.surfaced_qualifying ?? null,
          missing_schools: audit.missing_schools || [],
          observed_at: at,
        },
        confidence: 0.9,
        source: 'crawler_gap_learning',
        expiresAt,
      })
    } catch (err) {
      log.warn('anya brain write failed (non-fatal)', { profile: profileId, error: err?.message })
    }

    // 4. Sam telemetry — reuse the existing low-coverage table for the low_results
    //    class so trending stays in one place.
    if (audit.low_results) {
      try {
        const { recordLowCoverageEvent } = await import('../matching/professionalDevelopmentPolicy.js')
        await recordLowCoverageEvent(db, {
          profileId,
          qualifiedCount: audit.surfaced_qualifying ?? 0,
          minScore: DEFAULT_MIN_SCORE,
        })
      } catch {
        /* best-effort telemetry */
      }
    }

    return { ok: true, has_gap: true, classes, gaps: audit.gaps }
  } catch (err) {
    log.warn('learnFromCrawlGaps failed (non-fatal)', { profile: profileId, error: err?.message })
    return { ok: false, error: err?.message }
  }
}

export default {
  KV_KEY,
  RECENT_CAP,
  GAP_CLASSES,
  isCrawlerGapLearningEnabled,
  classifyGaps,
  buildGapLearningUpdate,
  getCrawlerGapLearning,
  learnFromCrawlGaps,
}
