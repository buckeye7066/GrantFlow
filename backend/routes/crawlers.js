import express from 'express'
import fs from 'fs'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js'
import { createCrawlerJob, validateJobParameters } from '../services/crawlerJobCreation.js'
import { buildProfileContext } from '../services/profileHelpers.js'
import { validatePagination } from '../utils/validation.js'
import { createOpenAIClient } from '../utils/openaiClient.js'
import { formatError } from '../middleware/errorHandler.js'
import { DEFAULT_PAGE_LIMIT, CRAWLER_JOB_TYPES } from '../config/constants.js'
import { requireTierCapability, TIER_CAPABILITIES } from '../utils/tierGating.js'
import { ensureProfileAccess, getAccessibleProfileIds, isAdminUser } from '../utils/accessControl.js'

const router = express.Router()

const ALLOWED_TYPES = new Set(CRAWLER_JOB_TYPES)
const ALLOWED_STATUS = new Set(['queued', 'running', 'completed', 'failed', 'cancelled'])
const MAX_LINEAGE_DEPTH = 15

// Some crawler types are explicitly profile-scoped and cannot run without a profile context.
// Enforce this at request time so we don't create guaranteed-to-fail jobs that pollute diagnostics.
const TYPES_REQUIRING_PROFILE = new Set([
  'local',
  'scholarship',
  'item_search',
  'avatar_lookup',
  'document_ingest',
  'pipeline_automation',
  'profile_enrichment',
])

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const uploadDir = join(__dirname, '..', 'uploads')

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

function getOpenAI() {
  // Use the hardened client factory so common env-var copy/paste issues are normalized
  // and placeholder/masked keys fail fast with safe diagnostics.
  const { openai } = createOpenAIClient({ allowMissing: false })
  return openai
}

function ensureAuth(req, res) {
  const auth = req.user ?? { role: 'guest' }
  if (auth.role === 'guest') {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  return auth
}

function mapJob(row) {
  if (!row) return null
  const job = { ...row }
  try {
    job.parameters = row.parameters ? JSON.parse(row.parameters) : {}
  } catch {
    job.parameters = {}
  }
  try {
    job.result_meta = row.result_meta ? JSON.parse(row.result_meta) : null
  } catch {
    job.result_meta = null
  }
  if (job.parameters && typeof job.parameters === 'object') {
    const retrySource = job.parameters.retried_from_job_id ?? job.parameters.retriedFromJobId
    job.retried_from_job_id =
      typeof retrySource === 'string' || typeof retrySource === 'number'
        ? retrySource
        : null
  } else {
    job.retried_from_job_id = null
  }
  job.retry_count = typeof job.retry_count === 'number' ? job.retry_count : 0
  job.last_retry_at = job.last_retry_at ?? null
  return job
}

function buildJobFilter(auth, { profileId, organizationId, type, status, accessibleProfileIds } = {}) {
  const clauses = []
  const params = []

  const admin = auth.role === 'admin' || isAdminUser(auth)

  if (!admin) {
    const accessible = accessibleProfileIds instanceof Set ? Array.from(accessibleProfileIds) : []

    if (profileId) {
      if (!accessibleProfileIds || !accessibleProfileIds.has(profileId)) {
        return { clause: 'WHERE 1=0', params: [] }
      }
      clauses.push('profile_id = ?')
      params.push(profileId)
    } else {
      if (accessible.length === 0) {
        return { clause: 'WHERE 1=0', params: [] }
      }
      const placeholders = accessible.map(() => '?').join(', ')
      clauses.push(`profile_id IN (${placeholders})`)
      params.push(...accessible)
    }
  } else {
    if (profileId) {
      clauses.push('profile_id = ?')
      params.push(profileId)
    }
    if (organizationId) {
      clauses.push('organization_id = ?')
      params.push(organizationId)
    }
  }

  if (type && ALLOWED_TYPES.has(type)) {
    clauses.push('type = ?')
    params.push(type)
  }

  if (status && ALLOWED_STATUS.has(status)) {
    clauses.push('status = ?')
    params.push(status)
  }

  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  }
}

async function fetchJobById(db, id) {
  if (!id) return null
  return await db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(id)
}

async function buildJobLineage(db, job) {
  if (!job?.id) return null

  const ancestors = []
  const visited = new Set([job.id])
  let currentParentId = job.retried_from_job_id

  for (let i = 0; currentParentId && i < MAX_LINEAGE_DEPTH; i += 1) {
    if (visited.has(currentParentId)) break
    const parentRow = await fetchJobById(db, currentParentId)
    if (!parentRow) break
    const parentJob = mapJob(parentRow)
    ancestors.push(parentJob)
    visited.add(parentJob.id)
    currentParentId = parentJob.retried_from_job_id
  }

  ancestors.reverse()

  const descendants = []
  const queue = [job.id]
  let descendantStmt = null

  try {
    const descendantSql =
      db?.dialect === 'postgres'
        ? `
            SELECT *
            FROM crawler_jobs
            WHERE (parameters::jsonb ->> 'retried_from_job_id') = ?
            ORDER BY created_at ASC
          `
        : `
            SELECT *
            FROM crawler_jobs
            WHERE JSON_EXTRACT(parameters, '$.retried_from_job_id') = ?
            ORDER BY created_at ASC
          `
    descendantStmt = db.prepare(descendantSql)
  } catch (error) {
    console.warn('[crawlers] JSON_EXTRACT unavailable; skipping retry descendant lookup', error)
  }

  if (descendantStmt) {
    while (queue.length > 0 && descendants.length < MAX_LINEAGE_DEPTH) {
      const currentId = queue.shift()
      let rows = []
      try {
        rows = await descendantStmt.all(currentId)
      } catch (error) {
        console.warn('[crawlers] Failed to query retry descendants', error)
        break
      }

      rows.forEach((row) => {
        if (!row?.id || visited.has(row.id)) return
        const mapped = mapJob(row)
        descendants.push(mapped)
        visited.add(mapped.id)
        if (descendants.length < MAX_LINEAGE_DEPTH) {
          queue.push(mapped.id)
        }
      })
    }
  }

  descendants.sort((a, b) => {
    const aTime = a?.created_at ? new Date(a.created_at).getTime() : Number.POSITIVE_INFINITY
    const bTime = b?.created_at ? new Date(b.created_at).getTime() : Number.POSITIVE_INFINITY
    return aTime - bTime
  })

  return {
    attempts: ancestors.length + 1 + descendants.length,
    ancestors,
    descendants,
  }
}

function extendClause(baseClause, addition) {
  if (!addition) return baseClause
  if (!baseClause) return `WHERE ${addition}`
  return `${baseClause} AND ${addition}`
}

function formatCount(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null
  return value
}

function formatDisplayCount(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null
  return value.toLocaleString('en-US')
}

