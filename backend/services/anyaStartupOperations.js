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

    // Phase 3: Skip nationwide crawler on startup (too resource intensive)
    // The nationwide crawler can be triggered manually via API when needed
    // Individual profile crawlers are queued above and will run in background
    console.log('[Anya Startup] Phase 3: Skipping nationwide crawler (run manually via /api/crawlers if needed)')
    report.nationwide_opportunities = 0

    // Phase 4: Sync profile opportunities to global
    console.log('[Anya Startup] Phase 4: Syncing opportunities to global pool...')
    try {
      const profileOpps = db.prepare(`
        SELECT DISTINCT title, sponsor, deadline, amount_min, amount_max, 
               amount_description, application_url, state, opportunity_type,
               categories, keywords, eligibility_bullets, source, source_url
        FROM funding_opportunities 
        WHERE profile_id IS NOT NULL 
        AND is_active = 1
      `).all()
      
      let synced = 0
      for (const opp of profileOpps) {
        const existing = db.prepare(`
          SELECT id FROM funding_opportunities 
          WHERE title = ? AND sponsor = ? AND profile_id IS NULL
          LIMIT 1
        `).get(opp.title, opp.sponsor)
        
        if (!existing) {
          const globalId = `global-${randomUUID()}`
          db.prepare(`
            INSERT INTO funding_opportunities (
              id, title, sponsor, deadline, amount_min, amount_max,
              amount_description, application_url, state, opportunity_type,
              categories, keywords, eligibility_bullets, source, source_url,
              is_active, profile_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).run(
            globalId, opp.title, opp.sponsor, opp.deadline, opp.amount_min, opp.amount_max,
            opp.amount_description, opp.application_url, opp.state, opp.opportunity_type,
            opp.categories, opp.keywords, opp.eligibility_bullets, opp.source, opp.source_url
          )
          synced++
        }
      }
      console.log(`[Anya Startup] Synced ${synced} opportunities to global pool`)
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
