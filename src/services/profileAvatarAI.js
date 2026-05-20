import { requestProfileAvatarAI } from '@/api/profiles'
import { getCrawlerJob } from '@/api/crawlers'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function avatarLookupSucceeded(job) {
  const meta = job?.result_meta
  if (meta && meta.ok === true) return true
  if (typeof job?.result_count === 'number' && job.result_count > 0) return true
  return false
}

/**
 * Queue the backend avatar_lookup crawler and poll until it completes.
 * Uses website scraping (og:image, icons) with OpenAI image generation fallback.
 */
export async function runProfileAvatarLookup(profileId, options = {}) {
  const {
    websiteHint = null,
    pollIntervalMs = 1500,
    timeoutMs = 60000,
    onProgress = null,
  } = options

  onProgress?.('queued')
  const queued = await requestProfileAvatarAI(profileId, { websiteHint })
  const jobId = queued?.id
  if (!jobId) {
    throw new Error('Avatar lookup did not start.')
  }

  onProgress?.('searching')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)
    const job = await getCrawlerJob(jobId)

    if (job.status === 'completed') {
      if (avatarLookupSucceeded(job)) {
        return { ok: true, job }
      }
      const meta = job?.result_meta ?? {}
      return {
        ok: false,
        job,
        reason: meta.reason || meta.message || 'no_image_found',
      }
    }

    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.error || `Avatar lookup ${job.status}.`)
    }
  }

  throw new Error('Avatar lookup timed out. Check Automation for job status.')
}