function shorten(text, limit = 160) {
  if (!text || typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1)}…`
}

function calculateDurationSeconds(job) {
  if (!job?.started_at || !job?.completed_at) return null
  const start = new Date(job.started_at)
  const end = new Date(job.completed_at)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null
  }
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000))
}

function buildRecentDays(dayCount = 7) {
  const days = []
  const today = new Date()
  for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
    const current = new Date(today)
    current.setHours(0, 0, 0, 0)
    current.setDate(current.getDate() - offset)
    days.push(current.toISOString().slice(0, 10))
  }
  return days
}

function normalizeErrorMessage(message) {
  if (message == null) return null
  const text = typeof message === 'string' ? message : String(message)
  const trimmed = text.trim()
  if (!trimmed) return null
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed
}

function formatFailureReasons(map) {
  if (!map || map.size === 0) return []
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([message, count]) => ({ message, count }))
}

function deriveJobSummary(type, job) {
  const meta = job?.result_meta ?? {}
  switch (type) {
    case 'local': {
      const insertedValue = formatCount(meta.inserted ?? job.result_count)
      const evaluatedValue = formatCount(meta.evaluated)
      const radiusValue = formatCount(meta.radius)
      const inserted = formatDisplayCount(insertedValue)
      const evaluated = formatDisplayCount(evaluatedValue)
      const radius = formatDisplayCount(radiusValue)
      const parts = []
      if (inserted !== null) parts.push(`Saved ${inserted} local matches`)
      if (evaluated !== null) parts.push(`evaluated ${evaluated}`)
      if (radius !== null) parts.push(`within ${radius} miles`)
      return parts.length > 0 ? parts.join(' • ') : null
    }
    case 'scholarship': {
      const inserted = formatDisplayCount(formatCount(meta.inserted ?? job.result_count))
      const evaluated = formatDisplayCount(formatCount(meta.evaluated))
      if (inserted === null && evaluated === null) return null
      return [
        inserted !== null ? `Saved ${inserted} scholarships` : null,
        evaluated !== null ? `evaluated ${evaluated}` : null,
      ]
        .filter(Boolean)
        .join(' • ')
    }
    case 'comprehensive': {
      const inserted = formatDisplayCount(formatCount(meta.inserted ?? job.result_count))
      const zips = formatDisplayCount(formatCount(meta.zipsProcessed))
      const evaluated = formatDisplayCount(formatCount(meta.evaluated))
      const parts = []
      if (inserted !== null) parts.push(`Saved ${inserted} nationwide opportunities`)
      if (zips !== null) parts.push(`across ${zips} ZIPs`)
      if (evaluated !== null) parts.push(`evaluated ${evaluated}`)
      return parts.length > 0 ? parts.join(' • ') : null
    }
    case 'item_search': {
      const inserted = formatDisplayCount(formatCount(meta.inserted ?? job.result_count))
      const evaluated = formatDisplayCount(formatCount(meta.evaluated))
      const item =
        typeof meta.item === 'string'
          ? meta.item
          : job.parameters?.item
          ? String(job.parameters.item)
          : null
      const parts = []
      if (inserted !== null) parts.push(`Saved ${inserted} item matches`)
      if (evaluated !== null) parts.push(`evaluated ${evaluated}`)
      if (item) parts.push(`for “${item}”`)
      return parts.length > 0 ? parts.join(' • ') : null
    }
    case 'profile_enrichment': {
      const sections = Array.isArray(meta.sections) ? meta.sections.length : null
      if (sections === null) return null
      const sectionsDisplay = sections.toLocaleString('en-US')
      return `Updated ${sectionsDisplay} profile section${sections === 1 ? '' : 's'}`
    }
    case 'document_ingest': {
      if (typeof meta.summary === 'string' && meta.summary.trim()) {
        return shorten(meta.summary, 200)
      }
      const total = formatCount(
        meta.total_sections_updated ??
          (Array.isArray(meta.sections_updated) ? meta.sections_updated.length : null),
      )
      if (total !== null) {
        const totalDisplay = total.toLocaleString('en-US')
        return `Extracted data into ${totalDisplay} section${total === 1 ? '' : 's'}`
      }
      return null
    }
    case 'pipeline_automation': {
      const advancedValue = formatCount(meta.advanced)
      const handoffsValue = formatCount(meta.handoffs)
      const advanced = formatDisplayCount(advancedValue)
      const handoffs = formatDisplayCount(handoffsValue)
      const parts = []
      if (advanced !== null) {
        const advancedNumber = advancedValue ?? 0
        parts.push(
          `Advanced ${advanced} grant${advancedNumber === 1 ? '' : 's'}`,
        )
      }
      if (handoffs !== null) {
        const handoffsNumber = handoffsValue ?? 0
        parts.push(`${handoffs} handoff${handoffsNumber === 1 ? '' : 's'}`)
      }
      return parts.length > 0 ? parts.join(' • ') : null
    }
    case 'avatar_lookup':
      return 'Generated AI avatar'
    default: {
      const inserted = formatDisplayCount(formatCount(job?.result_count))
      if (inserted !== null) {
        const rawCount = formatCount(job?.result_count) ?? 0
        return `Processed ${inserted} record${rawCount === 1 ? '' : 's'}`
      }
      return null
    }
  }
}

router.get('/jobs', async (req, res) => {
  const auth = ensureAuth(req, res)
  if (!auth) return

  try {
    const limit = Number.parseInt(req.query.limit ?? 100, 10)
    const offset = Number.parseInt(req.query.offset ?? 0, 10)
    const typeFilter = typeof req.query.type === 'string' ? req.query.type.toLowerCase() : null
    const statusFilter = typeof req.query.status === 'string' ? req.query.status.toLowerCase() : null
    const profileFilter = typeof req.query.profile_id === 'string' ? req.query.profile_id : null

    const organizationFilter =
      auth.role === 'admin' && typeof req.query.organization_id === 'string'
        ? req.query.organization_id
        : null

    const admin = auth.role === 'admin' || isAdminUser(auth)
    const accessibleProfileIds = admin ? null : await getAccessibleProfileIds(req.db, auth)

    const { clause, params } = buildJobFilter(auth, {
      profileId: profileFilter,
      organizationId: organizationFilter,
      type: typeFilter,
      status: statusFilter,
      accessibleProfileIds,
    })

    const limitValue = Number.isFinite(limit) ? limit : 100
    const offsetValue = Number.isFinite(offset) ? offset : 0

    const rows = await req.db
      .prepare(
        `
          SELECT *
          FROM crawler_jobs
          ${clause}
          ORDER BY created_at DESC
          LIMIT COALESCE(?, 100)
          OFFSET COALESCE(?, 0)
        `,
      )
      .all(...params, limitValue, offsetValue)
    res.json(rows.map(mapJob))
  } catch (error) {
    console.error('Error listing crawler jobs:', error)
    res.status(500).json(formatError(error))
  }
})

router.get('/jobs/metrics', async (req, res) => {
  const auth = ensureAuth(req, res)
  if (!auth) return

  try {
    const profileFilter = typeof req.query.profile_id === 'string' ? req.query.profile_id : null
    const organizationFilter =
      auth.role === 'admin' && typeof req.query.organization_id === 'string'
        ? req.query.organization_id
        : null

    const admin = auth.role === 'admin' || isAdminUser(auth)
    const accessibleProfileIds = admin ? null : await getAccessibleProfileIds(req.db, auth)

    const { clause, params } = buildJobFilter(auth, {
      profileId: profileFilter,
      organizationId: organizationFilter,
      accessibleProfileIds,
    })

    const statusRows = await req.db
      .prepare(
        `
          SELECT type, status, COUNT(*) AS count
          FROM crawler_jobs
          ${clause}
          GROUP BY type, status
        `,
      )
      .all(...params)

    const latestActivity = await req.db
      .prepare(
        `
          SELECT created_at
          FROM crawler_jobs
          ${clause}
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(...params)

    const completedClause = extendClause(clause, "status = 'completed'")
    const completedRows = await req.db
      .prepare(
        `
          SELECT *
          FROM crawler_jobs
          ${completedClause}
          ORDER BY completed_at DESC
          LIMIT 200
        `,
      )
      .all(...params)

    const runningClause = extendClause(clause, "status IN ('queued', 'running')")
    const runningRows = await req.db
      .prepare(
        `
          SELECT *
          FROM crawler_jobs
          ${runningClause}
          ORDER BY created_at DESC
          LIMIT 25
        `,
      )
      .all(...params)

    const failedClause = extendClause(clause, "status = 'failed'")
    const failedRows = await req.db
      .prepare(
        `
          SELECT *
          FROM crawler_jobs
          ${failedClause}
          ORDER BY completed_at DESC
          LIMIT 25
        `,
      )
      .all(...params)

    const retryClause = extendClause(clause, 'COALESCE(retry_count, 0) > 0')
    const recentRetryPredicate =
      req.db?.dialect === 'postgres'
        ? `last_retry_at >= (NOW() - INTERVAL '6 days')`
        : `DATETIME(last_retry_at) >= DATETIME('now', '-6 day')`

    const retryRows = await req.db
      .prepare(
        `
          SELECT
            type,
            SUM(COALESCE(retry_count, 0)) AS total_retries,
            SUM(CASE WHEN COALESCE(retry_count, 0) > 0 THEN 1 ELSE 0 END) AS jobs_with_retries,
            SUM(
              CASE
                WHEN last_retry_at IS NOT NULL
                  AND ${recentRetryPredicate}
                THEN 1
                ELSE 0
              END
            ) AS recent_retry_jobs,
            MAX(last_retry_at) AS last_retry_at
          FROM crawler_jobs
          ${retryClause}
          GROUP BY type
        `,
      )
      .all(...params)

    const recentActivityPredicate =
      req.db?.dialect === 'postgres'
        ? `created_at >= (NOW() - INTERVAL '6 days')`
        : `DATE(created_at) >= DATE('now', '-6 day')`

    const activityClause = extendClause(clause, recentActivityPredicate)
    const activityRows = await req.db
      .prepare(
        `
          SELECT
            type,
            DATE(created_at) AS day,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
          FROM crawler_jobs
          ${activityClause}
          GROUP BY type, day
        `,
      )
      .all(...params)

    const typeOrder = Array.from(ALLOWED_TYPES)
    const metricsByType = new Map(
      typeOrder.map((type) => [
        type,
        {
          type,
          total: 0,
          counts: {
            queued: 0,
            running: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
          },
          last_job: null,
          last_summary: null,
          last_completed_at: null,
          last_result_count: null,
        },
      ]),
    )

    const durationTotals = new Map(
      typeOrder.map((type) => [
        type,
        {
          total: 0,
          count: 0,
        },
      ]),
    )
    let overallDurationTotal = 0
    let overallDurationCount = 0

    const retryStatsByType = new Map(
      typeOrder.map((type) => [
        type,
        {
          total_retries: 0,
          jobs_with_retries: 0,
          recent_retry_jobs: 0,
          last_retry_at: null,
        },
      ]),
    )
    const overallRetryStats = {
      total_retries: 0,
      jobs_with_retries: 0,
      recent_retry_jobs: 0,
      last_retry_at: null,
    }

    const overall = {
      total: 0,
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total_retries: 0,
      jobs_with_retries: 0,
      recent_retry_jobs: 0,
      last_retry_at: null,
    }

    const recentDays = buildRecentDays(7)
    const activityByType = new Map()
    const overallActivity = new Map(
      recentDays.map((day) => [day, { completed: 0, failed: 0 }]),
    )
    const failureReasonsByType = new Map(
      typeOrder.map((type) => [type, new Map()]),
    )
    const overallFailureReasons = new Map()

    statusRows.forEach((row) => {
      if (!row || !row.type || !row.status) return
      if (!metricsByType.has(row.type)) {
        metricsByType.set(row.type, {
          type: row.type,
          total: 0,
          counts: {
            queued: 0,
            running: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
          },
          last_job: null,
          last_summary: null,
          last_completed_at: null,
          last_result_count: null,
        })
      }

      const metric = metricsByType.get(row.type)
      const count = Number(row.count) || 0
      if (metric.counts[row.status] !== undefined) {
        metric.counts[row.status] += count
      }
      metric.total += count
      overall.total += count
      if (overall[row.status] !== undefined) {
        overall[row.status] += count
      }
    })

    retryRows.forEach((row) => {
      if (!row?.type) return
      if (!retryStatsByType.has(row.type)) {
        retryStatsByType.set(row.type, {
          total_retries: 0,
          jobs_with_retries: 0,
          recent_retry_jobs: 0,
          last_retry_at: null,
        })
      }

      const stats = retryStatsByType.get(row.type)
      const totalRetries = Number(row.total_retries) || 0
      const jobsWithRetries = Number(row.jobs_with_retries) || 0
      const recentRetryJobs = Number(row.recent_retry_jobs) || 0
      const lastRetryAt = row.last_retry_at ?? null

      stats.total_retries += totalRetries
      stats.jobs_with_retries += jobsWithRetries
      stats.recent_retry_jobs += recentRetryJobs

      if (lastRetryAt) {
        const lastRetryDate = new Date(lastRetryAt)
        if (
          Number.isFinite(lastRetryDate.getTime()) &&
          (!stats.last_retry_at || lastRetryDate > new Date(stats.last_retry_at))
        ) {
          stats.last_retry_at = lastRetryDate.toISOString()
        }
        if (
          !overallRetryStats.last_retry_at ||
          lastRetryDate > new Date(overallRetryStats.last_retry_at)
        ) {
          overallRetryStats.last_retry_at = lastRetryDate.toISOString()
        }
      }

      overallRetryStats.total_retries += totalRetries
      overallRetryStats.jobs_with_retries += jobsWithRetries
      overallRetryStats.recent_retry_jobs += recentRetryJobs
    })

    const seenTypes = new Set()
    completedRows.forEach((row) => {
      if (!row?.type || seenTypes.has(row.type)) return
      const parsedJob = mapJob(row)
      const summary = deriveJobSummary(parsedJob.type, parsedJob)
      const durationSeconds = calculateDurationSeconds(parsedJob)

      if (!metricsByType.has(parsedJob.type)) {
        metricsByType.set(parsedJob.type, {
          type: parsedJob.type,
          total: 0,
          counts: {
            queued: 0,
            running: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
          },
          last_job: null,
          last_summary: null,
          last_completed_at: null,
          last_result_count: null,
        })
      }

      const metric = metricsByType.get(parsedJob.type)
      metric.last_job = {
        id: parsedJob.id,
        status: parsedJob.status,
        profile_id: parsedJob.profile_id,
        organization_id: parsedJob.organization_id,
        created_at: parsedJob.created_at,
        started_at: parsedJob.started_at,
        completed_at: parsedJob.completed_at,
        result_count: parsedJob.result_count ?? null,
        summary,
        duration_seconds: durationSeconds,
      }
      metric.last_summary = summary
      metric.last_completed_at = parsedJob.completed_at ?? null
      metric.last_result_count =
        typeof parsedJob.result_count === 'number' ? parsedJob.result_count : null

      if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
        const totals = durationTotals.get(parsedJob.type) ?? { total: 0, count: 0 }
        totals.total += durationSeconds
        totals.count += 1
        durationTotals.set(parsedJob.type, totals)
        overallDurationTotal += durationSeconds
        overallDurationCount += 1
      }

      seenTypes.add(parsedJob.type)
    })

    activityRows.forEach((row) => {
      if (!row?.type || !row?.day) return
      if (!metricsByType.has(row.type)) {
        metricsByType.set(row.type, {
          type: row.type,
          total: 0,
          counts: {
            queued: 0,
            running: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
          },
          last_job: null,
          last_summary: null,
          last_completed_at: null,
          last_result_count: null,
        })
      }

      if (!activityByType.has(row.type)) {
        activityByType.set(
          row.type,
          new Map(recentDays.map((day) => [day, { completed: 0, failed: 0 }])),
        )
      }

      const dayMap = activityByType.get(row.type)
      if (dayMap.has(row.day)) {
        const entry = dayMap.get(row.day)
        entry.completed += Number(row.completed) || 0
        entry.failed += Number(row.failed) || 0
      }

      if (overallActivity.has(row.day)) {
        const entry = overallActivity.get(row.day)
        entry.completed += Number(row.completed) || 0
        entry.failed += Number(row.failed) || 0
      }
    })

    metricsByType.forEach((entry, type) => {
      const dayMap = activityByType.get(type)
      entry.recent_activity = recentDays.map((day) => {
        const counts = dayMap?.get(day) ?? { completed: 0, failed: 0 }
        return {
          date: day,
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
        }
      })
    })

    const metrics = Array.from(metricsByType.values()).map((entry) => ({
      ...entry,
      counts: {
        queued: entry.counts.queued,
        running: entry.counts.running,
        completed: entry.counts.completed,
        failed: entry.counts.failed,
        cancelled: entry.counts.cancelled,
      },
      retry_stats: (() => {
        const stats = retryStatsByType.get(entry.type) ?? {
          total_retries: 0,
          jobs_with_retries: 0,
          recent_retry_jobs: 0,
          last_retry_at: null,
        }
        return {
          total_retries: stats.total_retries,
          jobs_with_retries: stats.jobs_with_retries,
          recent_retry_jobs: stats.recent_retry_jobs,
          last_retry_at: stats.last_retry_at,
        }
      })(),
      average_duration_seconds: (() => {
        const totals = durationTotals.get(entry.type) ?? { total: 0, count: 0 }
        return totals.count > 0 ? totals.total / totals.count : null
      })(),
      failure_reasons: formatFailureReasons(failureReasonsByType.get(entry.type)),
    }))

    const runningJobs = runningRows.map((row) => {
      const job = mapJob(row)
      return {
        id: job.id,
        type: job.type,
        status: job.status,
        profile_id: job.profile_id,
        organization_id: job.organization_id,
        parameters: job.parameters ?? {},
        created_at: job.created_at ?? null,
        started_at: job.started_at ?? null,
        requested_by: job.requested_by ?? null,
        retried_from_job_id: job.retried_from_job_id ?? null,
        retry_count: job.retry_count ?? null,
        last_retry_at: job.last_retry_at ?? null,
      }
    })

    const recentFailures = failedRows.map((row) => {
      const job = mapJob(row)

      const typeKey = job.type ?? 'unknown'
      if (!failureReasonsByType.has(typeKey)) {
        failureReasonsByType.set(typeKey, new Map())
      }

      const reasonSet = new Set()
      const errorMessage = normalizeErrorMessage(job.error)
      if (errorMessage) reasonSet.add(errorMessage)

      const metaError = normalizeErrorMessage(job.result_meta?.error)
      if (metaError) reasonSet.add(metaError)

      if (Array.isArray(job.result_meta?.errors)) {
        job.result_meta.errors.forEach((entry) => {
          const normalized = normalizeErrorMessage(entry)
          if (normalized) reasonSet.add(normalized)
        })
      }

      reasonSet.forEach((message) => {
        const typeMap = failureReasonsByType.get(typeKey) ?? new Map()
        typeMap.set(message, (typeMap.get(message) ?? 0) + 1)
        failureReasonsByType.set(typeKey, typeMap)
        overallFailureReasons.set(message, (overallFailureReasons.get(message) ?? 0) + 1)
      })

      return {
        id: job.id,
        type: job.type,
        status: job.status,
        profile_id: job.profile_id,
        organization_id: job.organization_id,
        parameters: job.parameters ?? {},
        created_at: job.created_at ?? null,
        completed_at: job.completed_at ?? null,
        error: job.error ?? null,
        requested_by: job.requested_by ?? null,
        retried_from_job_id: job.retried_from_job_id ?? null,
        retry_count: job.retry_count ?? null,
        last_retry_at: job.last_retry_at ?? null,
      }
    })

    res.json({
      generated_at: new Date().toISOString(),
      overall: {
        ...overall,
        total_retries: overallRetryStats.total_retries,
        jobs_with_retries: overallRetryStats.jobs_with_retries,
        recent_retry_jobs: overallRetryStats.recent_retry_jobs,
        last_retry_at: overallRetryStats.last_retry_at,
        failure_reasons: formatFailureReasons(overallFailureReasons),
        last_activity: latestActivity?.created_at ?? null,
        recent_activity: recentDays.map((day) => {
          const counts = overallActivity.get(day) ?? { completed: 0, failed: 0 }
          return {
            date: day,
            completed: counts.completed ?? 0,
            failed: counts.failed ?? 0,
          }
        }),
        average_duration_seconds:
          overallDurationCount > 0 ? overallDurationTotal / overallDurationCount : null,
      },
      types: metrics,
      running_jobs: runningJobs,
      recent_failures: recentFailures,
    })
  } catch (error) {
    console.error('Error building crawler job metrics:', error)
    res.status(500).json(formatError(error))
  }
})

