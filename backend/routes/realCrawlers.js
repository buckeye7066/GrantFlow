/**
 * Real Web Crawler API Routes
 * Handles execution of specialized funding crawlers
 */

import express from 'express'
import { ensureAuth } from '../middleware/auth.js'
import { crawlLocalFunding } from '../services/crawlers/localFundingCrawler.js'
import { crawlGovernmentFunding } from '../services/crawlers/governmentFundingCrawler.js'
import { crawlStudentGrants } from '../services/crawlers/studentGrantsCrawler.js'
import { crawlECFBenefits } from '../services/crawlers/ecfBenefitsCrawler.js'
import { crawlItemFunding } from '../services/crawlers/itemFundingCrawler.js'
import { crawlSpecialNeeds } from '../services/crawlers/specialNeedsCrawler.js'

const router = express.Router()

// Map of crawler types to their functions
const CRAWLERS = {
  local_funding: crawlLocalFunding,
  government_funding: crawlGovernmentFunding,
  student_grants: crawlStudentGrants,
  ecf_benefits: crawlECFBenefits,
  item_matching: crawlItemFunding,
  special_needs: crawlSpecialNeeds
}

/**
 * Run a specific crawler
 * POST /api/crawlers/run
 */
router.post('/run', ensureAuth, async (req, res) => {
  const { crawler_type, profile_id, profile_data, item_request, min_match_score = 80 } = req.body
  
  if (!crawler_type || !CRAWLERS[crawler_type]) {
    return res.status(400).json({ 
      error: 'Invalid crawler type',
      available_crawlers: Object.keys(CRAWLERS)
    })
  }
  
  if (!profile_id && !profile_data) {
    return res.status(400).json({ error: 'Profile ID or data required' })
  }
  
  try {
    const db = req.app.get('db')
    
    // Get profile data if only ID provided
    let profile = profile_data
    if (!profile && profile_id) {
      const profileRow = db.prepare(`
        SELECT p.*, o.display_name as org_name, o.state, o.zip
        FROM profiles p
        LEFT JOIN organizations o ON p.organization_id = o.id
        WHERE p.id = ?
      `).get(profile_id)
      
      if (!profileRow) {
        return res.status(404).json({ error: 'Profile not found' })
      }
      
      profile = profileRow
    }
    
    console.log(`[RealCrawlers] Running ${crawler_type} for profile ${profile_id || 'custom'}`)
    
    // Run the crawler
    const crawlerFunc = CRAWLERS[crawler_type]
    const options = {
      min_match_score,
      item_request: crawler_type === 'item_matching' ? item_request : null
    }
    
    const startTime = Date.now()
    const opportunities = await crawlerFunc(profile, options)
    const duration = Date.now() - startTime
    
    console.log(`[RealCrawlers] ${crawler_type} found ${opportunities.length} opportunities in ${duration}ms`)
    
    // Filter by minimum match score
    const filteredOpportunities = opportunities.filter(opp => 
      opp.match_score >= min_match_score
    )
    
    // Save to database if profile_id provided
    if (profile_id) {
      await saveOpportunitiesToDB(db, filteredOpportunities, profile_id, crawler_type)
    }
    
    res.json({
      success: true,
      crawler_type,
      count: filteredOpportunities.length,
      total_found: opportunities.length,
      filtered_count: filteredOpportunities.length,
      min_match_score,
      duration,
      opportunities: filteredOpportunities
    })
    
  } catch (error) {
    console.error(`[RealCrawlers] Error running ${crawler_type}:`, error)
    res.status(500).json({ 
      error: 'Crawler execution failed',
      message: error.message 
    })
  }
})

/**
 * Run multiple crawlers in parallel
 * POST /api/crawlers/run-batch
 */
