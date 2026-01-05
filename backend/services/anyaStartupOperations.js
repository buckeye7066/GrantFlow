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
  console.log('[startup] Starting Anya autonomous operations...')
  
  const adminUser = { role: 'admin', userId: 'system' }
  const context = { db, user: adminUser }
  
  try {
    // 1. Run autonomous code crawl and fixes
    console.log('[startup] Phase 1: Running autonomous code analysis...')
    await runAutonomousCodeCrawl({
      dryRun: false,
      fixConsoleLog: true,
      fixEmptyCatch: true,
      maxIterations: 100,
      maxFileChanges: 50,
    }, context)
    
    // 2. Run function tests
    console.log('[startup] Phase 2: Running function tests...')
    await runAutonomousFunctionTests({
      testSuites: ['health', 'profiles', 'opportunities', 'anya'],
      fixErrors: true,
      dryRun: false,
    }, context)
    
    // 3. Get all active profiles and run crawlers
    console.log('[startup] Phase 3: Running crawlers for all profiles...')
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
    console.log('[startup] Phase 4: Running nationwide comprehensive crawler...')
    const dataDir = path.resolve(process.cwd(), 'backend', 'data', 'crawlers')
    const zipFile = path.join(dataDir, 'zip_coordinates.json')
    
    if (fs.existsSync(zipFile)) {
      const zipMap = JSON.parse(fs.readFileSync(zipFile, 'utf8'))
      const allZipCodes = Object.keys(zipMap)
      
      console.log(`[startup] Processing ${allZipCodes.length} ZIP codes...`)
      
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
      
      console.log(`[startup] Nationwide crawler complete: ${result.inserted} opportunities saved`)
    }
    
    // 5. Save all crawler results to global opportunities
    console.log('[startup] Phase 5: Syncing to global opportunities...')
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
    
    console.log('[startup] All autonomous operations completed successfully!')
    
  } catch (error) {
    console.error('[startup] Autonomous operations error:', error)
    throw error
  }
}