router.get('/jobs/:id', async (req, res) => {
  const auth = ensureAuth(req, res)
  if (!auth) return

  try {
    const job = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(req.params.id)
    if (!job) {
      return res.status(404).json({ error: 'Job not found' })
    }

    const admin = auth.role === 'admin' || isAdminUser(auth)
    if (!admin) {
      if (!job.profile_id) {
        return res.status(403).json({ error: 'Not authorized to access this job' })
      }
      if (!(await ensureProfileAccess(req, res, String(job.profile_id)))) return
    }

    const mappedJob = mapJob(job)
    const lineage = await buildJobLineage(req.db, mappedJob)

    res.json({
      ...mappedJob,
      lineage,
    })
  } catch (error) {
    console.error('Error fetching crawler job:', error)
    res.status(500).json(formatError(error))
  }
})

router.post('/jobs', async (req, res) => {
  const auth = ensureAuth(req, res)
  if (!auth) return

  try {
    const { type, profile_id: bodyProfileId, parameters = {} } = req.body ?? {}

    if (!type || !ALLOWED_TYPES.has(type)) {
      return res.status(400).json({ error: 'Invalid crawler type' })
    }

    let targetProfileId = null
    const admin = auth.role === 'admin' || isAdminUser(auth)
    if (admin) {
      targetProfileId = bodyProfileId ?? null
    } else if (auth.role === 'user') {
      targetProfileId = bodyProfileId ?? auth.profileId ?? null
      if (targetProfileId) {
        if (!(await ensureProfileAccess(req, res, String(targetProfileId)))) return
      }
    }

    if (TYPES_REQUIRING_PROFILE.has(type) && !targetProfileId) {
      return res.status(400).json({
        error: `Crawler type "${type}" requires a profile_id. Select a profile and try again.`,
      })
    }

    let organizationId = null
    if (targetProfileId) {
      const profileRow = await req.db
        .prepare('SELECT id, organization_id FROM profiles WHERE id = ?')
        .get(targetProfileId)
      if (!profileRow) {
        return res.status(400).json({ error: 'Profile not found for crawler job' })
      }
      organizationId = profileRow.organization_id ?? null
    }

    // Tier gating (enforced server-side; UI gating is not sufficient).
    const tierRequirementByType = {
      pipeline_automation: TIER_CAPABILITIES.PIPELINE_AUTOMATION,
      item_search: TIER_CAPABILITIES.ITEM_FUNDING,
      document_ingest: TIER_CAPABILITIES.DOCUMENT_AI,
      profile_enrichment: TIER_CAPABILITIES.DOCUMENT_AI,
      avatar_lookup: TIER_CAPABILITIES.DOCUMENT_AI,
    }
    const requiredCapability = tierRequirementByType[type] ?? null
    if (requiredCapability && targetProfileId) {
      if (!(await requireTierCapability(req, res, targetProfileId, requiredCapability))) return
    }

    // Validate and normalize parameters
    const validatedParameters = validateJobParameters(type, parameters)
    
    // Create job with automatic idempotency, validation, and snapshot
    const result = await createCrawlerJob(req.db, {
      type,
      profileId: targetProfileId,
      organizationId,
      parameters: validatedParameters,
      requestedBy: admin ? 'admin' : (auth.userId ?? auth.email ?? targetProfileId ?? 'user'),
      status: 'queued',
      buildSnapshot: true,
    })
    
    // If existing job found, return it
    if (result.existing) {
      console.log('[crawlers] Duplicate job detected, returning existing job:', result.jobId)
      const existingJob = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(result.jobId)
      return res.status(200).json(mapJob(existingJob))
    }
    
    // Dispatch the newly created job
    const job = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(result.jobId)

    dispatchCrawlerJob({
      db: req.db,
      jobId: job.id,
      uploadDir,
      getOpenAI,
    })

    res.status(201).json(mapJob(job))
  } catch (error) {
    console.error('Error creating crawler job:', error)
    const status = Number(error?.statusCode || error?.status || 500)
    res.status(status).json(formatError(error))
  }
})

