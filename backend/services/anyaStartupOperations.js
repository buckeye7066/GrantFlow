import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import fs from 'fs'
import OpenAI from 'openai'
import { processComprehensiveCrawlerJob } from './comprehensiveCrawlerOptimized.js'
import { dispatchCrawlerJob } from './crawlerDispatcher.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Run all startup operations for Anya
 * This function is called after the server starts
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

  try {
    // Phase 1: Get all active profiles
    console.log('[Anya Startup] Phase 1: Loading active profiles...')
    const profiles = db.prepare("SELECT id, display_name FROM profiles WHERE status = 'active'").all()
    report.profiles_processed = profiles.length
    console.log(`[Anya Startup] Found ${profiles.length} active profiles`)

    // Phase 2: Queue crawler jobs for each profile
    console.log('[Anya Startup] Phase 2: Queuing crawler jobs for all profiles...')
    const crawlerTypes = ['local', 'scholarship', 'comprehensive', 'profile_enrichment']
    const uploadDir = join(__dirname, '..', '..', 'uploads')
    
    for (const profile of profiles) {
      for (const crawlerType of crawlerTypes) {
        try {
          const jobId = `startup-${profile.id}-${crawlerType}-${Date.now()}`
          
          db.prepare(`
            INSERT INTO crawler_jobs (id, type, profile_id, status, parameters, created_at)
            VALUES (?, ?, ?, 'queued', '{}', CURRENT_TIMESTAMP)
          `).run(jobId, crawlerType, profile.id)
          
          report.crawler_jobs_queued++
          
          // Dispatch the job for processing
          dispatchCrawlerJob({
            db,
            jobId,
            uploadDir,
            getOpenAI: () => {
              return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
            }
          })
        } catch (err) {
          report.errors.push({
            phase: 'crawler_queue',
            profile_id: profile.id,
            crawler_type: crawlerType,
            error: err.message
          })
        }
      }
    }
    console.log(`[Anya Startup] Queued ${report.crawler_jobs_queued} crawler jobs`)

    // Phase 3: Run nationwide comprehensive crawler
    console.log('[Anya Startup] Phase 3: Running nationwide comprehensive crawler...')
    const dataDir = join(__dirname, '..', 'data', 'crawlers')
    const zipFile = join(dataDir, 'zip_coordinates.json')
    
    if (fs.existsSync(zipFile)) {
      try {
        const zipMap = JSON.parse(fs.readFileSync(zipFile, 'utf8'))
        const allZipCodes = Object.keys(zipMap)
        console.log(`[Anya Startup] Processing ${allZipCodes.length} ZIP codes...`)
        
        // Process in batches to avoid memory issues
        const batchSize = 500
        let totalInserted = 0
        
        for (let i = 0; i < allZipCodes.length; i += batchSize) {
          const batch = allZipCodes.slice(i, i + batchSize)
          
          try {
            const job = {
              id: `startup-nationwide-batch-${i}-${Date.now()}`,
              type: 'comprehensive',
              parameters: {
                zip_list: batch,
                limit_per_zip: 8  // Use all 8 templates per ZIP
              }
            }
            
            const result = processComprehensiveCrawlerJob({
              db,
              job,
              dataDir,
              profileContext: null // null = save to global opportunities
            })
            
            totalInserted += result.inserted || 0
            console.log(`[Anya Startup] Batch ${Math.floor(i/batchSize) + 1}: ${result.inserted} opportunities`)
          } catch (batchErr) {
            report.errors.push({
              phase: 'nationwide_crawler',
              batch_start: i,
              error: batchErr.message
            })
          }
        }
        
        report.nationwide_opportunities = totalInserted
        console.log(`[Anya Startup] Nationwide crawler complete: ${totalInserted} total opportunities`)
      } catch (zipErr) {
        report.errors.push({
          phase: 'nationwide_crawler',
          error: zipErr.message
        })
      }
    } else {
      console.log('[Anya Startup] No zip_coordinates.json found, skipping nationwide crawler')
    }

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
