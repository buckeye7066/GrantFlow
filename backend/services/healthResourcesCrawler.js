import { upsertFundingOpportunity } from './opportunityInserter.js'
import { saveToProfilePipeline } from './opportunityMatcher.js'
import { summarizeProfileSignals } from './profileHelpers.js'
import { crawlHealthResources } from './crawlers/healthResourcesCrawler.js'

export async function processHealthResourcesCrawlerJob({ db, job, profileContext }) {
  const startTime = Date.now()
  const { profile, sections, signals } = profileContext ?? {}
  if (!profile) {
    throw new Error('Health resources crawler requires a profile context')
  }

  const profileForCrawler = {
    ...profile,
    sections: sections ?? profile.sections ?? {},
    signals: signals ?? profile.signals ?? null,
  }

  const minMatchScore = typeof job?.parameters?.min_match_score === 'number' ? job.parameters.min_match_score : 60
  const includeTrials =
    job?.parameters?.include_trials === true ||
    String(job?.parameters?.include_trials ?? '').toLowerCase() === 'true'

  const opportunities = await crawlHealthResources(profileForCrawler, {
    min_match_score: minMatchScore,
    include_trials: includeTrials,
  })

  if (!Array.isArray(opportunities) || opportunities.length === 0) {
    return {
      evaluated: 0,
      inserted: 0,
      savedToPipeline: 0,
      result_meta: {
        inserted: 0,
        evaluated: 0,
        savedToPipeline: 0,
        note: 'No health resources returned',
      },
      opportunityLogs: [],
    }
  }

  let inserted = 0
  let savedToPipeline = 0
  const profileId = profileForCrawler?.id ?? null
  const opportunityLogs = []

  for (const opp of opportunities) {
    const score = typeof opp.match_score === 'number' ? opp.match_score : 0
    const reasons = Array.isArray(opp.match_reasons) ? opp.match_reasons : []
    const matchSummary =
      reasons.length > 0 ? `Health resource match: ${reasons.join('; ')} (score ${score})` : summarizeProfileSignals(profileForCrawler.signals)

    const upsert = await upsertFundingOpportunity(db, {
      ...opp,
      source: 'health_resources_crawler',
      source_id: opp.source_id ?? opp.url ?? opp.source_url ?? null,
      profile_id: null, // keep global; pipeline linkage is via grants table
      record_origin: 'live_crawl',
      deadline_type: 'unknown',
      requires_match: false,
      requires_501c3: false,
      notes: matchSummary,
      match_reasons: reasons,
      // Ensure evidence_url is present for live_crawl.
      source_url: opp.source_url ?? opp.url ?? opp.application_url ?? null,
      application_url: opp.application_url ?? opp.url ?? opp.source_url ?? null,
      evidence_url: opp.evidence_url ?? opp.source_url ?? opp.url ?? opp.application_url ?? null,
    })

    if (upsert?.inserted) inserted += 1

    // Save to profile pipeline when strong match (reuse existing pipeline threshold semantics).
    if (profileId && score >= 80 && upsert?.id) {
      const oppWithId = { ...opp, id: upsert.id }
      const pipelineResult = await saveToProfilePipeline(db, oppWithId, profileId, profileContext, score)
      if (pipelineResult?.saved) savedToPipeline += 1
    }

    opportunityLogs.push({
      title: opp.title,
      sponsor: opp.sponsor ?? null,
      match_score: score,
      match_reasons: reasons,
      inserted: Boolean(upsert?.inserted),
    })
  }

  return {
    inserted,
    evaluated: opportunities.length,
    savedToPipeline,
    result_count: inserted,
    result_meta: {
      evaluated: opportunities.length,
      inserted,
      savedToPipeline,
      duration_seconds: Math.max(0, Math.round((Date.now() - startTime) / 1000)),
      opportunities: opportunityLogs,
    },
  }
}

