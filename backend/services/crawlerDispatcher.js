import fs from 'fs'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'
import { processAvatarLookupJob } from './avatarCrawler.js'
import { processLocalCrawlerJob } from './localCrawler.js'
// scholarshipCrawler + health_resources removed — replaced by curated_benefits via crawlerManager
import { runComprehensiveCrawler as processComprehensiveCrawlerJob } from './comprehensiveCrawlerOptimized.js'
import { processItemCrawlerJob } from './itemCrawler.js'
import { processItemGiftCrawlerJob } from './itemGiftCrawler.js'
import { processDocumentIngestionJob } from './documentIngestion.js'
import { processPipelineAutomationJob } from './pipelineAutomation.js'
import { buildProfileContext } from './profileHelpers.js'
import { resolveProfileForId } from '../utils/profileResolver.js'
import { prepareContextForSnapshot, restoreContextFromSnapshot } from './snapshotSerialization.js'
import { processProfileEnrichmentJob } from './profileEnrichment.js'
import { processFoundation990Job } from './crawlers/foundation990Crawler.js'
import { processNationalJob } from './nationalJobRouter.js'
import { processStudentBridgeFundingJob } from './crawlers/studentBridgeFundingCrawler.js'
import { processAnyaMatchScoutJob } from './anyaMatchScout.js'
import { logFailedJob, determineSeverity } from './deadLetterQueue.js'
import { runCrawler as runCuratedCrawler } from './crawlers/crawlerManager.js'
import { updateJobHeartbeat, maybeCleanupStaleRunningJobs } from './crawlerConcurrencyGuard.js'
import { runPortalCheck } from './portalCheckService.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('crawlerDispatcher')
import {
  WORKER_ID,
  claimJob as claimJobState,
  completeJob as completeJobState,
  failJob as failJobState,
  markJobPartial as partialJobState,
  jobHasMeaningfulProgress,
  logJobEvent,
} from './crawlerJobState.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const dataDir = process.env.CRAWLER_DATA_DIR
  ? resolve(String(process.env.CRAWLER_DATA_DIR))
  : join(__dirname, '..', 'data', 'crawlers')

/**
 * Errors that should NOT be auto-retried because they are permanent failures.
 * FK violations, missing profiles, and similar structural errors will never
 * succeed on retry — retrying them just wastes resources and creates noise.
 */
const NON_RETRYABLE_PATTERNS = [
  /no longer exists/i,
  /foreign key constraint/i,
  /violates foreign key/i,
  /FOREIGN KEY constraint failed/i,
  /profile .* not found/i,
  /profile_id .* does not exist/i,
  /timed out after \d+s/i,
]

function isNonRetryableError(errorMsg) {
  if (!errorMsg) return false
  return NON_RETRYABLE_PATTERNS.some(pattern => pattern.test(errorMsg))
}

/**
 * Maximum wall-clock time a single crawler handler may run before being aborted.
 * Default 30 minutes; override via CRAWLER_JOB_TIMEOUT_MS.
 * This prevents jobs from hanging silently and blocking the per-profile lock forever.
 */
const JOB_TIMEOUT_MS = parseInt(process.env.CRAWLER_JOB_TIMEOUT_MS || String(30 * 60 * 1000), 10)

/**
 * Longer timeout for pipeline_automation jobs, which make sequential AI calls per grant.
 * Default 45 minutes; override via PIPELINE_JOB_TIMEOUT_MS.
 */
const PIPELINE_JOB_TIMEOUT_MS = parseInt(process.env.PIPELINE_JOB_TIMEOUT_MS || String(45 * 60 * 1000), 10)

/**
 * Comprehensive crawler (ZIP/domain phases, DB matching) often exceeds 30m in production.
 * Default 2h; override via COMPREHENSIVE_JOB_TIMEOUT_MS.
 */
const COMPREHENSIVE_JOB_TIMEOUT_MS = parseInt(
  process.env.COMPREHENSIVE_JOB_TIMEOUT_MS || String(120 * 60 * 1000),
  10,
)

/**
 * Admin geo comprehensive jobs (profile_id NULL, parameters.mode === 'geo') iterate states/zips.
 * Default 6h; override via COMPREHENSIVE_GEO_JOB_TIMEOUT_MS.
 * The handler uses context.deadlineMs to stop gracefully ~5min before this limit.
 */
const COMPREHENSIVE_GEO_JOB_TIMEOUT_MS = parseInt(
  process.env.COMPREHENSIVE_GEO_JOB_TIMEOUT_MS || String(6 * 60 * 60 * 1000),
  10,
)

