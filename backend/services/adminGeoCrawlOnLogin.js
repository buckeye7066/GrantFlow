/**
 * Queue a nationwide geo crawl (state-by-state inside one comprehensive job) when an admin logs in.
 * Throttled to avoid stacking duplicate long runs; optional cooldown via ANYA_ADMIN_GEO_COOLDOWN_HOURS.
 */

import crypto from 'crypto'
import { dispatchCrawlerJob } from './crawlerDispatcher.js'
import { createGeoCrawlRun, backfillGeoCrawlRunFromJob } from './geoCrawlRunStore.js'
import { resolveUploadsDir } from '../utils/uploadsDir.js'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createLogger } from '../utils/logger.js'
const log = createLogger('adminGeoCrawlOnLogin')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function isAdmin(user) {
  return Boolean(user?.role === 'admin' || user?.is_admin === true || user?.is_admin === 1)
}

function envEnabled(name, defaultValue = true) {
  const v = String(process.env[name] ?? '').trim().toLowerCase()
  if (!v) return defaultValue
  if (v === '0' || v === 'false' || v === 'no') return false
  if (v === '1' || v === 'true' || v === 'yes') return true
  return defaultValue
}

function cooldownHours() {
  const n = Number.parseFloat(process.env.ANYA_ADMIN_GEO_COOLDOWN_HOURS ?? '24', 10)
  if (!Number.isFinite(n) || n < 0) return 24
  return n
}

function defaultUploadDir() {
  const resolved = resolveUploadsDir({ baseDir: join(__dirname, '..') })
  return resolved.uploadsDir
}

/**
 * @param {*} db
 * @param {object} user
 * @param {{ uploadDir?: string, getOpenAI?: () => any, userId?: string }} ctx
 */
export async function scheduleAdminGeoCrawlOnLogin(db, user, ctx = {}) {
  if (!db || !isAdmin(user)) return { scheduled: false, reason: 'not_admin' }

  // CUTOVER: the admin nationwide geo sweep ran as a `comprehensive` crawler_jobs
  // row, which is now a retired discovery type (no dispatcher handler; short-
  // circuited as superseded). Enqueuing it only produced dead "superseded" rows
  // in the Automation Control Center on every admin login. Crawler OS (Robert)
  // owns catalog population now, so this is OFF by default. Kept behind an env
  // flag (default off) so the login / background-service / scheduler call-sites
  // keep working and it can be revived deliberately if the geo path ever returns.
  if (!envEnabled('ANYA_ADMIN_GEO_ON_LOGIN', false)) {
    return { scheduled: false, reason: 'superseded_by_crawler_os' }
  }

  const marker = 'anya_admin_login_sweep'

  try {
    const active = await db
      .prepare(
        `
        SELECT id FROM crawler_jobs
        WHERE type = 'comprehensive'
          AND status IN ('queued', 'running')
          AND parameters LIKE ?
        LIMIT 1
      `,
      )
      .get(`%${marker}%`)

    if (active?.id) {
      log.info(`[adminGeoCrawlOnLogin] Skip: geo sweep already active job=${active.id}`)
      return { scheduled: false, reason: 'already_running', job_id: active.id }
    }

    const hours = cooldownHours()
    if (hours > 0) {
      const last = await db
        .prepare(
          `
          SELECT completed_at FROM crawler_jobs
          WHERE type = 'comprehensive'
            AND status = 'completed'
            AND parameters LIKE ?
          ORDER BY completed_at DESC
          LIMIT 1
        `,
        )
        .get(`%${marker}%`)

      const completedAt = last?.completed_at ? new Date(last.completed_at).getTime() : 0
      if (completedAt && Date.now() - completedAt < hours * 3600 * 1000) {
        log.info(
          `[adminGeoCrawlOnLogin] Skip: last sweep ${new Date(completedAt).toISOString()} (cooldown ${hours}h)`,
        )
        return { scheduled: false, reason: 'cooldown', cooldown_hours: hours }
      }
    }

    const geoRunId = crypto.randomUUID()
    const jobId = crypto.randomUUID()

    const parameters = {
      mode: 'geo',
      run_all_states: true,
      resume: true,
      [marker]: true,
      geo_run_id: geoRunId,
      skip_domain_corpus: envEnabled('ANYA_ADMIN_GEO_SKIP_DOMAIN_CORPUS', true),
      state_pacing_ms: Number.parseInt(process.env.ANYA_ADMIN_GEO_STATE_PACING_MS ?? '2000', 10) || 2000,
      discover_local_resources: true,
      offline_only: false,
      overpass_radius_km: Number.parseInt(process.env.ANYA_ADMIN_GEO_OVERPASS_RADIUS_KM ?? '12', 10) || 12,
      overpass_max_results: Number.parseInt(process.env.ANYA_ADMIN_GEO_OVERPASS_MAX ?? '60', 10) || 60,
    }

    await db
      .prepare(
        `
        INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
        VALUES (?, 'comprehensive', 'queued', NULL, NULL, ?, 'anya_admin_login')
      `,
      )
      .run(jobId, JSON.stringify(parameters))

    const job = await db
      .prepare('SELECT id, type, status, created_at, parameters FROM crawler_jobs WHERE id = ?')
      .get(jobId)

    try {
      await createGeoCrawlRun(db, {
        id: geoRunId,
        state: null,
        createdByUserId: ctx.userId ?? user?.id ?? null,
        crawlerJobId: jobId,
      })
    } catch (err) {
      log.error('[adminGeoCrawlOnLogin] createGeoCrawlRun failed, backfill:', err?.message || err)
      try {
        await backfillGeoCrawlRunFromJob(db, geoRunId, job)
      } catch (e2) {
        log.error('[adminGeoCrawlOnLogin] backfillGeoCrawlRunFromJob failed:', e2?.message || e2)
      }
    }

    const uploadDir = ctx.uploadDir || defaultUploadDir()
    const getOpenAI = ctx.getOpenAI

    setImmediate(() => {
      dispatchCrawlerJob({
        db,
        jobId,
        uploadDir,
        getOpenAI,
      }).catch((error) => {
        console.warn('[adminGeoCrawlOnLogin] dispatch failed:', error?.message || error)
      })
    })

    log.info(`[adminGeoCrawlOnLogin] Scheduled nationwide geo sweep job=${jobId} run=${geoRunId}`)
    return { scheduled: true, job_id: jobId, run_id: geoRunId }
  } catch (error) {
    log.error('[adminGeoCrawlOnLogin] Failed:', error)
    return { scheduled: false, reason: 'error', error: String(error?.message || error) }
  }
}