router.post('/run-batch', ensureAuth, async (req, res) => {
  const { crawler_types, profile_id, profile_data, min_match_score = 80 } = req.body
  
  if (!crawler_types || !Array.isArray(crawler_types) || crawler_types.length === 0) {
    return res.status(400).json({ error: 'Crawler types array required' })
  }
  
  const invalidTypes = crawler_types.filter(type => !CRAWLERS[type])
  if (invalidTypes.length > 0) {
    return res.status(400).json({ 
      error: 'Invalid crawler types',
      invalid: invalidTypes,
      available_crawlers: Object.keys(CRAWLERS)
    })
  }
  
  try {
    const db = req.app.get('db')
    
    // Get profile data
    let profile = profile_data
    if (!profile && profile_id) {
      const profileRow = db.prepare(`
        SELECT p.*, o.display_name as org_name, o.state, o.zip
        FROM profiles p
        LEFT JOIN organizations o ON p.organization_id = o.id
        WHERE p.id = ?
      `).get(profile_id)
      
      if (!profileRow) {
        return res.status(404).json({ error: 'Profile not found' })
      }
      
      profile = profileRow
    }
    
    console.log(`[RealCrawlers] Running batch: ${crawler_types.join(', ')}`)
    
    // Run all crawlers in parallel
    const crawlerPromises = crawler_types.map(async (crawler_type) => {
      try {
        const crawlerFunc = CRAWLERS[crawler_type]
        const options = { min_match_score }
        
        const startTime = Date.now()
        const opportunities = await crawlerFunc(profile, options)
        const duration = Date.now() - startTime
        
        const filtered = opportunities.filter(opp => opp.match_score >= min_match_score)
        
        return {
          crawler_type,
          success: true,
          count: filtered.length,
          duration,
          opportunities: filtered
        }
      } catch (error) {
        console.error(`[RealCrawlers] Error in ${crawler_type}:`, error)
        return {
          crawler_type,
          success: false,
          error: error.message,
          count: 0,
          opportunities: []
        }
      }
    })
    
    const results = await Promise.all(crawlerPromises)
    
    // Combine all opportunities
    const allOpportunities = results.flatMap(r => r.opportunities || [])
    
    // Save to database
    if (profile_id && allOpportunities.length > 0) {
      await saveOpportunitiesToDB(db, allOpportunities, profile_id, 'batch_crawler')
    }
    
    // Summary statistics
    const successCount = results.filter(r => r.success).length
    const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0)
    
    res.json({
      success: true,
      batch_size: crawler_types.length,
      success_count: successCount,
      total_opportunities: allOpportunities.length,
      total_duration: totalDuration,
      results,
      opportunities: allOpportunities
    })
    
  } catch (error) {
    console.error('[RealCrawlers] Batch execution error:', error)
    res.status(500).json({ 
      error: 'Batch crawler execution failed',
      message: error.message 
    })
  }
})

/**
 * Get crawler status and statistics
 * GET /api/crawlers/status
 */
router.get('/status', ensureAuth, (req, res) => {
  const db = req.app.get('db')
  
  try {
    // Get recent crawler runs
    const recentRuns = db.prepare(`
      SELECT 
        crawler_type,
        COUNT(*) as run_count,
        AVG(json_extract(results, '$.duration')) as avg_duration,
        SUM(json_extract(results, '$.count')) as total_found
      FROM crawler_logs
      WHERE created_at > datetime('now', '-7 days')
      GROUP BY crawler_type
    `).all()
    
    res.json({
      available_crawlers: Object.keys(CRAWLERS),
      recent_activity: recentRuns,
      status: 'operational'
    })
  } catch (error) {
    console.error('[RealCrawlers] Status error:', error)
    res.status(500).json({ error: 'Could not get crawler status' })
  }
})

/**
 * Save opportunities to database and pipeline
 */
async function saveOpportunitiesToDB(db, opportunities, profile_id, crawler_type) {
  const insertOpp = db.prepare(`
    INSERT OR IGNORE INTO funding_opportunities (
      id, title, sponsor, description, url, amount_min, amount_max,
      deadline, eligibility_bullets, source, source_id, match_score,
      created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      datetime('now')
    )
  `)
  
  const insertPipeline = db.prepare(`
    INSERT OR IGNORE INTO grants (
      organization_id, funding_opportunity_id, title, funder,
      status, deadline, notes, created_at
    )
    SELECT
      p.organization_id, ?, ?, ?,
      'discovered', ?, ?, datetime('now')
    FROM profiles p
    WHERE p.id = ? AND p.organization_id IS NOT NULL
  `)
  
  const insertLog = db.prepare(`
    INSERT INTO crawler_logs (
      crawler_type, profile_id, status, message, results, created_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))
  `)
  
  let savedCount = 0
  let pipelineCount = 0
  
  db.transaction(() => {
    for (const opp of opportunities) {
      try {
        // Generate unique ID
        const oppId = `${crawler_type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        
        // Save opportunity
        insertOpp.run(
          oppId,
          opp.title,
          opp.sponsor,
          opp.description,
          opp.url || opp.application_url,
          opp.amount_min || 0,
          opp.amount_max || 0,
          opp.deadline,
          JSON.stringify(opp.eligibility_bullets || []),
          opp.source || crawler_type,
          opp.source_id || oppId,
          opp.match_score || 0
        )
        savedCount++
        
        // Add to pipeline if match > 80%
        if (opp.match_score >= 80) {
          insertPipeline.run(
            oppId,
            opp.title,
            opp.sponsor,
            opp.deadline,
            `Auto-added: ${opp.match_score}% match from ${crawler_type}`,
            profile_id
          )
          pipelineCount++
        }
      } catch (error) {
        console.error('[RealCrawlers] Error saving opportunity:', error)
      }
    }
    
    // Log the run
    insertLog.run(
      crawler_type,
      profile_id,
      'completed',
      `Found ${opportunities.length} opportunities, saved ${savedCount}, added ${pipelineCount} to pipeline`,
      JSON.stringify({ count: opportunities.length, saved: savedCount, pipeline: pipelineCount }),
    )
  })()
  
  console.log(`[RealCrawlers] Saved ${savedCount} opportunities, added ${pipelineCount} to pipeline`)
  
  return { saved: savedCount, pipeline: pipelineCount }
}

export default router