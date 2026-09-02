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
  let evaluator = null
  try {
    const row = await db
      .prepare('SELECT value FROM system_kv WHERE key = ? LIMIT 1')
      .get('pipeline_precision_last_run')
    const parsed = typeof row?.value === 'string' ? JSON.parse(row.value) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const repairAudit = parsed.taskRepairAudit ?? parsed.taskAudit ?? null
      const verifiedAudit = parsed.verificationTaskAudit ?? parsed.taskAudit ?? null
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
        task_failed: finiteCount(repairAudit?.failed),
        task_repair_failed: finiteCount(repairAudit?.repairFailed),
        task_truncated: repairAudit?.truncated === true,
      }
      if (verifiedAudit && typeof verifiedAudit === 'object') {
        evaluator = {
          as_of: cleanup.timestamp,
          scanned: finiteCount(verifiedAudit.scanned),
          valid: finiteCount(verifiedAudit.valid),
          invalid: finiteCount(verifiedAudit.invalid),
          protected: finiteCount(verifiedAudit.protected),
          failed: finiteCount(verifiedAudit.failed),
          repair_failed: finiteCount(verifiedAudit.repairFailed),
          truncated: verifiedAudit.truncated === true,
          by_gate: sanitizeCountMap(verifiedAudit.byGate),
          by_bucket: sanitizeCountMap(verifiedAudit.byBucket),
        }
      }
    }
  } catch {
    cleanup = null
    evaluator = null
  }

  return {
    available: cleanup !== null && evaluator !== null,
    healthy:
      cleanup !== null
      && cleanup.failed === 0
      && cleanup.truncated === false
      && cleanup.task_failed === 0
      && cleanup.task_repair_failed === 0
      && cleanup.task_truncated === false
      && evaluator !== null
      && evaluator.failed === 0
      && evaluator.repair_failed === 0
      && evaluator.truncated === false
      && evaluator.invalid === 0,
    cleanup,
    evaluator,
    invalid_active_hamilton_tasks: evaluator?.invalid ?? null,
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
        pipeline_precision: 'numeric_boot_verified_task_truth_v3',
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
