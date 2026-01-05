import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import fs from 'fs'
import OpenAI from 'openai'
import { processComprehensiveCrawlerJob } from './comprehensiveCrawler.js'
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
                limit_per_zip: 3
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
import { runAutonomousCodeCrawl } from './anyaAutonomousCrawler.js'
import { runAutonomousCrawlers, saveCrawlerResultsToGlobal } from './anyaAutonomousFunctionRunner.js'
import { runAutonomousFunctionTests } from './anyaAutonomousFunctionTesting.js'
import { processComprehensiveCrawlerJob } from './comprehensiveCrawler.js'
import fs from 'fs'
import path from 'path'

/**
 * Run all autonomous startup operations
 * This function is called when the server starts up
 * @param {Object} db - Database connection
 */
export async function runStartupOperations(db) {
  // TODO: Remove debug log - console.log('[startup] Starting Anya autonomous operations...')
  
  const adminUser = { role: 'admin', userId: 'system' }
  const context = { db, user: adminUser }
  
  try {
    // 1. Run autonomous code crawl and fixes
    // TODO: Remove debug log - console.log('[startup] Phase 1: Running autonomous code analysis...')
    await runAutonomousCodeCrawl({
      dryRun: false,
      fixConsoleLog: true,
      fixEmptyCatch: true,
      maxIterations: 100,
      maxFileChanges: 50,
    }, context)
    
    // 2. Run function tests
    // TODO: Remove debug log - console.log('[startup] Phase 2: Running function tests...')
    await runAutonomousFunctionTests({
      testSuites: ['health', 'profiles', 'opportunities', 'anya'],
      fixErrors: true,
      dryRun: false,
    }, context)
    
    // 3. Get all active profiles and run crawlers
    // TODO: Remove debug log - console.log('[startup] Phase 3: Running crawlers for all profiles...')
    const profiles = db.prepare("SELECT id FROM profiles WHERE status = 'active'").all()
    const profileIds = profiles.map(p => p.id)
    
    await runAutonomousCrawlers({
      profileIds,
      crawlerTypes: ['local', 'scholarship', 'comprehensive', 'profile_enrichment'],
      maxRetries: 3,
      waitForCompletion: true,
      timeoutMinutes: 60,
    }, context)
    
    // 4. Run nationwide comprehensive crawler for ALL ZIP codes
    // TODO: Remove debug log - console.log('[startup] Phase 4: Running nationwide comprehensive crawler...')
    const dataDir = path.resolve(process.cwd(), 'backend', 'data', 'crawlers')
    const zipFile = path.join(dataDir, 'zip_coordinates.json')
    
    if (fs.existsSync(zipFile)) {
      const zipMap = JSON.parse(fs.readFileSync(zipFile, 'utf8'))
      const allZipCodes = Object.keys(zipMap)
      
      // TODO: Remove debug log - console.log(`[startup] Processing ${allZipCodes.length} ZIP codes...`)
      
      const nationwideJob = {
        id: `startup-nationwide-${Date.now()}`,
        type: 'comprehensive',
        parameters: {
          zip_list: allZipCodes,
          limit_per_zip: 3, // Minimum 3 per ZIP
        },
      }
      
      const result = processComprehensiveCrawlerJob({
        db,
        job: nationwideJob,
        dataDir,
        profileContext: null, // null = save to global opportunities
      })
      
      // TODO: Remove debug log - console.log(`[startup] Nationwide crawler complete: ${result.inserted} opportunities saved`)
    }
    
    // 5. Save all crawler results to global opportunities
    // TODO: Remove debug log - console.log('[startup] Phase 5: Syncing to global opportunities...')
    const completedJobs = db.prepare(`
      SELECT id FROM crawler_jobs 
      WHERE status = 'completed' 
      AND created_at >= datetime('now', '-1 hour')
    `).all()
    
    for (const job of completedJobs) {
      try {
        await saveCrawlerResultsToGlobal({ jobId: job.id }, context)
      } catch (err) {
        console.warn(`[startup] Failed to sync job ${job.id}:`, err.message)
      }
    }
    
    // TODO: Remove debug log - console.log('[startup] All autonomous operations completed successfully!')
    
  } catch (error) {
    console.error('[startup] Autonomous operations error:', error)
    throw error
  }
}