router.post('/jobs/:id/retry', async (req, res) => {
  const auth = ensureAuth(req, res)
  if (!auth) return

  try {
    const job = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(req.params.id)
    if (!job) {
      return res.status(404).json({ error: 'Job not found' })
    }

    const admin = auth.role === 'admin' || isAdminUser(auth)
    if (!admin) {
      if (!job.profile_id) return res.status(403).json({ error: 'Not authorized to retry this job' })
      if (!(await ensureProfileAccess(req, res, String(job.profile_id)))) return
    }

    if (job.status !== 'failed' && job.status !== 'completed' && job.status !== 'cancelled') {
      return res.status(400).json({ error: 'Only completed, failed, or cancelled jobs can be retried' })
    }

    // Tier gating applies to retries too (prevents bypass via retry endpoints).
    const tierRequirementByType = {
      pipeline_automation: TIER_CAPABILITIES.PIPELINE_AUTOMATION,
      item_search: TIER_CAPABILITIES.ITEM_FUNDING,
      document_ingest: TIER_CAPABILITIES.DOCUMENT_AI,
      profile_enrichment: TIER_CAPABILITIES.DOCUMENT_AI,
      avatar_lookup: TIER_CAPABILITIES.DOCUMENT_AI,
    }
    const requiredCapability = tierRequirementByType[job.type] ?? null
    if (requiredCapability && job.profile_id) {
      if (!(await requireTierCapability(req, res, job.profile_id, requiredCapability))) return
    }

    let originalParameters = {}
    try {
      originalParameters = job.parameters ? JSON.parse(job.parameters) : {}
    } catch {
      originalParameters = {}
    }

    const parameters = {
      ...(originalParameters && typeof originalParameters === 'object' ? originalParameters : {}),
      retried_from_job_id: job.id,
    }

    const requestedBy =
      admin
        ? 'admin'
        : job.profile_id
        ? job.profile_id
        : auth.userId ?? auth.email ?? 'system'

    // Build fresh profile context snapshot for retry
    let profileContextSnapshot = null
    if (job.profile_id) {
      try {
        const context = await buildProfileContext(req.db, job.profile_id)
        profileContextSnapshot = JSON.stringify(context)
      } catch (error) {
        console.warn('[crawlers] Failed to build profile context snapshot for retry:', error?.message)
        // Try to reuse old snapshot if available
        profileContextSnapshot = job.profile_context_snapshot || null
      }
    }

    // Generate new idempotency key for retry (different from original)
    const idempotencyKey = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          type: job.type,
          profile_id: job.profile_id,
          parameters,
          retry_at: Date.now(),
        })
      )
      .digest('hex')
      .substring(0, 32)

    const newJobId = crypto.randomUUID()
    await req.db
      .prepare(
        `
          INSERT INTO crawler_jobs (
            id,
            type,
            status,
            profile_id,
            organization_id,
            parameters,
            profile_context_snapshot,
            idempotency_key,
            requested_by
          ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        newJobId,
        job.type,
        job.profile_id ?? null,
        job.organization_id ?? null,
        JSON.stringify(parameters),
        profileContextSnapshot,
        idempotencyKey,
        requestedBy,
      )

    const newJob = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(newJobId)

    try {
      await req.db
        .prepare(
          `
            UPDATE crawler_jobs
            SET retry_count = COALESCE(retry_count, 0) + 1,
                last_retry_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `,
        )
        .run(job.id)
    } catch (error) {
      console.warn('[crawlers] Failed to update retry metadata', error)
    }

    dispatchCrawlerJob({
      db: req.db,
      jobId: newJob.id,
      uploadDir,
      getOpenAI,
    })

    res.status(201).json(mapJob(newJob))
  } catch (error) {
    console.error('Error retrying crawler job:', error)
    res.status(500).json(formatError(error))
  }
})

router.post('/jobs/:id/cancel', async (req, res) => {
  const auth = ensureAuth(req, res)
  if (!auth) return

  try {
    const job = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(req.params.id)
    if (!job) {
      return res.status(404).json({ error: 'Job not found' })
    }

    const admin = auth.role === 'admin' || isAdminUser(auth)
    if (!admin) {
      if (!job.profile_id) return res.status(403).json({ error: 'Not authorized to cancel this job' })
      if (!(await ensureProfileAccess(req, res, String(job.profile_id)))) return
    }

    if (job.status !== 'queued') {
      return res.status(400).json({ error: 'Only queued jobs can be cancelled' })
    }

    await req.db
      .prepare(
        `
          UPDATE crawler_jobs
          SET status = 'cancelled',
              completed_at = CURRENT_TIMESTAMP,
              error = COALESCE(?, error)
          WHERE id = ?
        `,
      )
      .run(
        req.body?.reason ?? 'Cancelled by user',
        job.id,
      )

    const updated = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(job.id)
    res.json(mapJob(updated))
  } catch (error) {
    console.error('Error cancelling crawler job:', error)
    res.status(500).json(formatError(error))
  }
})

router.patch('/jobs/:id', async (req, res) => {
  const auth = ensureAuth(req, res)
  if (!auth) return

  if (auth.role !== 'admin') {
    return res.status(403).json({ error: 'Only admin can update job status' })
  }

  try {
    const { status, started_at, completed_at, result_count, error } = req.body ?? {}
    const job = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(req.params.id)
    if (!job) {
      return res.status(404).json({ error: 'Job not found' })
    }

    const updates = []
    const values = []

    if (status) {
      if (!ALLOWED_STATUS.has(status)) {
        return res.status(400).json({ error: 'Invalid status' })
      }
      updates.push('status = ?')
      values.push(status)
    }

    if (started_at !== undefined) {
      updates.push('started_at = ?')
      values.push(started_at || null)
    }

    if (completed_at !== undefined) {
      updates.push('completed_at = ?')
      values.push(completed_at || null)
    }

    if (result_count !== undefined) {
      updates.push('result_count = ?')
      values.push(Number.isFinite(result_count) ? result_count : 0)
    }

    if (error !== undefined) {
      updates.push('error = ?')
      values.push(error || null)
    }

    if (updates.length === 0) {
      return res.json(mapJob(job))
    }

    const update = req.db.prepare(`
      UPDATE crawler_jobs
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)

    await update.run(...values, req.params.id)

    const updated = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(req.params.id)
    res.json(mapJob(updated))
  } catch (error) {
    console.error('Error updating crawler job:', error)
    res.status(500).json(formatError(error))
  }
})

