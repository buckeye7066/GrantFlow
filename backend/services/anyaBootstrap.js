/**
 * Anya Bootstrap Module
 *
 * Single entry point for all Anya startup orchestration.
 * Replaces scattered startup logic previously spread across server.js.
 *
 * Call bootstrapAnya(db) once after the server is listening.
 * This function never throws — all errors are caught and logged.
 */

import { runStartupOperations } from './anyaStartupOperations.js'
import { startHealthService } from './anyaHealthService.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('anyaBootstrap')
import {
  runOnStartup,
  startBackgroundCodeCrawlAndRepair,
  checkSchedule,
} from './anyaAutonomousScheduler.js'
import { checkScheduledAutoDiscovery } from './scheduledAutoDiscovery.js'

let _initialized = false
let _scheduleIntervalId = null

/**
 * Bootstrap all Anya services.
 *
 * @param {object} db — better-sqlite3 / postgres db handle
 * @returns {Promise<object>} summary report of what was started or skipped
 */
export async function bootstrapAnya(db) {
  if (_initialized) {
    log.info('[AnyaBootstrap] Already initialized — skipping duplicate bootstrap')
    return { skipped: true, reason: 'already_initialized' }
  }
  _initialized = true

  log.info('[AnyaBootstrap] Initializing Anya services...')

  const report = {
    started_at: new Date().toISOString(),
    startup_operations: null,
    autonomous_startup: null,
    background_code_crawl: null,
    health_service: null,
    schedule_runner: null,
  }

  try {
    // 1. Run profile/crawler warmup (always)
    try {
      log.info('[AnyaBootstrap] Starting startup operations...')
      report.startup_operations = await runStartupOperations(db)
      log.info('[AnyaBootstrap] Startup operations complete')
    } catch (err) {
      log.error('[AnyaBootstrap] Startup operations failed:', err?.message || err)
      report.startup_operations = { error: err?.message || String(err) }
    }

    // 2. Autonomous startup run (if ANYA_RUN_ON_STARTUP === 'true')
    if (process.env.ANYA_RUN_ON_STARTUP === 'true') {
      try {
        log.info('[AnyaBootstrap] ANYA_RUN_ON_STARTUP=true — running autonomous startup...')
        report.autonomous_startup = await runOnStartup(db)
        log.info('[AnyaBootstrap] Autonomous startup complete')
      } catch (err) {
        log.error('[AnyaBootstrap] Autonomous startup failed:', err?.message || err)
        report.autonomous_startup = { error: err?.message || String(err) }
      }
    } else {
      log.info('[AnyaBootstrap] Autonomous startup skipped (ANYA_RUN_ON_STARTUP !== "true")')
      report.autonomous_startup = { skipped: true }
    }

    // 3. Background code-crawl-and-repair (if ANYA_AUTONOMOUS_ENABLED !== 'false')
    if (process.env.ANYA_AUTONOMOUS_ENABLED !== 'false') {
      try {
        log.info('[AnyaBootstrap] Starting background code-crawl-and-repair...')
        startBackgroundCodeCrawlAndRepair({ db })
        report.background_code_crawl = { started: true }
        log.info('[AnyaBootstrap] Background code-crawl-and-repair started')
      } catch (err) {
        log.error('[AnyaBootstrap] Background code-crawl-and-repair failed to start:', err?.message || err)
        report.background_code_crawl = { error: err?.message || String(err) }
      }
    } else {
      log.info('[AnyaBootstrap] Background code-crawl-and-repair skipped (ANYA_AUTONOMOUS_ENABLED=false)')
      report.background_code_crawl = { skipped: true }
    }

    // 4. Health service (always)
    try {
      log.info('[AnyaBootstrap] Starting health service...')
      startHealthService(db)
      report.health_service = { started: true }
      log.info('[AnyaBootstrap] Health service started')
    } catch (err) {
      log.error('[AnyaBootstrap] Health service failed to start:', err?.message || err)
      report.health_service = { error: err?.message || String(err) }
    }

    // 5. Schedule runner (if ANYA_RUN_ON_SCHEDULE === 'true')
    if (process.env.ANYA_RUN_ON_SCHEDULE === 'true') {
      const SCHEDULE_CHECK_MS = 30 * 60 * 1000
      // Clear existing interval if it exists
if (_scheduleIntervalId) {
  clearInterval(_scheduleIntervalId)
}
_scheduleIntervalId = setInterval(() => {
        checkSchedule(db).catch(err => {
          log.error('[AnyaBootstrap] Scheduled check failed:', err?.message || err)
        })
      }, SCHEDULE_CHECK_MS)
      if (_scheduleIntervalId.unref) _scheduleIntervalId.unref()
      report.schedule_runner = { started: true, interval_ms: SCHEDULE_CHECK_MS }
      log.info('[AnyaBootstrap] Schedule runner enabled (checking every 30 min)')
    } else {
      log.info('[AnyaBootstrap] Schedule runner skipped (ANYA_RUN_ON_SCHEDULE !== "true")')
      report.schedule_runner = { skipped: true }
    }

    // 6. Daily profile-aware auto-discovery (independent of ANYA_AUTONOMOUS_*).
    if (process.env.AUTO_DISCOVERY_DAILY_ENABLED === 'true') {
      const SCHEDULE_CHECK_MS = 30 * 60 * 1000
      const dailyIntervalId = setInterval(() => {
        checkScheduledAutoDiscovery(db).catch((err) => {
          log.error('[AnyaBootstrap] Scheduled auto-discovery check failed:', err?.message || err)
        })
      }, SCHEDULE_CHECK_MS)
      if (dailyIntervalId.unref) dailyIntervalId.unref()
      report.scheduled_auto_discovery = { started: true, interval_ms: SCHEDULE_CHECK_MS }
      log.info('[AnyaBootstrap] Daily profile-aware auto-discovery enabled (checking every 30 min)')
    } else {
      report.scheduled_auto_discovery = { skipped: true }
    }

    report.completed_at = new Date().toISOString()
    log.info('[AnyaBootstrap] Initialization complete', {
      startup_operations: report.startup_operations?.fatal_error ? 'error' : 'ok',
      autonomous_startup: report.autonomous_startup?.skipped ? 'skipped' : (report.autonomous_startup?.error ? 'error' : 'ok'),
      background_code_crawl: report.background_code_crawl?.skipped ? 'skipped' : (report.background_code_crawl?.error ? 'error' : 'started'),
      health_service: report.health_service?.error ? 'error' : 'started',
      schedule_runner: report.schedule_runner?.skipped ? 'skipped' : 'started',
    })
  } catch (err) {
    // Top-level catch — never crash the server
    log.error('[AnyaBootstrap] Unexpected error during initialization:', err?.message || err)
    report.fatal_error = err?.message || String(err)
    report.completed_at = new Date().toISOString()
  }

  return report
}
