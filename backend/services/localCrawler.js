/**
 * Local Crawler (job runner) - Specialist: local funding within 50 miles
 *
 * This job implementation delegates to the live `localFundingCrawler` so it matches the
 * production definition: exclude loans/matching funds and stay within 50 miles of the
 * profile ZIP (or campus/target ZIP for students).
 */

import { upsertFundingOpportunity } from './opportunityInserter.js'
import { saveToProfilePipeline } from './opportunityMatcher.js'
import { crawlLocalFunding } from './crawlers/localFundingCrawler.js'

export async function processLocalCrawlerJob({ db, job, profileContext }) {
  console.log('[localCrawler] Starting local opportunity search (50-mile specialist)...')

  if (!profileContext?.profile) {
    throw new Error('Local crawler requires a profile context')
  }

  const parameters = job.parameters ?? {}
  const matchThreshold = parameters.match_threshold || 50
  const maxResults = parameters.max_results || 30

  const profile = {
    ...profileContext.profile,
    sections: profileContext.sections,
    signals: profileContext.signals,
  }

  const found = await crawlLocalFunding(profile, { min_match_score: matchThreshold, ...parameters })
  const topOpps = (Array.isArray(found) ? found : [])
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
    .slice(0, maxResults)

  const profileId = profileContext?.profile?.id
  let insertedCount = 0
  let savedToPipeline = 0

  for (const opp of topOpps) {
    try {
      const result = await upsertFundingOpportunity(db, {
        title: opp.title,
        sponsor: opp.sponsor,
        description: opp.description,
        amount_min: opp.amount_min,
        amount_max: opp.amount_max,
        amount_description: opp.amount_description,
        deadline: opp.deadline,
        deadline_type: opp.deadline_type,
        application_url: opp.application_url ?? opp.url,
        source_url: opp.source_url ?? opp.url,
        categories: opp.categories,
        keywords: opp.keywords,
        eligibility_bullets: opp.eligibility_bullets,
        requires_match: false,
        requires_501c3: opp.requires_501c3,
        state: opp.state,
        source: 'local_funding',
        source_id: opp.source_id ?? opp.id ?? null,
        match_reasons: opp.match_reasons,
        record_origin: 'live_crawl',
      })

      if (result.inserted) insertedCount++

      if (profileId && (opp.match_score ?? 0) >= 80) {
        const oppWithId = { ...opp, id: result.id }
        const pipelineResult = await saveToProfilePipeline(db, oppWithId, profileId, profileContext, opp.match_score)
        if (pipelineResult.saved) savedToPipeline++
      }
    } catch (err) {
      console.error(`[localCrawler] Error inserting ${opp.title}:`, err.message)
    }
  }

  return {
    evaluated: Array.isArray(found) ? found.length : 0,
    inserted: insertedCount,
    matched: topOpps.length,
    savedToPipeline,
    opportunityLogs: topOpps.map((o) => ({
      title: o.title,
      sponsor: o.sponsor,
      score: o.match_score,
      reasons: o.match_reasons,
      distance_miles: o.distance_miles ?? null,
    })),
  }
}

export default processLocalCrawlerJob
