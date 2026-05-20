/**
 * Daily profile-aware auto-discovery scheduler.
 *
 * Runs triggerAutoDiscoveryCrawlers() for each active profile once per day,
 * using the same profile/sections/signals logic as login auto-discovery.
 * Skips profiles already crawled today unless material profile content changed.
 */

import { triggerAutoDiscoveryCrawlers } from './autoDiscoveryCrawlers.js'
import { computeProfileDigest } from './profileHelpers.js'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('scheduledAutoDiscovery')

const DISCOVERY_REQUESTERS = ['auto-discovery', 'scheduled-auto-discovery']

const CONFIG = {
  enabled: process.env.AUTO_DISCOVERY_DAILY_ENABLED === 'true',
  hour: Number.parseInt(process.env.AUTO_DISCOVERY_DAILY_HOUR ?? '3', 10) || 3,
}

let _lastBatchRunDate = null

function utcDayStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function parseJobParameters(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function getScheduledAutoDiscoveryConfig() {
  return { ...CONFIG }
}

/**
 * Decide whether a profile should receive a scheduled discovery batch.
 */
export async function shouldRunProfileDailyDiscovery(db, profileId) {
  const digest = await computeProfileDigest(db, profileId)
  const placeholders = DISCOVERY_REQUESTERS.map(() => '?').join(', ')

  const last = await db
    .prepare(
      `
        SELECT created_at, parameters
        FROM crawler_jobs
        WHERE profile_id = ?
          AND requested_by IN (${placeholders})
        ORDER BY created_at DESC
        LIMIT 1
      `,
    )
    .get(profileId, ...DISCOVERY_REQUESTERS)

  if (!last) {
    return { run: true, digest, reason: 'never_ran' }
  }

  const params = parseJobParameters(last.parameters)
  const lastDigest = params._profile_digest ?? null

  if (lastDigest && digest && lastDigest !== digest) {
    return { run: true, digest, reason: 'profile_changed' }
  }

  const lastAt = new Date(last.created_at)
  const todayStart = utcDayStart()
  if (!Number.isNaN(lastAt.getTime()) && lastAt >= todayStart) {
    return { run: false, digest, reason: 'already_ran_today' }
  }

  return { run: true, digest, reason: 'daily' }
}

/**
 * Queue profile-aware discovery crawlers for all eligible active profiles.
 */
export async function runScheduledAutoDiscovery(db, options = {}) {
  const enabled = options.forceEnabled ?? CONFIG.enabled
  const report = {
    started_at: new Date().toISOString(),
    enabled,
    profiles_total: 0,
    profiles_queued: 0,
    profiles_skipped: 0,
    skip_reasons: {},
    errors: [],
  }

  if (!enabled) {
    return { ...report, skipped: true, reason: 'disabled' }
  }

  const profiles = await db
    .prepare(`SELECT id, display_name FROM profiles WHERE status = 'active'`)
    .all()

  report.profiles_total = Array.isArray(profiles) ? profiles.length : 0

  for (const profile of profiles || []) {
    try {
      const decision = await shouldRunProfileDailyDiscovery(db, profile.id)
      if (!decision.run) {
        report.profiles_skipped += 1
        report.skip_reasons[decision.reason] = (report.skip_reasons[decision.reason] || 0) + 1
        continue
      }

      await triggerAutoDiscoveryCrawlers(db, profile.id, {
        uploadDir: options.uploadDir,
        getOpenAI: options.getOpenAI,
        requestedBy: 'scheduled-auto-discovery',
        profileDigest: decision.digest,
        trigger: 'scheduled_daily',
      })

      report.profiles_queued += 1
    } catch (err) {
      report.errors.push({
        profile_id: profile.id,
        error: err?.message || String(err),
      })
    }
  }

  report.completed_at = new Date().toISOString()

  try {
    await logAuditEvent(db, {
      category: AUDIT_CATEGORIES.SYSTEM,
      action: 'scheduled_auto_discovery.batch_complete',
      severity: report.errors.length > 0 ? SEVERITY.WARN : SEVERITY.INFO,
      details: report,
    })
  } catch (auditErr) {
    console.warn('[scheduled-auto-discovery] audit log failed:', auditErr?.message || auditErr)
  }

  return report
}

/**
 * Hourly guard invoked from server background interval (every 30 min).
 * Runs the daily batch once per calendar day at CONFIG.hour (default 3 AM local).
 */
export async function checkScheduledAutoDiscovery(db, options = {}) {
  const enabled = options.forceEnabled ?? CONFIG.enabled
  if (!enabled) return null

  const now = new Date()
  if (now.getHours() !== CONFIG.hour) return null

  const today = now.toISOString().slice(0, 10)
  if (_lastBatchRunDate === today) return null

  log.info('[scheduled-auto-discovery] Starting daily profile-aware discovery batch...')
  try {
    const result = await runScheduledAutoDiscovery(db, options)
    _lastBatchRunDate = today
    log.info(
      `[scheduled-auto-discovery] Batch complete: ${result.profiles_queued} queued, ${result.profiles_skipped} skipped`,
    )
    return result
  } catch (err) {
    console.error('[scheduled-auto-discovery] Batch failed:', err?.message || err)
    throw err
  }
}

/** Test helper — reset in-memory daily guard. */
export function resetScheduledAutoDiscoveryStateForTests() {
  _lastBatchRunDate = null
}