/**
 * @param {string} jobType
 * @param {object} job - raw row (may have string parameters)
 * @param {object} parameters - parsed job.parameters
 */
function getJobTimeoutMs(jobType, job, parameters) {
  if (jobType === 'pipeline_automation') return PIPELINE_JOB_TIMEOUT_MS
  if (jobType === 'comprehensive') {
    const params = parameters && typeof parameters === 'object' ? parameters : {}
    const noProfile = !job?.profile_id
    if (noProfile && params.mode === 'geo') return COMPREHENSIVE_GEO_JOB_TIMEOUT_MS
    return COMPREHENSIVE_JOB_TIMEOUT_MS
  }
  return JOB_TIMEOUT_MS
}

function withTimeout(promise, ms, label, abortController) {
  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)
      err.code = 'JOB_TIMEOUT'
      if (abortController) abortController.abort(err.message)
      reject(err)
    }, ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId))
}

async function processPortalCheckJob({ db, job }) {
  const profileId = job?.profile_id
  if (!profileId) throw new Error('portal_check requires a profile_id')
  const params = typeof job?.parameters === 'string' ? JSON.parse(job.parameters) : (job?.parameters || {})
  const result = await runPortalCheck(db, profileId, {
    checkType: params.check_type || 'scheduled',
    maxPortals: params.max_portals ?? 20,
  }).catch(error => {
    throw new Error(`Portal check failed: ${error.message}`);
  })
  return {
    result_count: result.awardsDetected,
    result_meta: {
      portals_checked: result.portalsChecked,
      awards_detected: result.awardsDetected,
      updates: result.updates.map((u) => ({
        portalName: u.portalName,
        updateType: u.updateType,
        awardAmount: u.awardAmount,
      })),
    },
  }
}


async function processCuratedBenefitsJob({ db, job, profileContext }) {
  const profileId = job?.profile_id || profileContext?.profile?.id;
  if (!profileId) throw new Error('curated_benefits requires a profile_id');
  const params = typeof job?.parameters === 'string' ? JSON.parse(job.parameters) : (job?.parameters || {});
  // Map job types to strategy IDs (e.g. 'scholarship' → 'student_grants', 'health_resources' → 'health_resources')
  const JOB_TYPE_TO_STRATEGY = {
    scholarship: 'student_grants',
    curated_benefits: 'curated_benefits',
    health_resources: 'health_resources',
    government_funding: 'government_funding',
    student_grants: 'student_grants',
    ecf_benefits: 'ecf_benefits',
    ecf_hcbs: 'ecf_benefits',       // alias used by autoDiscoveryCrawlers.js
    special_needs: 'special_needs',
    local_funding: 'local_funding',
    item_matching: 'item_matching',
    nonprofit_org: 'nonprofit_org',
    volunteer_fire: 'volunteer_fire',
    church: 'church',
    faith_based: 'church',
    ministry: 'church',
    family: 'family',
    school: 'school',
    k12: 'school',
    charter_school: 'school',

    // Phase 4 expansion: local-government / education / public-institution
    // / specialized-nonprofit verticals. Aliases route to the same
    // canonical strategy so legacy job names keep working.
    county_government: 'county_government',
    county: 'county_government',
    county_official: 'county_government',
    local_government: 'county_government',
    municipality: 'municipality',
    city: 'municipality',
    town: 'municipality',
    public_agency: 'public_agency',
    regional_planning_agency: 'county_government',
    economic_development_agency: 'county_government',
    tribal_government: 'tribal_government',
    tribal: 'tribal_government',

    teacher: 'teacher_classroom',
    classroom_teacher: 'teacher_classroom',
    educator: 'teacher_classroom',
    teacher_classroom: 'teacher_classroom',
    pta_pto: 'teacher_classroom',

    school_district: 'school_district_department',
    public_school: 'school_district_department',
    special_education_program: 'school_district_department',
    school_food_service: 'school_district_department',
    school_transportation: 'school_district_department',
    library_media_center: 'school_district_department',

    library: 'library',
    public_library: 'library',
    museum: 'library',

    parks_department: 'parks_recreation',
    parks_recreation: 'parks_recreation',
    community_center: 'parks_recreation',

    public_health_department: 'public_health_department',
    health_department: 'public_health_department',

    animal_rescue: 'animal_rescue',
    animal_shelter: 'animal_rescue',
    humane_society: 'animal_rescue',

    food_pantry: 'food_pantry',
    food_bank: 'food_pantry',
    soup_kitchen: 'food_pantry',

    homeless_shelter: 'homeless_services',
    homeless_services: 'homeless_services',
    transitional_housing: 'homeless_services',
    domestic_violence_shelter: 'homeless_services',
    reentry_program: 'homeless_services',
  };
  const crawlerType = JOB_TYPE_TO_STRATEGY[job?.type] || 'comprehensive';
  const result = await runCuratedCrawler(db, profileId, {
    minScore: params.minScore ?? 25,
    maxResults: params.maxResults ?? 100,
    crawlerType,
    profileContext,
  }).catch(error => {
    throw new Error(`Curated crawler failed: ${error.message}`);
  })
  return {
    result_count: result.results.length,
    result_meta: {
      total_matched: result.results.length,
      state: result.analysis?.location?.state,
      applicant_type: result.analysis?.applicantType,
      top_match: result.results[0]?.name || null,
      statePortal: result.statePortal?.benefitsPortal || null,
    },
  };
}

