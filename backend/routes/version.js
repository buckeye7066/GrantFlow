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
    const databaseMigrations = await buildDatabaseMigrationIdentity(req.db, {
      releaseIdentity: version.releaseIdentity,
    })
    const { releaseIdentity, ...publicVersion } = version
    res.json({
      ...publicVersion,
      release_identity: releaseIdentity,
      database_migrations: databaseMigrations,
      contracts: {
        geo_crawl_unknown_run: '200_missing_payload',
        release_identity: releaseIdentity.contract,
        database_migrations: databaseMigrations.contract || null,
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
