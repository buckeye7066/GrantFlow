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
import {
  PIPELINE_PRECISION_SNAPSHOT_CONTRACT,
  readHamiltonTaskTruthSnapshot,
} from '../services/hamilton/hamiltonTaskTruthSnapshot.js'

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
  const truth = await readHamiltonTaskTruthSnapshot(db)
  const cleanup = truth.cleanup
    ? {
        status: truth.status,
        timestamp: truth.asOf,
        scanned: finiteCount(truth.cleanup.scanned),
        kept: finiteCount(truth.cleanup.kept),
        removed: finiteCount(truth.cleanup.removed),
        relabeled: finiteCount(truth.cleanup.relabeled),
        deferred: finiteCount(truth.cleanup.deferred),
        tasks_cancelled: finiteCount(truth.cleanup.tasksCancelled),
        matches_removed: finiteCount(truth.cleanup.matchesRemoved),
        failed: finiteCount(truth.cleanup.failed),
        truncated: truth.cleanup.truncated === true,
        profiles: finiteCount(truth.cleanup.profiles),
        profiles_affected: finiteCount(truth.cleanup.profilesAffected),
        by_gate: sanitizeCountMap(truth.cleanup.byGate),
        task_failed: finiteCount(truth.repair?.failed),
        task_repair_failed: finiteCount(truth.repair?.repairFailed),
        task_deferred: finiteCount(truth.repair?.deferred),
        task_truncated: truth.repair?.truncated === true,
      }
    : null
  const evaluator = truth.verification
    ? {
        as_of: truth.asOf,
        scanned: finiteCount(truth.verification.scanned),
        valid: finiteCount(truth.verification.valid),
        invalid: finiteCount(truth.verification.invalid),
        deferred: finiteCount(truth.verification.deferred),
        protected: finiteCount(truth.verification.protected),
        failed: finiteCount(truth.verification.failed),
        repair_failed: finiteCount(truth.verification.repairFailed),
        truncated: truth.verification.truncated === true,
        by_gate: sanitizeCountMap(truth.verification.byGate),
        by_bucket: sanitizeCountMap(truth.verification.byBucket),
      }
    : null

  return {
    available: truth.available,
    healthy: truth.healthy,
    status: truth.status,
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
        pipeline_precision: PIPELINE_PRECISION_SNAPSHOT_CONTRACT,
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