/**
 * Clinical-trials study discovery for opted-in medical-need profiles.
 *
 * Surfaces RECRUITING ClinicalTrials.gov studies (early/Phase 1 boosted) for a
 * profile that EXPLICITLY opted in. Discovery/display only — never enrolls.
 * The opt-in is re-checked inside connectorIngestService (the
 * 'clinicaltrials.gov' source gate); when the profile has not consented the
 * source reports `not_applicable` and inserts nothing.
 */
async function processClinicalTrialsJob({ db, job, profileContext }) {
  const profileId = job?.profile_id || profileContext?.profile?.id
  if (!profileId) throw new Error('clinical_trials requires a profile_id')

  // Lazy import keeps the dispatcher's static import graph lean and avoids a
  // cycle (connectorIngestService → opportunityInserter → …).
  const { ingestFromConnectors } = await import('./connectorIngestService.js')
  const { buildProfileSignals } = await import('./profileHelpers.js')

  let ctx = profileContext
  if (!ctx?.profile) {
    ctx = await buildProfileContext(db, profileId)
  }
  let signals = {}
  try {
    signals = buildProfileSignals({ profile: ctx.profile, sections: ctx.sections })
  } catch (err) {
    log.warn('[clinicalTrials] buildProfileSignals failed (continuing):', err?.message || err)
  }

  // Run ONLY the clinical-trials source. The gate inside the service enforces
  // opt-in; we additionally filter the coverage report so the job result is
  // scoped to this source.
  const { coverage } = await ingestFromConnectors({
    db,
    profileContext: ctx,
    signals,
    onlySources: ['clinicaltrials.gov'],
  })
  const ct = (coverage || []).find((r) => r.source === 'clinicaltrials.gov') || {
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    status: 'not_run',
  }

  return {
    result_count: ct.inserted,
    result_meta: {
      source: 'clinicaltrials.gov',
      status: ct.status,
      fetched: ct.fetched,
      inserted: ct.inserted,
      updated: ct.updated,
      skipped: ct.skipped,
      opt_in_gated: ct.status === 'not_applicable',
    },
  }
}

const HANDLERS = {
  avatar_lookup: processAvatarLookupJob,
  clinical_trials: processClinicalTrialsJob,
  local: processLocalCrawlerJob,
  scholarship: processCuratedBenefitsJob,
  curated_benefits: processCuratedBenefitsJob,
  health_resources: processCuratedBenefitsJob,
  comprehensive: processComprehensiveCrawlerJob,
  national: processNationalJob,
  item_search: processItemCrawlerJob,
  item_gift_search: processItemGiftCrawlerJob,
  document_ingest: processDocumentIngestionJob,
  pipeline_automation: processPipelineAutomationJob,
  profile_enrichment: processProfileEnrichmentJob,
  student_bridge_funding: processStudentBridgeFundingJob,
  anya_match_scout: processAnyaMatchScoutJob,
  government_funding: processCuratedBenefitsJob,
  student_grants: processCuratedBenefitsJob,
  ecf_benefits: processCuratedBenefitsJob,
  ecf_hcbs: processCuratedBenefitsJob,   // alias used by autoDiscoveryCrawlers.js
  special_needs: processCuratedBenefitsJob,
  local_funding: processCuratedBenefitsJob,
  item_matching: processCuratedBenefitsJob,
  foundation_990: processFoundation990Job,
  portal_check: processPortalCheckJob,
  church: processCuratedBenefitsJob,
  faith_based: processCuratedBenefitsJob,
  ministry: processCuratedBenefitsJob,
  family: processCuratedBenefitsJob,
  school: processCuratedBenefitsJob,
  k12: processCuratedBenefitsJob,
  charter_school: processCuratedBenefitsJob,
}

