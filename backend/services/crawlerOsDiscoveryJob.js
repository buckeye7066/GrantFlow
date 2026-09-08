import { createCrawlerJob, generateIdempotencyKey } from './crawlerJobCreation.js'
import { computeProfileDigest } from './profileHelpers.js'

export const DISCOVERY_JOB_TYPE = 'crawler_os_discovery'

/** Persist before dispatching: reloads and process restarts retain the work. */
export async function enqueueCrawlerOsDiscovery(db, profileId) {
  const profileContextDigest = await computeProfileDigest(db, profileId)
  const options = {
    type: DISCOVERY_JOB_TYPE,
    profileId,
    parameters: {},
    requestedBy: 'discover-all',
    buildSnapshot: false,
    profileContextDigest,
  }
  let creation
  try {
    creation = await createCrawlerJob(db, options)
  } catch (error) {
    // Two tabs can race the UNIQUE idempotency key. Join the surviving active
    // job; do not hide a database error when no such job exists.
    const key = generateIdempotencyKey(DISCOVERY_JOB_TYPE, profileId, {}, profileContextDigest)
    const job = await db.prepare(
      'SELECT * FROM crawler_jobs WHERE idempotency_key = ? AND status IN (?, ?)',
    ).get(key, 'queued', 'running')
    if (!job) throw error
    creation = { jobId: job.id, existing: true, created: false }
  }
  if (!creation.jobId) throw new Error('Discovery job could not be created')
  // The dispatcher already owns claims, heartbeats, retry and restart recovery.
  // Import lazily because it also imports this module's handler.
  const { dispatchCrawlerJob } = await import('./crawlerDispatcher.js')
  void dispatchCrawlerJob({ db, jobId: creation.jobId }).catch((error) => {
    console.error('[discovery] Dispatch failed; durable job remains queued:', error?.message)
  })
  return {
    success: true,
    profile_id: profileId,
    engine: 'crawler-os',
    synchronous: false,
    jobs_enqueued: creation.created ? 1 : 0,
    job_ids: [creation.jobId],
    existing: Boolean(creation.existing),
  }
}

export async function processCrawlerOsDiscoveryJob({ db, job, signal, deadlineMs }) {
  if (!job?.profile_id) throw new Error('crawler_os_discovery requires a profile_id')
  const { runProfileDiscoveryLive } = await import('./crawlerOsService.js')
  const { run, persisted } = await runProfileDiscoveryLive({
    db,
    profileId: job.profile_id,
    signal,
    // Leave time to persist the receipt before the dispatcher's hard timeout.
    deadlineMs: Number.isFinite(deadlineMs) ? deadlineMs - 5000 : null,
  })
  const sources = Array.isArray(run?.sources) ? run.sources : []
  const unavailableSources = sources.filter((source) =>
    ['fetch_error', 'parse_error', 'error', 'blocked', 'rate_limited'].includes(source.outcome),
  ).length
  return {
    result_count: persisted?.opportunities ?? 0,
    result_meta: {
      engine: 'crawler-os',
      stored: persisted?.opportunities ?? 0,
      matches: persisted?.matches ?? 0,
      planned: run?.planned ?? 0,
      rejected: run?.rejected ?? 0,
      sources,
      unavailable_sources: unavailableSources,
      partial: unavailableSources > 0 || sources.some((source) => source.reason === 'time_budget_exhausted')
        || run?.web_lane?.reason === 'time_budget_exhausted',
      skipped: Boolean(run?.skipped),
      reason: run?.reason ?? null,
      blocked_reason: run?.blocked_reason ?? null,
      zero_result: run?.zero_result ?? null,
    },
  }
}