// Get auto-discovery status for a profile
router.get('/auto-discovery-status/:profileId', async (req, res) => {
  const auth = ensureAuth(req, res)
  if (!auth) return

  try {
    const { profileId } = req.params
    
    if (!profileId) {
      return res.status(400).json({ error: 'profileId is required' })
    }

    const admin = auth.role === 'admin' || isAdminUser(auth)
    if (!admin) {
      if (!(await ensureProfileAccess(req, res, String(profileId)))) return
    }

    // Count jobs created by auto-discovery for this profile
    const stats = await req.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'running' OR status = 'queued' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM crawler_jobs
      WHERE profile_id = ? AND requested_by = 'auto-discovery'
    `).get(profileId)

    return res.json({
      profileId,
      total: stats.total || 0,
      running: stats.running || 0,
      completed: stats.completed || 0,
      failed: stats.failed || 0,
    })
  } catch (error) {
    console.error('Error fetching auto-discovery status:', error)
    return res.status(500).json(formatError(error))
  }
})

// Bulk populate opportunities from comprehensive crawler templates
// Admin-only endpoint to generate funding opportunities for all ZIP codes
router.post('/bulk-populate', async (req, res) => {
  // Allow admin auth OR a special bulk key for automated population
  const auth = req.user ?? { role: 'guest' }
  const bulkKey = req.headers['x-bulk-key'] || req.body?.bulk_key
  const expectedKey = process.env.BULK_POPULATE_KEY || null
  
  const isAdmin = auth.role === 'admin'
  const hasValidKey = Boolean(expectedKey) && bulkKey === expectedKey
  
  if (!isAdmin && !hasValidKey) {
    return res.status(403).json({ error: 'Admin access or valid bulk key required' })
  }
  
  try {
    const { limit_per_zip = 8, max_zips = 5000 } = req.body || {}
    const dataDir = join(__dirname, '..', 'data', 'crawlers')
    const zipFile = join(dataDir, 'zip_coordinates.json')
    
    if (!fs.existsSync(zipFile)) {
      return res.status(500).json({ error: 'ZIP coordinates file not found' })
    }
    
    const zipMap = JSON.parse(fs.readFileSync(zipFile, 'utf8'))
    const allZipCodes = Object.keys(zipMap).slice(0, max_zips)
    
    console.log(`[bulk-populate] Starting population of ${allZipCodes.length} ZIP codes with ${limit_per_zip} opportunities each`)
    
    // Import the crawler function
    const { processComprehensiveCrawlerJob } = await import('../services/comprehensiveCrawlerOptimized.js')
    
    const batchSize = 100
    let totalInserted = 0
    let totalEvaluated = 0
    const errors = []
    
    for (let i = 0; i < allZipCodes.length; i += batchSize) {
      const batch = allZipCodes.slice(i, i + batchSize)
      
      try {
        const job = {
          id: `bulk-populate-${i}-${Date.now()}`,
          type: 'comprehensive',
          parameters: {
            zip_list: batch,
            limit_per_zip: limit_per_zip
          }
        }
        
        const result = await processComprehensiveCrawlerJob({
          db: req.db,
          job,
          dataDir,
          profileContext: null
        })
        
        totalInserted += result.inserted || 0
        totalEvaluated += result.evaluated || 0
        
        console.log(`[bulk-populate] Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(allZipCodes.length/batchSize)}: ${result.inserted} opportunities`)
      } catch (batchErr) {
        errors.push({ batch: i, error: batchErr.message })
        console.error(`[bulk-populate] Batch ${i} error:`, batchErr.message)
      }
    }
    
    console.log(`[bulk-populate] Complete: ${totalInserted} opportunities inserted from ${allZipCodes.length} ZIPs`)
    
    res.json({
      success: true,
      zip_codes_processed: allZipCodes.length,
      opportunities_inserted: totalInserted,
      opportunities_evaluated: totalEvaluated,
      errors: errors.length > 0 ? errors : undefined
    })
  } catch (error) {
    console.error('Error in bulk populate:', error)
    res.status(500).json(formatError(error))
  }
})

// Crawl all counties for local funding sources (background job)
router.post('/crawl-all-counties', async (req, res) => {
  const auth = req.user ?? { role: 'guest' }
  const bulkKey = req.headers['x-bulk-key'] || req.body?.bulk_key
  const expectedKey = process.env.BULK_POPULATE_KEY || null
  
  if (auth.role !== 'admin' && !(expectedKey && bulkKey === expectedKey)) {
    return res.status(403).json({ error: 'Admin access or valid bulk key required' })
  }
  
  try {
    console.log('[crawl-all-counties] Starting county-level funding crawl...')
    
    const { crawlAllCounties } = await import('../services/countyFundingCrawler.js')
    const result = await crawlAllCounties(req.db)
    
    const totalCount = Number(
      (await req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = ?').get(true))?.count || 0,
    )
    
    res.json({
      success: true,
      message: `Crawled ${result.counties} counties across ${result.states} states`,
      states_processed: result.states,
      counties_processed: result.counties,
      opportunities_per_county: 5,
      inserted: result.inserted,
      updated: result.updated,
      errors: result.errors,
      total_opportunities: totalCount,
      note: 'Each county now has United Way, Food Bank, Housing Authority, Community Action, and Salvation Army entries'
    })
  } catch (error) {
    console.error('[crawl-all-counties] Error:', error)
    res.status(500).json(formatError(error))
  }
})

// Crawl counties for a specific state
router.post('/crawl-state-counties/:state', async (req, res) => {
  const auth = req.user ?? { role: 'guest' }
  const bulkKey = req.headers['x-bulk-key'] || req.body?.bulk_key
  const expectedKey = process.env.BULK_POPULATE_KEY || null
  
  if (auth.role !== 'admin' && !(expectedKey && bulkKey === expectedKey)) {
    return res.status(403).json({ error: 'Admin access or valid bulk key required' })
  }
  
  const state = req.params.state?.toUpperCase()
  if (!state || state.length !== 2) {
    return res.status(400).json({ error: 'Valid 2-letter state code required' })
  }
  
  try {
    const { crawlStateCounties } = await import('../services/countyFundingCrawler.js')
    const result = await crawlStateCounties(req.db, state)
    
    res.json({
      success: true,
      state,
      counties_processed: result.counties,
      inserted: result.inserted,
      updated: result.updated,
      errors: result.errors
    })
  } catch (error) {
    console.error(`[crawl-state-counties] Error for ${state}:`, error)
    res.status(500).json(formatError(error))
  }
})

// Get county crawler status
router.get('/county-status', async (req, res) => {
  try {
    const { getCrawlerStatus } = await import('../services/countyFundingCrawler.js')
    const status = await getCrawlerStatus(req.db)
    
    const totalOpps = Number(
      (await req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = ?').get(true))?.count || 0,
    )
    
    res.json({
      ...status,
      total_all_opportunities: totalOpps
    })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Seed local assistance networks (food banks, community agencies, etc.)
router.post('/seed-local-networks', async (req, res) => {
  const auth = req.user ?? { role: 'guest' }
  const bulkKey = req.headers['x-bulk-key'] || req.body?.bulk_key
  const expectedKey = process.env.BULK_POPULATE_KEY || null
  
  if (auth.role !== 'admin' && !(expectedKey && bulkKey === expectedKey)) {
    return res.status(403).json({ error: 'Admin access or valid bulk key required' })
  }
  
  try {
    const fs = await import('fs')
    const path = await import('path')
    const { fileURLToPath } = await import('url')
    
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const dataPath = path.join(__dirname, '..', 'data', 'local_assistance_networks.json')
    
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
    
    let inserted = 0, updated = 0, errors = 0
    
    for (const net of data.networks) {
      try {
        const existing = await req.db.prepare('SELECT id FROM funding_opportunities WHERE id = ?').get(net.id)
        const categoriesJson = JSON.stringify(net.categories || [])
        const keywordsJson = JSON.stringify([...net.categories, 'local', 'assistance', 'community'].filter(Boolean))
        
        if (existing) {
          await req.db.prepare(`
            UPDATE funding_opportunities SET
              title = ?, sponsor = ?, description = ?, application_url = ?, source_url = ?,
              is_national = ?, state = ?, categories = ?, keywords = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            net.title,
            net.sponsor,
            net.description,
            net.url,
            net.url,
            Boolean(net.is_national),
            net.state || 'nationwide',
            categoriesJson,
            keywordsJson,
            net.id,
          )
          updated++
        } else {
          await req.db.prepare(`
            INSERT INTO funding_opportunities (
              id, title, sponsor, source, source_id, source_url, description,
              application_url, is_national, state, categories, keywords,
              opportunity_type, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, 'verified_real', ?, ?, ?, ?, ?, ?, ?, ?, 'program', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).run(
            net.id,
            net.title,
            net.sponsor,
            net.id,
            net.url,
            net.description,
            net.url,
            Boolean(net.is_national),
            net.state || 'nationwide',
            categoriesJson,
            keywordsJson,
            true,
          )
          inserted++
        }
      } catch (e) {
        console.error(`[seed-local-networks] Error for ${net.id}:`, e.message)
        errors++
      }
    }
    
    const totalCount = Number(
      (await req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = ?').get(true))?.count || 0,
    )
    
    res.json({
      success: true,
      message: `Seeded local networks: ${inserted} new, ${updated} updated`,
      inserted,
      updated,
      errors,
      total_opportunities: totalCount
    })
  } catch (error) {
    console.error('[seed-local-networks] Error:', error)
    res.status(500).json(formatError(error))
  }
})

// Seed state assistance programs (211, SNAP, etc.)
router.post('/seed-state-assistance', async (req, res) => {
  const auth = req.user ?? { role: 'guest' }
  const bulkKey = req.headers['x-bulk-key'] || req.body?.bulk_key
  const expectedKey = process.env.BULK_POPULATE_KEY || null
  
  if (auth.role !== 'admin' && !(expectedKey && bulkKey === expectedKey)) {
    return res.status(403).json({ error: 'Admin access or valid bulk key required' })
  }
  
  try {
    console.log('[seed-state-assistance] Loading state assistance programs...')
    
    const fs = await import('fs')
    const path = await import('path')
    const { fileURLToPath } = await import('url')
    
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const dataPath = path.join(__dirname, '..', 'data', 'state_assistance_programs.json')
    
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
    
    let inserted = 0, updated = 0, errors = 0
    
    for (const prog of data.programs) {
      try {
        const existing = await req.db.prepare('SELECT id FROM funding_opportunities WHERE id = ?').get(prog.id)
        
        const isNational = prog.state === 'nationwide'
        const categoriesJson = JSON.stringify(prog.categories || [])
        const keywordsJson = JSON.stringify([prog.state?.toLowerCase(), '211', 'local', 'assistance'].filter(Boolean))
        
        if (existing) {
          await req.db.prepare(`
            UPDATE funding_opportunities SET
              title = ?, sponsor = ?, description = ?, application_url = ?, source_url = ?,
              is_national = ?, state = ?, categories = ?, keywords = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            prog.title,
            prog.sponsor,
            prog.description,
            prog.url,
            prog.url,
            Boolean(isNational),
            prog.state,
            categoriesJson,
            keywordsJson,
            prog.id,
          )
          updated++
        } else {
          await req.db.prepare(`
            INSERT INTO funding_opportunities (
              id, title, sponsor, source, source_id, source_url, description,
              application_url, is_national, state, categories, keywords,
              opportunity_type, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, 'verified_real', ?, ?, ?, ?, ?, ?, ?, ?, 'program', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).run(
            prog.id,
            prog.title,
            prog.sponsor,
            prog.id,
            prog.url,
            prog.description,
            prog.url,
            Boolean(isNational),
            prog.state,
            categoriesJson,
            keywordsJson,
            true,
          )
          inserted++
        }
      } catch (e) {
        console.error(`[seed-state-assistance] Error for ${prog.id}:`, e.message)
        errors++
      }
    }
    
    const totalCount = Number(
      (await req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = ?').get(true))?.count || 0,
    )
    
    res.json({
      success: true,
      message: `Seeded state assistance programs: ${inserted} new, ${updated} updated`,
      inserted,
      updated,
      errors,
      total_opportunities: totalCount
    })
  } catch (error) {
    console.error('[seed-state-assistance] Error:', error)
    res.status(500).json(formatError(error))
  }
})

// Crawl Grants.gov for REAL federal funding opportunities
router.post('/crawl-grants-gov', async (req, res) => {
  const auth = req.user ?? { role: 'guest' }
  const bulkKey = req.headers['x-bulk-key'] || req.body?.bulk_key
  const expectedKey = process.env.BULK_POPULATE_KEY || null
  
  if (auth.role !== 'admin' && !(expectedKey && bulkKey === expectedKey)) {
    return res.status(403).json({ error: 'Admin access or valid bulk key required' })
  }
  
  try {
    console.log('[crawl-grants-gov] Starting Grants.gov crawl...')
    
    const { crawlGrantsGov } = await import('../services/grantsDotGovCrawler.js')
    
    const maxPages = req.body?.max_pages || 5
    const result = await crawlGrantsGov(req.db, { maxPages, rowsPerPage: 100 })
    
    const totalCount = Number(
      (await req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = ?').get(true))?.count || 0,
    )
    
    res.json({
      success: true,
      message: `Crawled Grants.gov: ${result.inserted} new, ${result.updated} updated`,
      inserted: result.inserted,
      updated: result.updated,
      errors: result.errors,
      total_opportunities: totalCount,
      note: 'All opportunities are REAL federal grants from Grants.gov'
    })
  } catch (error) {
    console.error('[crawl-grants-gov] Error:', error)
    res.status(500).json(formatError(error))
  }
})

// Remove all loans and matching-fund opportunities from the database
router.post('/remove-loans', async (req, res) => {
  const auth = req.user ?? { role: 'guest' }
  const bulkKey = req.headers['x-bulk-key'] || req.body?.bulk_key
  const expectedKey = process.env.BULK_POPULATE_KEY || null
  
  if (auth.role !== 'admin' && !(expectedKey && bulkKey === expectedKey)) {
    return res.status(403).json({ error: 'Admin access or valid bulk key required' })
  }
  
  try {
    console.log('[remove-loans] Removing loans and matching-fund opportunities...')
    
    // Delete loans
    const loansDeleted = await req.db.prepare(`
      DELETE FROM funding_opportunities 
      WHERE opportunity_type = 'loan' 
         OR title LIKE '%Loan%' 
         OR title LIKE '%loan%'
         OR categories LIKE '%loan%'
    `).run()
    
    // Delete matching-fund opportunities
    const matchingDeleted = await req.db.prepare(`
      DELETE FROM funding_opportunities 
      WHERE requires_match = TRUE
    `).run()
    
    const totalRemaining = Number(
      (await req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = ?').get(true))?.count || 0,
    )
    
    res.json({
      success: true,
      loans_removed: loansDeleted.changes,
      matching_removed: matchingDeleted.changes,
      total_remaining: totalRemaining,
      message: 'All loans and matching-fund opportunities have been removed'
    })
  } catch (error) {
    console.error('[remove-loans] Error:', error)
    res.status(500).json(formatError(error))
  }
})

// Seed ALL real funding opportunities - national + state programs
router.post('/seed-all-real', async (req, res) => {
  const auth = req.user ?? { role: 'guest' }
  const bulkKey = req.headers['x-bulk-key'] || req.body?.bulk_key
  const expectedKey = process.env.BULK_POPULATE_KEY || null
  
  if (auth.role !== 'admin' && !(expectedKey && bulkKey === expectedKey)) {
    return res.status(403).json({ error: 'Admin access or valid bulk key required' })
  }
  
  try {
    console.log('[seed-all-real] Starting comprehensive real funding seed...')
    
    const { seedAllRealFunding, getOpportunityCountsByState } = await import('../services/realLocationFundingCrawler.js')
    
    const result = await seedAllRealFunding(req.db)
    const counts = getOpportunityCountsByState(req.db)
    
    // Count minimum available per ZIP (national programs available everywhere)
    const minPerZip = counts.nationwide
    
    res.json({
      success: true,
      message: `Seeded ${result.total} REAL funding opportunities`,
      national_programs: result.national.inserted + result.national.updated,
      state_programs: result.states.inserted + result.states.updated,
      total_opportunities: result.total,
      minimum_per_zip: minPerZip,
      note: 'All opportunities have verified, clickable URLs to real funding sources'
    })
  } catch (error) {
    console.error('[seed-all-real] Error:', error)
    res.status(500).json(formatError(error))
  }
})

// Seed verified real funding opportunities from curated JSON file
router.post('/seed-real-opportunities', async (req, res) => {
  const auth = req.user ?? { role: 'guest' }
  const bulkKey = req.headers['x-bulk-key'] || req.body?.bulk_key
  const expectedKey = process.env.BULK_POPULATE_KEY || null
  
  const isAdmin = auth.role === 'admin'
  const hasValidKey = Boolean(expectedKey) && bulkKey === expectedKey
  
  if (!isAdmin && !hasValidKey) {
    return res.status(403).json({ error: 'Admin access or valid bulk key required' })
  }
  
  try {
    const dataPath = join(__dirname, '..', 'data', 'real_funding_opportunities.json')
    
    if (!fs.existsSync(dataPath)) {
      return res.status(404).json({ error: 'Real opportunities data file not found' })
    }
    
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
    const opportunities = data.opportunities || []
    
    let inserted = 0
    let updated = 0
    const errors = []
    
    for (const opp of opportunities) {
      try {
        const existing = req.db.prepare(
          'SELECT id FROM funding_opportunities WHERE id = ? OR (source = ? AND source_id = ?)'
        ).get(opp.id, opp.source, opp.source_id || opp.id)
        
        if (existing) {
          req.db.prepare(`
            UPDATE funding_opportunities SET
              title = ?, sponsor = ?, description = ?, amount_min = ?, amount_max = ?,
              deadline = ?, deadline_type = ?, application_url = ?, source_url = ?,
              is_national = ?, state = ?, categories = ?, keywords = ?,
              eligibility_bullets = ?, opportunity_type = ?, requires_501c3 = ?,
              requires_match = ?, match_percentage = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            opp.title, opp.sponsor, opp.description, opp.amount_min, opp.amount_max,
            opp.deadline, opp.deadline_type, opp.application_url, opp.source_url,
            opp.is_national ? 1 : 0, opp.state || 'nationwide',
            JSON.stringify(opp.categories || []), JSON.stringify(opp.keywords || []),
            JSON.stringify(opp.eligibility_bullets || []), opp.opportunity_type || 'grant',
            opp.requires_501c3 ? 1 : 0, opp.requires_match ? 1 : 0, opp.match_percentage || null,
            existing.id
          )
          updated++
        } else {
          req.db.prepare(`
            INSERT INTO funding_opportunities (
              id, title, sponsor, source, source_id, source_url, description,
              amount_min, amount_max, deadline, deadline_type, application_url,
              is_national, state, categories, keywords, eligibility_bullets,
              opportunity_type, requires_501c3, requires_match, match_percentage, is_active,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).run(
            opp.id, opp.title, opp.sponsor, opp.source || 'verified_real',
            opp.source_id || opp.id, opp.source_url, opp.description,
            opp.amount_min, opp.amount_max, opp.deadline, opp.deadline_type,
            opp.application_url, opp.is_national ? 1 : 0, opp.state || 'nationwide',
            JSON.stringify(opp.categories || []), JSON.stringify(opp.keywords || []),
            JSON.stringify(opp.eligibility_bullets || []), opp.opportunity_type || 'grant',
            opp.requires_501c3 ? 1 : 0, opp.requires_match ? 1 : 0, opp.match_percentage || null
          )
          inserted++
        }
      } catch (dbErr) {
        errors.push({ id: opp.id, error: dbErr.message })
        console.error(`[seed-real] Error for ${opp.id}:`, dbErr.message)
      }
    }
    
    console.log(`[seed-real] Complete: ${inserted} inserted, ${updated} updated`)
    
    res.json({
      success: true,
      total: opportunities.length,
      inserted,
      updated,
      errors: errors.length > 0 ? errors : undefined
    })
  } catch (error) {
    console.error('[seed-real] Error:', error)
    res.status(500).json(formatError(error))
  }
})

// Crawler health endpoint
// GET /api/crawlers/health
router.get('/health', async (req, res) => {
  try {
    const db = req.db
    const since24hPredicate =
      db?.dialect === 'postgres'
        ? "created_at >= (NOW() - INTERVAL '24 hours')"
        : "created_at >= datetime('now', '-24 hours')"

    // Get overall job statistics
    const overallStats = await db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM crawler_jobs
      WHERE ${since24hPredicate}
    `).get()

    // Get last success by type (portable aggregate: not perfect, but avoids postgres GROUP BY errors)
    const lastSuccessRows = await db.prepare(`
      SELECT
        type,
        MAX(completed_at) as last_success,
        MAX(result_count) as result_count
      FROM crawler_jobs
      WHERE status = 'completed'
      GROUP BY type
    `).all()

    const lastSuccessByType = {}
    lastSuccessRows.forEach(row => {
      lastSuccessByType[row.type] = {
        last_success: row.last_success,
        result_count: row.result_count
      }
    })

    // Get last error by type (redacted) (portable aggregate)
    const lastErrorRows = await db.prepare(`
      SELECT
        type,
        MAX(completed_at) as last_error,
        SUBSTR(MAX(error), 1, 100) as error_preview
      FROM crawler_jobs
      WHERE status = 'failed'
      GROUP BY type
    `).all()

    const lastErrorByType = {}
    lastErrorRows.forEach(row => {
      lastErrorByType[row.type] = {
        last_error: row.last_error,
        error_preview: row.error_preview ? `${row.error_preview}...` : null
      }
    })

    // Calculate queue depth (queued + running)
    const queueDepth = Number(overallStats.queued || 0) + Number(overallStats.running || 0)

    // Determine worker status (check if there are stuck jobs)
    const stuckPredicate =
      db?.dialect === 'postgres'
        ? "started_at < (NOW() - INTERVAL '2 hours')"
        : "started_at < datetime('now', '-2 hours')"

    const stuckJobs = await db.prepare(`
      SELECT COUNT(*) as count
      FROM crawler_jobs
      WHERE status = 'running'
        AND ${stuckPredicate}
    `).get()

    const workerOnline = Number(stuckJobs?.count || 0) === 0

    // Calculate health status
    const recentFailures = Number(overallStats.failed || 0)
    const recentCompletions = Number(overallStats.completed || 0)
    const failureRate = (recentCompletions + recentFailures) > 0 
      ? recentFailures / (recentCompletions + recentFailures) 
      : 0

    let status = 'healthy'
    const warnings = []

    if (!workerOnline) {
      status = 'degraded'
      warnings.push('Worker may be stuck - found jobs running for >2 hours')
    }
    if (failureRate > 0.5 && recentFailures > 3) {
      status = 'degraded'
      warnings.push(`High failure rate: ${Math.round(failureRate * 100)}%`)
    }
    if (queueDepth > 100) {
      warnings.push(`Queue depth is high: ${queueDepth}`)
    }

    res.json({
      status,
      timestamp: new Date().toISOString(),
      worker_online: workerOnline,
      queue_depth: queueDepth,
      last_24h: {
        total: Number(overallStats.total || 0),
        queued: Number(overallStats.queued || 0),
        running: Number(overallStats.running || 0),
        completed: Number(overallStats.completed || 0),
        failed: Number(overallStats.failed || 0),
        failure_rate: Math.round(failureRate * 100)
      },
      last_success_by_type: lastSuccessByType,
      last_error_by_type: lastErrorByType,
      warnings: warnings.length > 0 ? warnings : undefined
    })
  } catch (error) {
    console.error('[crawlers/health] Error:', error)
    res.status(500).json({ 
      status: 'error', 
      error: 'Failed to get crawler health',
      timestamp: new Date().toISOString()
    })
  }
})

