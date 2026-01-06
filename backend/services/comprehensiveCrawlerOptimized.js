import fs from 'fs'
import { join } from 'path'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import {
  buildProfileSignals,
  summarizeProfileSignals,
  extractZipFromContext,
} from './profileHelpers.js'
import { saveToProfilePipeline } from './opportunityMatcher.js'

function loadJSON(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

function addDays(baseDate, days) {
  const result = new Date(baseDate)
  result.setDate(result.getDate() + days)
  return result.toISOString().slice(0, 10)
}

// Process ZIPs in batches to prevent memory overflow
async function processBatch(batch, templates, limitPerZip, signals, focusSummary, db, profileContext, profileId) {
  const today = new Date()
  const interestHighlights = Array.from(signals.interests ?? []).slice(0, 3)
  const demographicHighlights = Array.from(signals.demographics ?? [])
    .slice(0, 2)
    .map((label) => label.replace(/_/g, ' '))
  
  let inserted = 0
  let evaluated = 0
  const opportunityLogs = []
  
  for (const { zip, coords } of batch) {
    templates.slice(0, limitPerZip).forEach((template, index) => {
      const deadline = addDays(today, template.deadline_offset_days)
      const formatter = new Intl.NumberFormat('en-US')
      const keywordSet = new Set([
        ...(template.keywords ?? []),
        ...Array.from(signals.phrases ?? []),
        ...interestHighlights,
      ])
      const categories = new Set([...(template.categories ?? [])])
      interestHighlights.forEach((interest) => categories.add(interest.replace(/_/g, ' ')))

      const descriptionParts = [template.description.replace('{zip}', zip)]
      if (interestHighlights.length > 0) {
        descriptionParts.push(
          `Priority given to projects supporting ${interestHighlights.join(', ')} within the service area.`,
        )
      }
      if (demographicHighlights.length > 0) {
        descriptionParts.push(
          `Programs should benefit ${demographicHighlights.join(', ')} communities.`,
        )
      }

      const eligibility = template.eligibility_bullets.map((line) =>
        line.replace('{zip}', zip),
      )
      if (demographicHighlights.length > 0) {
        eligibility.push(`Demonstrate engagement with ${demographicHighlights.join(', ')} beneficiaries.`)
      }
      if (interestHighlights.length > 0) {
        eligibility.push(`Highlight activities in ${interestHighlights.join(', ')}.`)
      }

      const opportunity = {
        title: template.title.replace('{zip}', zip),
        sponsor: `${coords.city} Community Funding Board`,
        description: descriptionParts.join(' '),
        amount_min: template.amount_min,
        amount_max: template.amount_max,
        amount_description: `Awards between $${formatter.format(template.amount_min)} and $${formatter.format(template.amount_max)}`,
        deadline,
        deadline_type: 'fixed',
        application_url: `https://funding.example.org/${zip}/${template.id}`,
        is_national: 0,
        state: coords.state,
        categories: Array.from(categories),
        keywords: Array.from(keywordSet),
        opportunity_type: 'grant',
        requires_match: false,
        requires_501c3: false,
        source: 'comprehensive_crawler',
        source_id: `${zip}-${template.id}-${index}`,
        eligibility_bullets: eligibility,
        profile_focus: focusSummary,
        match_reasons: [
          focusSummary && focusSummary.length > 0 ? `Profile focus: ${focusSummary}` : null,
          demographicHighlights.length > 0 ? `Demographic emphasis: ${demographicHighlights.join(', ')}` : null,
          interestHighlights.length > 0 ? `Interest signals: ${interestHighlights.join(', ')}` : null,
        ].filter(Boolean),
        notes:
          focusSummary && focusSummary.length > 0
            ? `Profile focus: ${focusSummary}`
            : `Auto-generated from comprehensive crawler template ${template.id}`,
      }

      evaluated += 1
      const result = upsertFundingOpportunity(db, opportunity)
      if (result.inserted) {
        inserted += 1
      }
      
      // Save to profile pipeline if match > 80%
      if (profileId && profileContext && result.opportunity) {
        const pipelineResult = saveToProfilePipeline(
          db, 
          result.opportunity, 
          profileId, 
          profileContext
        )
        if (pipelineResult.saved) {
          console.log(`[comprehensive-crawler] Added to pipeline: ${pipelineResult.matchPercentage}% match`)
        }
      }

      opportunityLogs.push({
        title: opportunity.title,
        zip,
        deadline,
        amount_min: opportunity.amount_min,
        amount_max: opportunity.amount_max,
        match_reasons: opportunity.match_reasons,
        inserted: !!result.inserted,
      })
    })
  }
  
  return { inserted, evaluated, opportunityLogs }
}

async function processComprehensiveCrawlerJobOptimized({ db, job, dataDir, profileContext }) {
  const parameters = job.parameters ?? {}
  const templates = loadJSON(
    join(dataDir, 'comprehensive_templates.json'),
  ).templates

  if (!Array.isArray(templates) || templates.length === 0) {
    throw new Error('No comprehensive crawler templates configured')
  }

  const zipCoordinates = loadJSON(join(dataDir, 'zip_coordinates.json'))
  const totalZipCount = Object.keys(zipCoordinates).length

  let zipList = parameters.zip_list
  if (typeof zipList === 'string') {
    zipList = zipList
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  }
  if (!Array.isArray(zipList) || zipList.length === 0) {
    const derivedZip = extractZipFromContext({
      profile: profileContext?.profile,
      sections: profileContext?.sections,
      jobParameters: parameters,
    })
    if (derivedZip) {
      zipList = [derivedZip]
    }
  }

  // OPTIMIZATION: Limit default ZIP codes to prevent crashes
  const MAX_ZIPS_PER_RUN = 100 // Process max 100 ZIPs at a time
  
  if (!Array.isArray(zipList) || zipList.length === 0) {
    // Instead of processing ALL 43,859 ZIPs, process a reasonable subset
    const fallbackLimit = Math.min(
      Number(parameters.fallback_zip_limit ?? MAX_ZIPS_PER_RUN),
      MAX_ZIPS_PER_RUN
    )
    zipList = Object.keys(zipCoordinates)
      .slice(0, fallbackLimit)
      .map((zip) => zip.trim())
      .filter(Boolean)
    console.log(
      `[comprehensive-crawler] Limited to ${zipList.length} ZIPs to prevent server crash (was ${totalZipCount})`,
    )
  }

  zipList = Array.from(
    new Set(
      zipList
        .map((value) => (typeof value === 'string' ? value.trim() : String(value ?? '')).slice(0, 10))
        .filter((value) => /^\d{5}$/.test(value)),
    ),
  ).slice(0, MAX_ZIPS_PER_RUN) // Ensure we never process more than MAX_ZIPS_PER_RUN

  if (zipList.length === 0) {
    zipList = Object.keys(zipCoordinates)
      .slice(0, Math.min(10, totalZipCount)) // Fallback to just 10 ZIPs
      .filter((value) => /^\d{5}$/.test(value))
  }

  const limitPerZip = Number(parameters.limit_per_zip ?? 3)

  if (limitPerZip < 1) {
    throw new Error('limit_per_zip must be at least 1')
  }

  const signals = profileContext ? buildProfileSignals(profileContext) : {
    keywordSet: new Set(),
    phrases: new Set(),
    demographics: new Set(),
    interests: new Set(),
    assistance: new Set(),
    location: {},
    academics: {},
  }
  const focusSummary = summarizeProfileSignals(signals)

  console.log(`[comprehensive-crawler] Processing ${zipList.length} ZIPs with ${limitPerZip} opportunities each`)
  
  // OPTIMIZATION: Process in batches
  const BATCH_SIZE = 10 // Process 10 ZIPs at a time
  let totalInserted = 0
  let totalEvaluated = 0
  const allOpportunityLogs = []
  const startTime = Date.now()
  
  // Prepare ZIP data
  const zipData = zipList.map(zip => ({
    zip,
    coords: zipCoordinates[zip]
  })).filter(item => item.coords)
  
  // Process in batches
  for (let i = 0; i < zipData.length; i += BATCH_SIZE) {
    const batch = zipData.slice(i, Math.min(i + BATCH_SIZE, zipData.length))
    console.log(`[comprehensive-crawler] Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(zipData.length/BATCH_SIZE)}`)
    
    const batchResults = await processBatch(
      batch, 
      templates, 
      limitPerZip, 
      signals, 
      focusSummary, 
      db,
      profileContext,
      job.profile_id
    )
    totalInserted += batchResults.inserted
    totalEvaluated += batchResults.evaluated
    allOpportunityLogs.push(...batchResults.opportunityLogs)
    
    // Small delay between batches to prevent overwhelming the system
    if (i + BATCH_SIZE < zipData.length) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  
  const duration = Date.now() - startTime
  
  // Update job status
  const updateQuery = db.prepare(`
    UPDATE crawler_jobs
    SET status = 'completed',
        completed_at = CURRENT_TIMESTAMP,
        results = ?,
        parameters = json_set(
          COALESCE(parameters, '{}'),
          '$.executed_zip_count', ?,
          '$.executed_limit_per_zip', ?,
          '$.evaluated', ?,
          '$.inserted', ?,
          '$.duration_ms', ?
        )
    WHERE id = ?
  `)
  
  updateQuery.run(
    JSON.stringify({
      summary: `Evaluated ${totalEvaluated} opportunities across ${zipList.length} ZIPs; inserted ${totalInserted} new records in ${duration}ms`,
      zip_count: zipList.length,
      evaluated: totalEvaluated,
      inserted: totalInserted,
      logs: allOpportunityLogs.slice(0, 100), // Keep only first 100 logs to prevent huge DB entries
    }),
    zipList.length,
    limitPerZip,
    totalEvaluated,
    totalInserted,
    duration,
    job.id,
  )

  console.log(
    `[comprehensive-crawler] Batch ${zipList.length}: ${totalInserted}/${totalEvaluated} opportunities (${duration}ms)`,
  )
  
  return {
    evaluated: totalEvaluated,
    inserted: totalInserted,
    zip_count: zipList.length,
  }
}

// Export the optimized function
export { processComprehensiveCrawlerJobOptimized as processComprehensiveCrawlerJob }