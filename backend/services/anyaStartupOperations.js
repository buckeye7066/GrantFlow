import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'
import { createLogger } from '../utils/logger.js'
const log = createLogger('anyaStartupOperations')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Run all startup operations for Anya
 * This function is called after the server starts
 * IMPORTANT: This function should NEVER crash the server - all errors are caught and logged
 */
export async function runStartupOperations(db) {
  log.info('[Anya Startup] Beginning autonomous operations...')
  
  const startTime = Date.now()
  const report = {
    started_at: new Date().toISOString(),
    profiles_processed: 0,
    crawler_jobs_queued: 0,
    nationwide_opportunities: 0,
    errors: []
  }

  // Wrap everything in a top-level try-catch to NEVER crash the server
  try {
    // Phase 1: Get all active profiles
    log.info('[Anya Startup] Phase 1: Loading active profiles...')
    const profiles = await db.prepare("SELECT id, display_name FROM profiles WHERE status = 'active'").all()
    report.profiles_processed = profiles.length
    log.info(`[Anya Startup] Found ${profiles.length} active profiles`)

    // Phase 2: Skip aggressive crawler queuing on startup
    // Crawlers can be triggered per-profile when users log in or via API
    log.info('[Anya Startup] Phase 2: Skipping crawler job queuing (triggered on-demand instead)')
    report.crawler_jobs_queued = 0

    // Phase 3: Queue county-level funding crawler to run in background
    // This populates local funding sources for each county
    log.info('[Anya Startup] Phase 3: Scheduling county funding crawler (background)...')
    try {
      // Run county crawler after a 30 second delay to not block startup
      setTimeout(async () => {
        try {
          // County funding discovery is superseded by the Crawler OS; this
          // legacy background hook is a no-op (the old countyFundingCrawler is
          // no longer imported anywhere in the runtime).
          log.info('[Anya Background] County funding handled by Crawler OS — legacy hook is a no-op')
          const result = { inserted: 0, counties: 0 }
          log.info(`[Anya Background] County crawler complete: ${result.inserted} new opportunities across ${result.counties} counties`)
        } catch (crawlErr) {
          console.error('[Anya Background] County crawler error:', crawlErr.message)
        }
      }, 30000) // 30 second delay
      report.county_crawler_scheduled = true
    } catch (scheduleErr) {
      report.errors.push({ phase: 'county_scheduler', error: scheduleErr.message })
    }
    report.nationwide_opportunities = 0

    // Phase 4: REMOVED — copying profile-scoped crawl results into the global catalog
    // caused cross-profile data bleed (Profile A's opportunities appeared in Profile B's
    // matches). Each profile now sees only its own crawl results plus global catalog
    // entries (profile_id IS NULL) via the (profile_id IS NULL OR profile_id = ?) filter
    // in matching.js and discovery.js.
    log.info('[Anya Startup] Phase 4: Skipped (global sync removed to prevent profile bleed)')

    const duration = Date.now() - startTime
    report.completed_at = new Date().toISOString()
    report.duration_ms = duration
    report.duration_readable = `${Math.floor(duration / 60000)}m ${Math.floor((duration % 60000) / 1000)}s`

    log.info('[Anya Startup] ========================================')
    log.info('[Anya Startup] AUTONOMOUS OPERATIONS COMPLETE')
    log.info(`[Anya Startup] Profiles processed: ${report.profiles_processed}`)
    log.info(`[Anya Startup] Crawler jobs queued: ${report.crawler_jobs_queued}`)
    log.info(`[Anya Startup] Nationwide opportunities: ${report.nationwide_opportunities}`)
    log.info(`[Anya Startup] Errors: ${report.errors.length}`)
    log.info(`[Anya Startup] Duration: ${report.duration_readable}`)
    log.info('[Anya Startup] ========================================')

    return report
  } catch (error) {
    console.error('[Anya Startup] FATAL ERROR:', error)
    report.fatal_error = error.message
    report.completed_at = new Date().toISOString()
    return report
  }
}