// Real funding opportunity crawler - fetches actual grants from real databases
router.post('/real-crawl', async (req, res) => {
  // Allow admin auth OR bulk key for automated crawling
  const auth = req.user ?? { role: 'guest' }
  const bulkKey = req.headers['x-bulk-key'] || req.body?.bulk_key
  const expectedKey = process.env.BULK_POPULATE_KEY || null
  
  const isAdmin = auth.role === 'admin'
  const hasValidKey = Boolean(expectedKey) && bulkKey === expectedKey
  
  if (!isAdmin && !hasValidKey) {
    return res.status(403).json({ error: 'Admin access or valid bulk key required' })
  }
  
  try {
    const { state = null, all_states = false } = req.body || {}
    
    // Dynamic import of the real crawler
    const { crawlRealOpportunities, crawlAllStates } = await import('../services/realFundingCrawler.js')
    
    console.log(`[real-crawl] Starting real opportunity crawl${state ? ` for ${state}` : all_states ? ' for all states' : ' (national)'}...`)
    
    let result
    if (all_states) {
      result = await crawlAllStates(req.db, (progress) => {
        console.log(`[real-crawl] Progress: ${JSON.stringify(progress)}`)
      })
    } else {
      result = await crawlRealOpportunities(req.db, state, {
        onProgress: (progress) => {
          console.log(`[real-crawl] Progress: ${JSON.stringify(progress)}`)
        }
      })
    }
    
    console.log(`[real-crawl] Complete: ${result.inserted || result.total_inserted} inserted`)
    
    res.json({
      success: true,
      ...result
    })
  } catch (error) {
    console.error('[real-crawl] Error:', error)
    res.status(500).json(formatError(error))
  }
})

export default router
