import express from 'express'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import {
  buildDatabaseMigrationIdentity,
  buildRepositoryReleaseIdentity,
  resolveReleaseCommit,
} from '../../shared/releaseIdentity.js'
import { createLogger } from '../utils/logger.js'

const routeLogger = createLogger('route:version')
const router = express.Router()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let cachedVersion = null

function getVersionInfo() {
  if (cachedVersion) return cachedVersion

  let pkgVersion = 'unknown'
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    pkgVersion = pkg.version || 'unknown'
  } catch (error) {
    console.warn('[version] Could not read package.json:', error.message)
  }

  const providerCommit = resolveReleaseCommit(process.env)
  const version = {
    version: pkgVersion,
    commit: providerCommit.commit || 'unknown',
    commitSource: providerCommit.source,
    commitShort: 'unknown',
    branch: process.env.RAILWAY_GIT_BRANCH || process.env.GIT_BRANCH || 'unknown',
    environment: process.env.NODE_ENV || 'development',
    railway: Boolean(process.env.RAILWAY_ENVIRONMENT),
    railwayEnv: process.env.RAILWAY_ENVIRONMENT || null,
    buildTime: process.env.BUILD_TIME || new Date().toISOString(),
    nodeVersion: process.version,
  }

  if (version.commit === 'unknown') {
    try {
      const gitDir = path.resolve(__dirname, '../..')
      version.commit = execSync('git rev-parse HEAD', {
        cwd: gitDir,
        encoding: 'utf8',
      }).trim()
      version.commitShort = execSync('git rev-parse --short HEAD', {
        cwd: gitDir,
        encoding: 'utf8',
      }).trim()
      version.branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: gitDir,
        encoding: 'utf8',
      }).trim()
      version.commitSource = 'git_worktree'
    } catch (error) {
      console.warn('[version] Git commands failed:', error.message)
      version.commitShort = version.commit.substring(0, 7)
    }
  } else {
    version.commitShort = version.commit.substring(0, 7)
  }

  const releaseIdentity = buildRepositoryReleaseIdentity({
    commit: version.commit === 'unknown' ? null : version.commit,
    packageVersion: pkgVersion,
  })

  cachedVersion = { ...version, releaseIdentity }
  return cachedVersion
}

const ACTIVE_TASK_HISTORY_STATUSES = Object.freeze([
  'submitted', 'completed', 'complete', 'done', 'cancelled', 'canceled',
  'archived', 'rejected', 'closed', 'submit_attempt_started',
  'submit_evidence_pending', 'submission_verification_required',
])

function finiteCount(value) {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? count : 0
}

function sanitizeCountMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => /^[a-z0-9_:-]{1,80}$/i.test(String(key)))
      .map(([key, count]) => [String(key), finiteCount(count)]),
  )
}

/**
 * Public, numeric-only evidence that strict pipeline cleanup actually ran.
 * No profile IDs, grant titles, source URLs, task IDs, or stored error text are
 * returned. This lets production verification distinguish "code deployed" from
 * "live bad work removed" without exposing private pipeline data.
 */
async function getPipelinePrecisionVerification(db) {
  let cleanup = null
  try {
    const row = await db
      .prepare('SELECT value FROM system_kv WHERE key = ? LIMIT 1')
      .get('pipeline_precision_last_run')
    const parsed = typeof row?.value === 'string' ? JSON.parse(row.value) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cleanup = {
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : null,
        scanned: finiteCount(parsed.scanned),
        kept: finiteCount(parsed.kept),
        removed: finiteCount(parsed.removed),
        relabeled: finiteCount(parsed.relabeled),
        tasks_cancelled: finiteCount(parsed.tasksCancelled ?? parsed.tasks_cancelled),
        matches_removed: finiteCount(parsed.matchesRemoved ?? parsed.matches_removed),
        failed: finiteCount(parsed.failed),
        truncated: parsed.truncated === true,
        profiles: finiteCount(parsed.profiles),
        profiles_affected: finiteCount(parsed.profilesAffected ?? parsed.profiles_affected),
        by_gate: sanitizeCountMap(parsed.byGate ?? parsed.by_gate),
      }
    }
  } catch {
    cleanup = null
  }

  let invalidActiveTasks = null
  try {
    const terminalSql = ACTIVE_TASK_HISTORY_STATUSES
      .map((status) => `'${status.replaceAll("'", "''")}'`)
      .join(', ')
    const row = await db.prepare(`
      SELECT COUNT(*) AS count
        FROM application_tasks t
       WHERE LOWER(COALESCE(t.status, '')) NOT IN (${terminalSql})
         AND (
           (t.grant_id IS NULL AND t.opportunity_id IS NULL)
           OR (
             t.grant_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM grants missing_g WHERE missing_g.id = t.grant_id)
           )
           OR (
             t.opportunity_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM funding_opportunities missing_fo
                WHERE missing_fo.id = t.opportunity_id
             )
           )
           OR EXISTS (
             SELECT 1
               FROM grants rejected_g
              WHERE rejected_g.id = t.grant_id
                AND (
                  LOWER(COALESCE(rejected_g.eligibility_status, '')) = 'ineligible'
                  OR LOWER(COALESCE(rejected_g.match_decision, '')) = 'reject'
                )
           )
           OR EXISTS (
             SELECT 1
               FROM grants rejected_pair
              WHERE rejected_pair.profile_id = t.profile_id
                AND rejected_pair.funding_opportunity_id = t.opportunity_id
                AND (
                  LOWER(COALESCE(rejected_pair.eligibility_status, '')) = 'ineligible'
                  OR LOWER(COALESCE(rejected_pair.match_decision, '')) = 'reject'
                )
           )
         )
    `).get()
    invalidActiveTasks = finiteCount(row?.count)
  } catch {
    invalidActiveTasks = null
  }

  return {
    available: cleanup !== null && invalidActiveTasks !== null,
    healthy:
      cleanup !== null
      && cleanup.failed === 0
      && cleanup.truncated === false
      && invalidActiveTasks === 0,
    cleanup,
    invalid_active_hamilton_tasks: invalidActiveTasks,
  }
}

/**
 * GET /api/version
 *
 * Returns the exact code SHA plus a content-addressed release manifest. The
 * database section compares the ordered _migrations rows with the migration
 * filenames and file hashes shipped in this same release.
 */
router.get('/', async (req, res) => {
  try {
    const version = getVersionInfo()
    const [databaseMigrations, pipelinePrecision] = await Promise.all([
      buildDatabaseMigrationIdentity(req.db, {
        releaseIdentity: version.releaseIdentity,
      }),
      getPipelinePrecisionVerification(req.db),
    ])
    const { releaseIdentity, ...publicVersion } = version
    res.json({
      ...publicVersion,
      release_identity: releaseIdentity,
      database_migrations: databaseMigrations,
      pipeline_precision: pipelinePrecision,
      contracts: {
        geo_crawl_unknown_run: '200_missing_payload',
        release_identity: releaseIdentity.contract,
        database_migrations: databaseMigrations.contract || null,
        pipeline_precision: 'numeric_summary_v1',
      },
    })
  } catch (error) {
    routeLogger.error('[version] Failed to get version info:', error)
    res.status(500).json({
      error: 'failed_to_get_version',
      message: 'Could not retrieve version information',
    })
  }
})

export default router
