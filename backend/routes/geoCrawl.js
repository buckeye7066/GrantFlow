import express from 'express'
import crypto from 'crypto'
import { requireAuthenticatedUser, isAdminUserWithDb, getAuthUserId } from '../utils/accessControl.js'
import { createGeoCrawlRun, getGeoCrawlRunWithBackfill, listGeoCrawlEvents } from '../services/geoCrawlRunStore.js'
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js'
import { isSupersededCrawlerType } from '../../shared/supersededCrawlerTypes.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:geoCrawl')

export default function createGeoCrawlRouter({ uploadDir, getOpenAI } = {}) {
  const router = express.Router()

  async function requireAdmin(req, res) {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return null
    const isAdmin = await isAdminUserWithDb(req.db, req.ctx ?? req.user ?? user).catch(() => false)
    if (!isAdmin) {
      res.status(403).json({ error: 'Admin access required' })
      return null
    }
    return user
  }

  router.post('/start', async (req, res) => {
    try {
      const isAuthorized = await requireAdmin(req, res)
      if (!isAuthorized) return

      // CUTOVER: geo crawl ran as a `comprehensive` crawler_jobs row, now a retired
      // discovery type (no dispatcher handler; short-circuited as superseded).
      // Crawler OS (Robert) owns catalog population, so this endpoint no longer
      // enqueues a dead job — it reports retired so the UI can show an honest state.
      if (isSupersededCrawlerType('comprehensive')) {
        return res.status(200).json({
          ok: false,
          retired: true,
          run_id: null,
          message:
            'Geo Crawl is retired. Crawler OS (Robert) is the single grant-discovery engine; use per-profile discovery or Robert automation.',
        })
      }

      const incoming = req.body && typeof req.body === 'object' ? req.body : {}
      const state = incoming.state ? String(incoming.state).toUpperCase() : null
      const runAllStates = Boolean(incoming.run_all_states ?? incoming.runAllStates ?? false)

      // Normalize zip_list (AdminGeoCrawl uses `zips`).
      const zipList =
        Array.isArray(incoming.zips) && incoming.zips.length > 0
          ? incoming.zips
          : Array.isArray(incoming.zip_list) && incoming.zip_list.length > 0
            ? incoming.zip_list
            : null

      const geoRunId = crypto.randomUUID()

      const parameters = {
        mode: 'geo',
        geo_run_id: geoRunId,
        state: state ?? undefined,
        run_all_states: runAllStates || undefined,
        states: Array.isArray(incoming.states) ? incoming.states : undefined,
        // Country scope for national crawls (default US + CA when omitted).
        countries: Array.isArray(incoming.countries) ? incoming.countries : undefined,
        zip_list: zipList ?? undefined,
        max_zips:
          zipList && zipList.length > 0
            ? zipList.length
            : incoming.max_zips ?? incoming.maxZips ?? incoming.zip_limit ?? incoming.zipLimit ?? undefined,
        // Feature toggles (crawler reads these)
        discover_local_resources: incoming.discover_local_resources ?? incoming.discoverLocalResources ?? true,
        // Default offline_only=false so each ZIP gets Grants.gov + Overpass.
        offline_only: incoming.offline_only ?? incoming.offlineOnly ?? false,
      }

      const jobId = crypto.randomUUID()
      const callerProfileId =
        typeof incoming.profile_id === 'string'
          ? incoming.profile_id
          : (typeof incoming.profileId === 'string' ? incoming.profileId : null)

      await req.db
        .prepare(
          `
            INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
            VALUES (?, 'comprehensive', 'queued', ?, NULL, ?, 'admin')
          `,
        )
        .run(jobId, callerProfileId, JSON.stringify(parameters))

      // Durable run row for monitor (DB-backed, survives refresh)
      const createdByUserId = getAuthUserId(req.ctx ?? req.user ?? isAuthorized) ?? null
      await createGeoCrawlRun(req.db, {
        id: geoRunId,
        state: runAllStates ? null : state,
        createdByUserId,
        crawlerJobId: jobId,
      })

      // Dispatch asynchronously (don't block response).
      // Use .catch() instead of try/catch so async Promise rejections are also captured.
      dispatchCrawlerJob({
        db: req.db,
        jobId,
        uploadDir,
        getOpenAI,
      }).catch((error) => {
        console.warn('[geo-crawl/start] Failed to dispatch job:', error?.message || error)
      })

      const job = await req.db
        .prepare('SELECT id, type, status, created_at, started_at, completed_at, result_count, error FROM crawler_jobs WHERE id = ?')
        .get(jobId)

      res.status(201).json({ ok: true, run_id: geoRunId, crawler_job_id: jobId, job })
    } catch (error) {
      routeLogger.error('[geo-crawl/start] Error:', error)
      res.status(500).json({ error: error?.message || String(error) })
    }
  })

  router.get('/runs/:runId', async (req, res) => {
    try {
      const isAuthorized = await requireAdmin(req, res)
      if (!isAuthorized) return

      const runId = String(req.params.runId || '').trim()
      if (!runId) return res.status(400).json({ error: 'runId is required' })

      const run = await getGeoCrawlRunWithBackfill(req.db, runId)
      // 200 + missing:true (not 404) so browsers do not log "failed to load resource" for a normal
      // stale-id case; the monitor treats this as "gone" and stops polling.
      if (!run) {
        return res.status(200).json({
          ok: true,
          run: null,
          missing: true,
          message: 'Geo crawl run not found (unknown id, expired job, or different database).',
        })
      }

      res.json({ ok: true, run, missing: false })
    } catch (error) {
      routeLogger.error('[geo-crawl/runs/:runId] Error:', error)
      res.status(500).json({ error: error?.message || String(error) })
    }
  })

  router.get('/runs/:runId/events', async (req, res) => {
    try {
      const isAuthorized = await requireAdmin(req, res)
      if (!isAuthorized) return

      const runId = String(req.params.runId || '').trim()
      if (!runId) return res.status(400).json({ error: 'runId is required' })

      const afterId = Number(req.query?.after_id ?? req.query?.afterId ?? 0) || 0
      const limit = Math.min(Number(req.query?.limit ?? 200) || 200, 1000)

      // Same backfill as GET /runs so parallel monitor requests still see a consistent run row.
      const run = await getGeoCrawlRunWithBackfill(req.db, runId)

      const events = await listGeoCrawlEvents(req.db, runId, { afterId, limit })
      const lastEventId = events.length ? events[events.length - 1].id : Number(afterId || 0)

      res.json({
        ok: true,
        events,
        last_event_id: lastEventId,
        missing: !run,
      })
    } catch (error) {
      routeLogger.error('[geo-crawl/events] Error:', error)
      res.status(500).json({ error: error?.message || String(error) })
    }
  })

  return router
}

