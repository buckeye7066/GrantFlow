/**
 * Real Web Crawler API Routes
 * Handles execution of specialized funding crawlers
 * Production version - uses only real data sources
 */

import express from 'express'
import { ensureAuth } from '../middleware/auth.js'
import { getProfileWithLocation, formatOpportunity } from '../services/crawlers/crawlerHelpers.js'
import { crawlLocalFunding } from '../services/crawlers/localFundingCrawler.js'
import { crawlGovernmentFunding } from '../services/crawlers/governmentFundingCrawler.js'
import { crawlStudentGrants } from '../services/crawlers/studentGrantsCrawler.js'
import { crawlECFBenefits } from '../services/crawlers/ecfBenefitsCrawler.js'
import { crawlItemFunding } from '../services/crawlers/itemFundingCrawler.js'
import { crawlSpecialNeeds } from '../services/crawlers/specialNeedsCrawler.js'
import { runRealCrawlersAcrossProfiles } from '../services/realCrawlers/runMultipleService.js'

const router = express.Router()

// Crawler types
const CRAWLER_TYPES = [
  'local_funding',
  'government_funding', 
  'student_grants',
  'ecf_benefits',
  'item_matching',
  'special_needs'
]

/**
 * Run a specific crawler
 * POST /api/real-crawlers/run
 */
router.post('/run', ensureAuth, async (req, res) => {
  const { crawler_type, profile_id, profile_data, item_request, min_match_score = 80 } = req.body
  
  if (!crawler_type || !CRAWLER_TYPES.includes(crawler_type)) {
    return res.status(400).json({ 
      error: 'Invalid crawler type',
      message: `Invalid crawler type: ${crawler_type}`,
      available_crawlers: CRAWLER_TYPES
    })
  }
  
  if (!profile_id && !profile_data) {
    return res.status(400).json({ 
      error: 'Profile ID or data required',
      message: 'Either profile_id or profile_data must be provided'
    })
  }
  
  try {
    const db = req.db
    
    // Get profile data with location
    let profile = profile_data
    if (!profile && profile_id) {
      profile = getProfileWithLocation(db, profile_id)
      
      if (!profile) {
        return res.status(404).json({ 
          error: 'Profile not found',
          message: `Profile with ID ${profile_id} does not exist`
        })
      }
    }
    
    console.log(`[RealCrawlers] Running ${crawler_type} for profile ${profile_id || 'custom'}`)
    
    // Execute the appropriate real crawler
    const startTime = Date.now()
    let opportunities = []
    
    try {
      switch (crawler_type) {
        case 'local_funding':
          opportunities = await crawlLocalFunding(profile, { min_match_score })
          break
        case 'government_funding':
          opportunities = await crawlGovernmentFunding(profile, { min_match_score })
          break
        case 'student_grants':
          opportunities = await crawlStudentGrants(profile, { min_match_score })
          break
        case 'ecf_benefits':
          opportunities = await crawlECFBenefits(profile, { min_match_score })
          break
        case 'item_matching':
          opportunities = await crawlItemFunding(profile, { item_request, min_match_score })
          break
        case 'special_needs':
          opportunities = await crawlSpecialNeeds(profile, { min_match_score })
          break
        default:
          throw new Error(`Crawler implementation not found for type: ${crawler_type}`)
      }
    } catch (crawlerError) {
      console.error(`[RealCrawlers] Crawler ${crawler_type} failed:`, crawlerError)
      
      // Return detailed error information
      let errorMessage = crawlerError.message || 'Unknown crawler error'
      let errorDetails = null
      
      // Check for common error patterns and provide helpful messages
      if (errorMessage.includes('SAM_GOV_API_KEY') || errorMessage.includes('API key')) {
        errorMessage = 'SAM_GOV_API_KEY missing - government funding crawler requires API configuration'
      } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('network')) {
        errorMessage = 'Network error - unable to reach external funding sources'
      } else if (errorMessage.includes('timeout')) {
        errorMessage = 'Request timeout - external service is not responding'
      }
      
      return res.status(500).json({
        error: 'Crawler execution failed',
        message: errorMessage,
        crawler: crawler_type,
        status: 500,
        timestamp: new Date().toISOString()
      })
    }
    
    const duration = Date.now() - startTime
    
    console.log(`[RealCrawlers] ${crawler_type} found ${opportunities.length} opportunities in ${duration}ms`)
    
    // Filter by minimum match score
    const filteredOpportunities = opportunities.filter(opp => 
      opp.match_score >= min_match_score
    )
    
    // NOTE: Persisting "real crawler" results is handled by the crawler jobs pipeline.
    // This endpoint returns results for immediate UI consumption.
    
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
    console.error(`[RealCrawlers] Error in ${crawler_type}:`, error)
    res.status(500).json({ 
      error: 'Crawler execution failed',
      message: error.message,
      crawler_type
    })
  }
})

/**
 * Get all available crawlers
 * GET /api/real-crawlers/list
 */
router.get('/list', ensureAuth, (req, res) => {
  const crawlers = CRAWLER_TYPES.map(type => ({
    id: type,
    name: type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
    description: getCrawlerDescription(type),
    available: true
  }))
  
  res.json({
    crawlers,
    total: crawlers.length
  })
})

/**
 * Run multiple crawlers for a profile
 * POST /api/real-crawlers/run-multiple
 */
router.post('/run-multiple', ensureAuth, async (req, res) => {
  const { profile_id, crawler_types, min_match_score = 80 } = req.body
  
  if (!profile_id) {
    return res.status(400).json({ 
      error: 'Profile ID required',
      message: 'profile_id is required for running multiple crawlers'
    })
  }
  
  if (!crawler_types || !Array.isArray(crawler_types)) {
    return res.status(400).json({ 
      error: 'Crawler types array required',
      message: 'crawler_types must be an array of crawler type strings'
    })
  }
  
  const db = req.db

  // Use the shared service so persistence + "REAL" markers are consistent with Anya/admin tooling.
  // For API callers, we only run for a single profile_id here.
  const report = await runRealCrawlersAcrossProfiles(
    {
      profileIds: [profile_id],
      crawlerTypes: crawler_types,
      minMatchScore: min_match_score,
      persistGlobal: true,
      dryRun: false,
      maxProfiles: 1,
    },
    { db, user: req.user },
  )

  // Shape the legacy response fields for backwards compatibility.
  const profileReport = report.profiles?.[0] || null
  const succeeded = []
  const failed = []
  if (profileReport?.crawlers) {
    profileReport.crawlers.forEach((c) => {
      if (c.ok) {
        succeeded.push({
          crawler: c.crawler_type,
          found: c.found,
          inserted: c.saved_global,
        })
      } else {
        failed.push({ crawler: c.crawler_type, error: c.error, status: 500 })
      }
    })
  }

  res.json({
    totalSelected: crawler_types.length,
    succeeded,
    failed,
    totalFound: report.totals.found,
    totalInserted: report.totals.saved_global,
    run_id: report.run_id,
    artifact_path: report.artifact_path,
  })
})

/**
 * Get crawler description
 */
function getCrawlerDescription(type) {
  const descriptions = {
    local_funding: 'Searches for funding opportunities within 50 miles of your location',
    government_funding: 'Finds federal, state, and local government grants and programs',
    student_grants: 'Discovers scholarships, grants, and financial aid for students',
    ecf_benefits: 'Locates ECF CHOICES benefits and disability support services',
    item_matching: 'Matches specific item requests with funding sources',
    special_needs: 'Identifies funding for special needs, disabilities, and unique circumstances'
  }
  
  return descriptions[type] || 'Specialized funding crawler'
}

export default router