function parseJSON(value) {
  if (!value) return {}
  try {
    return JSON.parse(value)
  } catch (error) {
    console.warn('[crawlerDispatcher] Failed to parse parameters JSON', error)
    return {}
  }
}

function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function getMaxGlobalConcurrency() {
  // Prefer MAX_CONCURRENT_CRAWLERS (same as crawlerConcurrencyGuard.js) for consistency,
  // fall back to CRAWLER_MAX_CONCURRENCY for backward compat.
  const envValue = process.env.MAX_CONCURRENT_CRAWLERS || process.env.CRAWLER_MAX_CONCURRENCY
  return clampInt(envValue, { min: 1, max: 50, fallback: 10 })
}

function getDispatchMaxAttempts() {
  return clampInt(process.env.CRAWLER_DISPATCH_MAX_ATTEMPTS, { min: 1, max: 200, fallback: 60 })
}

function computeBackoffMs(attempt) {
  const base = clampInt(process.env.CRAWLER_DISPATCH_BASE_DELAY_MS, { min: 250, max: 60_000, fallback: 1_500 })
  const cap = clampInt(process.env.CRAWLER_DISPATCH_MAX_DELAY_MS, { min: 1_000, max: 10 * 60_000, fallback: 60_000 })
  const exp = Math.min(16, Math.max(0, attempt - 1))
  const jitter = Math.floor(Math.random() * 250)
  return Math.min(cap, base * (2 ** exp) + jitter)
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

function normalizeIso(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

async function ensureJobSnapshot(db, job) {
  if (!job?.profile_id) return { snapshotJson: job?.profile_context_snapshot ?? null, repaired: false }
  if (job.profile_context_snapshot) return { snapshotJson: job.profile_context_snapshot, repaired: false }

  // Deterministic reference: use the job's persisted created_at when available.
  const asOf = normalizeIso(job.created_at) || null

  // Self-heal stale profile_ids before building the snapshot. A job may carry a
  // designated-profile slug (e.g. `profile-anastasia-white`) while the live row
  // is keyed by UUID (or vice-versa) — we must not mark the job non-retryable
  // when an alias resolution would succeed.
  let snapshotProfileId = job.profile_id
  let context
  try {
    context = await buildProfileContext(db, snapshotProfileId, { asOf })
  } catch (lookupErr) {
    const lookupMsg = String(lookupErr?.message || lookupErr || '')
    const looksLikeMissingProfile = /Profile\s.+?\snot found/i.test(lookupMsg)
    if (!looksLikeMissingProfile) throw lookupErr

    const resolved = await resolveProfileForId(db, snapshotProfileId)
    if (!resolved) throw lookupErr

    snapshotProfileId = resolved.resolvedId
    if (resolved.repaired) {
      // Persist the corrected id so future passes (retries, telemetry,
      // entitlement checks) all see the live profile.
      try {
        await db
          .prepare('UPDATE crawler_jobs SET profile_id = ? WHERE id = ?')
          .run(snapshotProfileId, job.id)
        log.info(
          '[crawlerDispatcher] Repaired stale crawler_jobs.profile_id alias',
          {
            jobId: job.id,
            from: resolved.originalId,
            to: resolved.resolvedId,
            strategy: resolved.strategy,
          },
        )
      } catch (persistErr) {
        // Repair is best-effort; we still proceed with the snapshot using the
        // resolved id even if the UPDATE failed.
        console.warn(
          '[crawlerDispatcher] Failed to persist repaired profile_id, continuing with in-memory id',
          {
            jobId: job.id,
            error: persistErr?.message || String(persistErr),
          },
        )
      }
      // Reflect the new id on the in-memory job object so downstream
      // handlers see the live profile.
      try {
        job.profile_id = snapshotProfileId
      } catch { /* read-only proxies are fine to skip */ }
    }
    context = await buildProfileContext(db, snapshotProfileId, { asOf })
  }

  const serializable = prepareContextForSnapshot(context)
  const snapshotJson = stableStringify(serializable)
  const snapshotHash = crypto.createHash('sha256').update(snapshotJson).digest('hex')

  // Concurrency safety: only write snapshot if still NULL.
  const updateRes = await db
    .prepare(
      `
        UPDATE crawler_jobs
        SET profile_context_snapshot = ?,
            error = NULL
        WHERE id = ?
          AND profile_context_snapshot IS NULL
      `,
    )
    .run(snapshotJson, job.id)

  const wrote = Number(updateRes?.changes ?? updateRes?.rowCount ?? 0) > 0

  const fresh = await db
    .prepare('SELECT profile_context_snapshot FROM crawler_jobs WHERE id = ? LIMIT 1')
    .get(job.id)

  const persisted = fresh?.profile_context_snapshot ?? null
  return { snapshotJson: persisted || snapshotJson, repaired: wrote, snapshotHash }
}

export function dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI }) {
  const handle = async () => {
    const job = await db.prepare('SELECT * FROM crawler_jobs WHERE id = ? LIMIT 1').get(jobId)
    if (!job) {
      console.warn('[crawlerDispatcher] Job not found', jobId)
      return
    }

    if (job.status && job.status !== 'queued') {
      // Grep-friendly so we can see why the dispatcher bailed out.
      logJobEvent('claim_skipped', 'job not in queued state', {
        jobId,
        status: job.status,
        worker_id_current: job.worker_id,
      })
      return
    }
    
    // If a previous dispatcher pass scheduled this job in the future, respect it.
    if (job.next_dispatch_at) {
      const nextAt = new Date(job.next_dispatch_at)
      if (!Number.isNaN(nextAt.getTime())) {
        const waitMs = nextAt.getTime() - Date.now()
        if (waitMs > 250) {
          setTimeout(() => {
            dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI }).catch(e => console.warn('[crawlerDispatcher] Deferred dispatch error for job', jobId, e?.message || e))
          }, Math.min(waitMs, 60_000))
          return
        }
      }
    }

    const handler = HANDLERS[job.type]
    if (!handler) {
      const errorMsg = `Unhandled crawler type "${job.type}"`
      await db.prepare(`
        UPDATE crawler_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error = ?
        WHERE id = ?
      `).run(errorMsg, jobId)
      
      // Log to dead letter queue
      await logFailedJob(db, {
        jobId,
        jobType: job.type,
        profileId: job.profile_id,
        error: errorMsg,
        jobParameters: parseJSON(job.parameters),
        severity: 'high',
      })
      return
    }

    const maxGlobalConcurrency = getMaxGlobalConcurrency()

    // Concurrency control (per-profile):
    // If a profile-scoped job is queued while another job for that profile is already running,
    // do NOT fail the job (that pollutes diagnostics). Instead keep it queued and retry soon.
    const profileId = job.profile_id ?? null

    // Admin-initiated geo crawl jobs (type='comprehensive', mode='geo', profile_id=NULL) are
    // long-running discovery jobs that must not be starved by the global concurrency cap.
    // They run in their own "slot" — exempt from the running-count check.
    const jobParams = parseJSON(job.parameters)
    const isGeoCrawlJob = !profileId && job.type === 'comprehensive' && jobParams?.mode === 'geo'

    // All transitions route through crawlerJobState.claimJob so the atomic
    // claim, worker_id assignment, attempt_count increment, and heartbeat
    // stamp are applied consistently. Per-profile and global concurrency
    // guards are passed as extra WHERE clauses so the DB row remains the lock.
    let extraWhereSql = null
    let extraWhereParams = []
    if (!isGeoCrawlJob && profileId) {
      extraWhereSql =
        `(SELECT COUNT(*) FROM crawler_jobs WHERE status = 'running') < ? ` +
        `AND NOT EXISTS (SELECT 1 FROM crawler_jobs WHERE profile_id = ? AND status = 'running' AND id <> ?)`
      extraWhereParams = [maxGlobalConcurrency, profileId, jobId]
    } else if (!isGeoCrawlJob) {
      extraWhereSql = `(SELECT COUNT(*) FROM crawler_jobs WHERE status = 'running') < ?`
      extraWhereParams = [maxGlobalConcurrency]
    }

    const claimResult = await claimJobState(db, jobId, {
      extraWhereSql,
      extraWhereParams,
    })
    const startedCount = claimResult.claimed ? 1 : 0
    if (startedCount === 0) {
      // Another job is already running for this profile, or we hit the global concurrency cap.
      // Apply bounded backoff and eventually re-queue with extended delay to prevent permanent loss.
      const attempts = Number(job.dispatch_attempts ?? 0) + 1
      const maxAttempts = getDispatchMaxAttempts()

      if (attempts > maxAttempts) {
        // Instead of permanently dead-lettering, re-queue with a longer backoff.
        // Track re-queue cycles to enforce a hard cap and prevent infinite loops.
        const existingMeta = (() => {
          try { return JSON.parse(job.result_meta || '{}') } catch { return {} }
        })()
        const requeueCycles = Number(existingMeta?.requeue_cycles ?? 0)
        const MAX_REQUEUE_CYCLES = 3

        if (requeueCycles >= MAX_REQUEUE_CYCLES) {
          // Hard cap reached — permanently dead-letter the job.
          const deadLetter = {
            reason: 'dispatch_exhausted',
            attempts,
            max_attempts: maxAttempts,
            requeue_cycles: requeueCycles,
            profile_id: profileId,
            max_global_concurrency: maxGlobalConcurrency,
            last_attempt_at: new Date().toISOString(),
          }

          await db.prepare(
            `
              UPDATE crawler_jobs
              SET status = 'failed',
                  completed_at = CURRENT_TIMESTAMP,
                  error = ?,
                  result_meta = COALESCE(?, result_meta)
              WHERE id = ?
            `,
          ).run(
            'Crawler dispatch exhausted due to concurrency limits',
            JSON.stringify({ dead_letter: deadLetter }),
            jobId,
          )
          return
        }

        // Re-queue with an extended backoff (5 minutes) and reset dispatch_attempts.
        const requeueDelayMs = 5 * 60 * 1000
        const nextAtIso = new Date(Date.now() + requeueDelayMs).toISOString()
        const updatedMeta = JSON.stringify({ ...existingMeta, requeue_cycles: requeueCycles + 1 })

        console.warn('[crawlerDispatcher] Dispatch attempts exhausted, re-queuing with extended backoff', {
          jobId, attempts, maxAttempts, requeueCycle: requeueCycles + 1, nextRetryAt: nextAtIso,
        })

        try {
          await db.prepare(
            `
              UPDATE crawler_jobs
              SET dispatch_attempts = 0,
                  next_dispatch_at = ?,
                  error = NULL,
                  result_meta = COALESCE(?, result_meta)
              WHERE id = ?
                AND status = 'queued'
            `,
          ).run(nextAtIso, updatedMeta, jobId)
        } catch (error) {
          // If we can't persist the incremented requeue_cycles, dead-letter the job
          // to prevent an infinite requeue loop.
          console.error('[crawlerDispatcher] Failed to persist re-queue metadata — dead-lettering job to prevent infinite loop', { jobId, error: error?.message })
          try {
            await db.prepare(
              `UPDATE crawler_jobs SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error = ? WHERE id = ?`,
            ).run('Re-queue metadata persistence failed; dead-lettered to prevent infinite loop', jobId)
          } catch { /* best effort */ }
          return
        }

        setTimeout(() => {
          dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI }).catch(e => console.warn('[crawlerDispatcher] Re-queue dispatch error for job', jobId, e?.message || e))
        }, requeueDelayMs)
        return
      }

      const delayMs = computeBackoffMs(attempts)
      const nextAtIso = new Date(Date.now() + delayMs).toISOString()
      try {
        await db.prepare(
          `
            UPDATE crawler_jobs
            SET dispatch_attempts = ?,
                next_dispatch_at = ?,
                error = NULL
            WHERE id = ?
              AND status = 'queued'
          `,
        ).run(attempts, nextAtIso, jobId)
      } catch (error) {
        // best-effort; continue with in-process backoff anyway
        console.warn('[crawlerDispatcher] Failed to persist dispatch backoff metadata', error)
      }

      setTimeout(() => {
        dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI }).catch(e => console.warn('[crawlerDispatcher] Backoff dispatch error for job', jobId, e?.message || e))
      }, delayMs)
      return
    }

    // CRITICAL: Use snapshot if available, never load live profile data
    let profileContext = null
    try {
      if (job.profile_id) {
        const { snapshotJson, repaired } = await ensureJobSnapshot(db, job).catch(error => {
    throw new Error(`Snapshot creation failed: ${error.message}`);
  })
        if (snapshotJson) {
          profileContext = restoreContextFromSnapshot(parseJSON(snapshotJson))
          if (repaired) {
            log.info('[crawlerDispatcher] Repaired missing job snapshot (persisted)', jobId)
          } else {
            log.info('[crawlerDispatcher] Using stored profile snapshot for job', jobId)
          }
        }
      } else if (job.profile_context_snapshot) {
        // Non-profile jobs may still carry a snapshot; use it when present.
        profileContext = restoreContextFromSnapshot(parseJSON(job.profile_context_snapshot))
        log.info('[crawlerDispatcher] Using stored profile snapshot for job', jobId)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      const notRetryable = isNonRetryableError(errorMsg)
      const metaJson = notRetryable ? JSON.stringify({ non_retryable: true }) : null
      await db.prepare(`
        UPDATE crawler_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error = ?,
            result_meta = COALESCE(?, result_meta)
        WHERE id = ?
      `).run(errorMsg, metaJson, jobId)

      // Log to dead letter queue
      await logFailedJob(db, {
        jobId,
        jobType: job.type,
        profileId: job.profile_id,
        error,
        jobParameters: parseJSON(job.parameters),
        severity: determineSeverity(error, job.type),
      })
      return
    }

    let result = null

    const startedAt = Date.now()

    // Heartbeat: set initial heartbeat immediately and then periodically so that
    // cleanupStaleCrawlers() doesn't treat this actively-running job as orphaned.
    const HEARTBEAT_INTERVAL_MS = 60_000
    let heartbeatFailures = 0
    const MAX_HEARTBEAT_FAILURES = 3
    await updateJobHeartbeat(db, jobId).catch(error => {
      console.warn('[crawlerDispatcher] Initial heartbeat failed:', error.message)
      heartbeatFailures++
    })
    const heartbeatIntervalId = setInterval(() => {
      updateJobHeartbeat(db, jobId).catch((err) => {
        heartbeatFailures++
        console.warn('[crawlerDispatcher] Heartbeat interval error:', err?.message, { failures: heartbeatFailures })
        if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
          console.error('[crawlerDispatcher] Heartbeat failed too many times — job may be orphaned', { jobId })
        }
      })
    }, HEARTBEAT_INTERVAL_MS)

    const abortController = new AbortController()

    try {
      const parameters = parseJSON(job.parameters)
      const context = {
        db,
        job: { ...job, parameters },
        profileContext,
        dataDir,
        uploadDir,
        getOpenAI,
        signal: abortController.signal,
      }

      const timeoutMs = getJobTimeoutMs(job.type, job, parameters)
      if (job.type === 'comprehensive') {
        log.info('[crawlerDispatcher] Comprehensive job timeout (ms)', {
          jobId,
          timeoutMs,
          profile_id: job.profile_id ?? null,
          mode: parameters?.mode ?? null,
        })
      }

      // Pass deadline + heartbeat into context so the handler can stop gracefully
      // before the hard timeout kills it as a failure.
      context.deadlineMs = Date.now() + timeoutMs
      context.heartbeat = () => updateJobHeartbeat(db, jobId)

      result = await withTimeout(
        handler(context),
        timeoutMs,
        `Job ${jobId} (${job.type})`,
        abortController,
      )

      if (job.type === 'avatar_lookup' && result?.avatarUrl && profileContext?.profile) {
        const previous = await db
          .prepare('SELECT avatar_url FROM profiles WHERE id = ?')
          .get(profileContext.profile.id)
        await db.prepare(`
          UPDATE profiles
          SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(result.avatarUrl, profileContext.profile.id)

        if (previous?.avatar_url && previous.avatar_url.startsWith('/uploads/')) {
          // best-effort cleanup
          try {
            const absolutePath = join(uploadDir, previous.avatar_url.replace('/uploads/', ''))
            await fs.promises.unlink(absolutePath)
          } catch (error) {
            console.warn('[crawlerDispatcher] Failed to remove previous avatar', error)
          }
        }
      }

      const resultCountValue =
        typeof result?.inserted === 'number'
          ? result.inserted
          : typeof result?.result_count === 'number'
          ? result.result_count
          : null

      const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      const finalResultMeta = {
        ...(result?.result_meta ?? {}),
        duration_seconds: durationSeconds,
      }

      await completeJobState(db, jobId, {
        resultCount: resultCountValue,
        resultMeta: finalResultMeta,
      })
      clearInterval(heartbeatIntervalId)
    } catch (error) {
      clearInterval(heartbeatIntervalId)
      const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      const errorMsg = error instanceof Error ? error.message : String(error)
      const notRetryable = isNonRetryableError(errorMsg)

      // PARTIAL-COMPLETION DETECTION: if this catch is firing because
      // withTimeout aborted a long-running geo/comprehensive job AFTER it had
      // already flushed real progress (3,891 ZIPs / 93,384 sources etc. in
      // result_meta), classifying the row as `failed` would silently discard
      // a real successful run. The data lives in funding_opportunities and
      // is already queryable. Mark the row `completed` with
      // result_meta.partial = true so the UI tells the truth and resume
      // tooling can pick up where the run stopped.
      const isTimeout =
        error?.code === 'JOB_TIMEOUT' ||
        /timed out after \d+s/i.test(errorMsg) ||
        /aborted/i.test(errorMsg) ||
        Boolean(abortController?.signal?.aborted)
      if (isTimeout) {
        let liveRow = null
        try {
          liveRow = await db
            .prepare('SELECT result_count, result_meta FROM crawler_jobs WHERE id = ?')
            .get(jobId)
        } catch { /* best effort */ }
        if (jobHasMeaningfulProgress(liveRow)) {
          await partialJobState(db, jobId, {
            reason: 'withTimeout',
            error: errorMsg,
            durationSeconds,
          }, { force: true })
          // Intentionally do NOT log to dead-letter: this is a successful
          // partial run, not a failure.
          return
        }
      }

      const finalResultMeta = {
        duration_seconds: durationSeconds,
        error: errorMsg,
      }
      if (notRetryable) finalResultMeta.non_retryable = true

      // Force=true because an orphan-recovery sweep may have just reclaimed
      // this job onto another worker. We still want the real error surfaced.
      await failJobState(db, jobId, errorMsg, {
        resultMeta: finalResultMeta,
        force: true,
      })

      // Log to dead letter queue for durable failure tracking
      await logFailedJob(db, {
        jobId,
        jobType: job.type,
        profileId: job.profile_id,
        error,
        jobParameters: parseJSON(job.parameters),
        profileContextSnapshot: profileContext,
        severity: determineSeverity(error, job.type),
      })
    }
  }

  // Return a Promise that resolves when the job completes
  return new Promise((resolve) => {
    setImmediate(() => {
      handle().then(resolve).catch((err) => {
        console.error('[crawlerDispatcher] Unhandled job error:', err)
        resolve() // Resolve anyway to not block
      })
    })
  })
}

/**
 * Start a periodic interval that recovers queued jobs orphaned by process restarts.
 *
 * When a job has a `next_dispatch_at` in the future (set via backoff/retry), the in-process
 * `setTimeout` that would re-dispatch it is lost if the server restarts.  This interval
 * queries for ready-to-run queued jobs every QUEUE_DRAIN_INTERVAL_MS milliseconds and
 * re-dispatches them with a 1-second stagger so they don't stampede concurrency.
 *
 * @param {object} db         - Database connection
 * @param {string} uploadDir  - Path to the uploads directory
 * @param {Function|null} getOpenAI - OpenAI factory, or null
 * @returns {NodeJS.Timeout} The interval handle (call clearInterval to stop it)
 */
export function startQueueDrainInterval(db, uploadDir, getOpenAI) {
  const intervalMs = Number.parseInt(
    process.env.QUEUE_DRAIN_INTERVAL_MS || '60000',
    10,
  )

  const intervalId = setInterval(async () => {
    try {
      // Run stale-job cleanup on every tick so orphaned running jobs release
      // their per-profile locks even when no new jobs are being queued.
      await maybeCleanupStaleRunningJobs(db).catch(e =>
        console.warn('[queue-drain-interval] Stale cleanup error (ignored):', e?.message || e),
      )

      const isPostgres = db?.dialect === 'postgres'
      const nowIso = new Date().toISOString()
      const nowSqlite = nowIso.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '')
      const now = isPostgres ? nowIso : nowSqlite

      const ready = await db
        .prepare(
          isPostgres
            ? `
                SELECT id FROM crawler_jobs
                WHERE status = 'queued'
                  AND (next_dispatch_at IS NULL OR next_dispatch_at <= ?)
                ORDER BY created_at ASC
                LIMIT 10
              `
            : `
                SELECT id FROM crawler_jobs
                WHERE status = 'queued'
                  AND (next_dispatch_at IS NULL OR datetime(next_dispatch_at) <= datetime(?))
                ORDER BY created_at ASC
                LIMIT 10
              `,
        )
        .all(now)

      if (!Array.isArray(ready) || ready.length === 0) return

      log.info(`[queue-drain-interval] Found ${ready.length} ready queued job(s), dispatching with 1s stagger`)

      for (let i = 0; i < ready.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1_000))
        try {
          dispatchCrawlerJob({ db, jobId: ready[i].id, uploadDir, getOpenAI }).catch(e => console.warn('[queue-drain] Dispatch error for job', ready[i].id, e?.message || e))
        } catch (err) { console.warn('[queue-drain] Sync dispatch error for job', ready[i].id, err?.message || err) }
      }
    } catch (err) {
      console.warn('[queue-drain-interval] Poll error (ignored):', err?.message || err)
    }
  }, intervalMs)

  log.info(`[queue-drain-interval] Started (every ${intervalMs / 1000}s)`)
  return intervalId
}
