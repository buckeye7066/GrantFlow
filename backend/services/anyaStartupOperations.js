import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import fs from 'fs'
import OpenAI from 'openai'
import { runComprehensiveCrawler as processComprehensiveCrawlerJob } from './comprehensiveCrawlerOptimized.js'
import { dispatchCrawlerJob } from './crawlerDispatcher.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Run all startup operations for Anya
 * This function is called after the server starts
 * IMPORTANT: This function should NEVER crash the server - all errors are caught and logged
 */
export async function runStartupOperations(db) {
  console.log('[Anya Startup] Beginning autonomous operations...')
  
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
    console.log('[Anya Startup] Phase 1: Loading active profiles...')
    const profiles = db.prepare("SELECT id, display_name FROM profiles WHERE status = 'active'").all()
    report.profiles_processed = profiles.length
    console.log(`[Anya Startup] Found ${profiles.length} active profiles`)

    // Phase 2: Skip aggressive crawler queuing on startup
    // Crawlers can be triggered per-profile when users log in or via API
    console.log('[Anya Startup] Phase 2: Skipping crawler job queuing (triggered on-demand instead)')
    report.crawler_jobs_queued = 0

    // Phase 3: Queue county-level funding crawler to run in background
    // This populates local funding sources for each county
    console.log('[Anya Startup] Phase 3: Scheduling county funding crawler (background)...')
    try {
      // Run county crawler after a 30 second delay to not block startup
      setTimeout(async () => {
        try {
          console.log('[Anya Background] Starting county funding crawler...')
          const { crawlAllCounties } = await import('./countyFundingCrawler.js')
          const result = await crawlAllCounties(db)
          console.log(`[Anya Background] County crawler complete: ${result.inserted} new opportunities across ${result.counties} counties`)
        } catch (crawlErr) {
          console.error('[Anya Background] County crawler error:', crawlErr.message)
        }
      }, 30000) // 30 second delay
      report.county_crawler_scheduled = true
    } catch (scheduleErr) {
      report.errors.push({ phase: 'county_scheduler', error: scheduleErr.message })
    }
    report.nationwide_opportunities = 0

    // Phase 4: Sync profile opportunities to global (batched, capped at 5000)
    console.log('[Anya Startup] Phase 4: Syncing opportunities to global pool...')
    try {
      const activeVal = db?.dialect === 'postgres' ? 'TRUE' : '1'
      const profileOpps = db.prepare(`
        SELECT DISTINCT title, sponsor, deadline, amount_min, amount_max, 
               amount_description, application_url, state, opportunity_type,
               categories, keywords, eligibility_bullets, source, source_url
        FROM funding_opportunities 
        WHERE profile_id IS NOT NULL 
        AND is_active = ${activeVal}
        LIMIT 5000
      `).all()
      
      let synced = 0
      const BATCH = 50
      for (let i = 0; i < profileOpps.length; i += BATCH) {
        const chunk = profileOpps.slice(i, i + BATCH)
        try {
          await db.withTransaction(async (tx) => {
            for (const opp of chunk) {
              const existing = tx.prepare(`
                SELECT id FROM funding_opportunities 
                WHERE title = ? AND sponsor = ? AND profile_id IS NULL
                LIMIT 1
              `).get(opp.title, opp.sponsor)
              
              if (!existing) {
                const globalId = `global-${randomUUID()}`
                tx.prepare(`
                  INSERT INTO funding_opportunities (
                    id, title, sponsor, deadline, amount_min, amount_max,
                    amount_description, application_url, state, opportunity_type,
                    categories, keywords, eligibility_bullets, source, source_url,
                    is_active, profile_id, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${activeVal}, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `).run(
                  globalId, opp.title, opp.sponsor, opp.deadline, opp.amount_min, opp.amount_max,
                  opp.amount_description, opp.application_url, opp.state, opp.opportunity_type,
                  opp.categories, opp.keywords, opp.eligibility_bullets, opp.source, opp.source_url
                )
                synced++
              }
            }
          })
        } catch (batchErr) {
          console.error(`[Anya Startup] Sync batch ${i}-${i + chunk.length} failed:`, batchErr.message)
        }
      }
      console.log(`[Anya Startup] Synced ${synced} of ${profileOpps.length} opportunities to global pool`)
    } catch (syncErr) {
      report.errors.push({
        phase: 'global_sync',
        error: syncErr.message
      })
    }

    const duration = Date.now() - startTime
    report.completed_at = new Date().toISOString()
    report.duration_ms = duration
    report.duration_readable = `${Math.floor(duration / 60000)}m ${Math.floor((duration % 60000) / 1000)}s`

    console.log('[Anya Startup] ========================================')
    console.log('[Anya Startup] AUTONOMOUS OPERATIONS COMPLETE')
    console.log(`[Anya Startup] Profiles processed: ${report.profiles_processed}`)
    console.log(`[Anya Startup] Crawler jobs queued: ${report.crawler_jobs_queued}`)
    console.log(`[Anya Startup] Nationwide opportunities: ${report.nationwide_opportunities}`)
    console.log(`[Anya Startup] Errors: ${report.errors.length}`)
    console.log(`[Anya Startup] Duration: ${report.duration_readable}`)
    console.log('[Anya Startup] ========================================')

    return report
  } catch (error) {
    console.error('[Anya Startup] FATAL ERROR:', error)
    report.fatal_error = error.message
    report.completed_at = new Date().toISOString()
    return report
  }
}
