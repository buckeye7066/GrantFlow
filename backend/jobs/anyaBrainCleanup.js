// backend/jobs/anyaBrainCleanup.js
//
// Daily cleanup of Anya brain + usage tables so the memory store doesn't
// grow unbounded. Matches the intent of admin.brain.cleanup but runs from
// a cron so admin scans don't have to trigger it manually.
//
// Deletes:
//   1. Expired memories whose TTL has passed.
//   2. Tool usage rows older than 30 days.
//
// Usage (from server.js):
//   import { startAnyaBrainCleanupCron } from './jobs/anyaBrainCleanup.js'
//   startAnyaBrainCleanupCron({ db, logger })
//
// Idempotent — safe to call multiple times (newer call replaces the timer).

import { cleanupMemories } from '../services/anyaBrainService.js'
import { withProfileScope } from '../middleware/profileContext.js'

let _timer = null

const DAY_MS = 24 * 60 * 60 * 1000
const USAGE_RETENTION_DAYS = Number(process.env.ANYA_USAGE_RETENTION_DAYS || 30)

async function runCleanupOnce(db, logger = console) {
  const started = Date.now()
  try {
    // 1. Expired memories (TTL-based). anyaBrainService owns the semantics.
    const expired = await withProfileScope({ bypass: true, actorRole: 'admin_global' }, () => cleanupMemories(db))

    // 2. Old tool usage rows (fixed retention window).
    let usageDeleted = 0
    try {
      const cutoff = new Date(Date.now() - USAGE_RETENTION_DAYS * DAY_MS).toISOString()
      const res = await withProfileScope({ bypass: true, actorRole: 'admin_global' }, () =>
        db.prepare('DELETE FROM anya_tool_usage WHERE created_at < ?').run(cutoff),
      )
      usageDeleted = res?.changes ?? 0
    } catch (err) {
      logger.warn?.('[anyaBrainCleanup] anya_tool_usage purge skipped:', err?.message || err)
    }

    logger.info?.(
      `[anyaBrainCleanup] expired_memories=${expired?.deleted ?? 0} usage_deleted=${usageDeleted} duration_ms=${Date.now() - started}`,
    )
    return { expired, usageDeleted }
  } catch (err) {
    logger.error?.('[anyaBrainCleanup] failed:', err?.message || err)
    return { error: err?.message || String(err) }
  }
}

export function startAnyaBrainCleanupCron({ db, logger = console, intervalMs = DAY_MS } = {}) {
  if (_timer) clearInterval(_timer)
  // Run once shortly after boot so dev environments get an immediate signal.
  const kickoff = setTimeout(() => runCleanupOnce(db, logger), 30_000)
  kickoff.unref?.()
  _timer = setInterval(() => runCleanupOnce(db, logger), intervalMs)
  _timer.unref?.()
  return {
    stop() {
      if (_timer) {
        clearInterval(_timer)
        _timer = null
      }
    },
    runNow: () => runCleanupOnce(db, logger),
  }
}

export { runCleanupOnce as runAnyaBrainCleanupOnce }
