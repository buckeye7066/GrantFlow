import express from 'express'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const router = express.Router()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Cache version info to avoid repeated git/fs operations
let cachedVersion = null

function getVersionInfo() {
  if (cachedVersion) return cachedVersion

  // Read version from package.json
  let pkgVersion = 'unknown'
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    pkgVersion = pkg.version || 'unknown'
  } catch (error) {
    console.warn('[version] Could not read package.json:', error.message)
  }

  const version = {
    version: pkgVersion,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'unknown',
    commitShort: 'unknown',
    branch: process.env.RAILWAY_GIT_BRANCH || process.env.GIT_BRANCH || 'unknown',
    environment: process.env.NODE_ENV || 'development',
    railway: !!process.env.RAILWAY_ENVIRONMENT,
    railwayEnv: process.env.RAILWAY_ENVIRONMENT || null,
    buildTime: process.env.BUILD_TIME || new Date().toISOString(),
    nodeVersion: process.version,
  }

  // Try to get git info if not in env vars
  if (version.commit === 'unknown') {
    try {
      const gitDir = path.resolve(__dirname, '../..')
      version.commit = execSync('git rev-parse HEAD', { cwd: gitDir, encoding: 'utf8' }).trim()
      version.commitShort = execSync('git rev-parse --short HEAD', { cwd: gitDir, encoding: 'utf8' }).trim()
      version.branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: gitDir, encoding: 'utf8' }).trim()
    } catch (err) {
      console.warn('[version] Git commands failed:', err.message)
      version.commitShort = version.commit.substring(0, 7)
    }
  } else {
    version.commitShort = version.commit.substring(0, 7)
  }

  cachedVersion = version
  return version
}

/**
 * GET /api/version
 * 
 * Returns deployment version information including:
 * - commit SHA (full and short)
 * - git branch
 * - environment (production/staging/development)
 * - build time
 * - Node.js version
 * 
 * This endpoint is used to verify which code is deployed in production.
 */
router.get('/', (req, res) => {
  try {
    const version = getVersionInfo()
    // Lets operators confirm Railway/Vercel picked up a build without reading 404s in the browser.
    res.json({
      ...version,
      contracts: {
        geo_crawl_unknown_run: '200_missing_payload',
      },
    })
  } catch (error) {
    console.error('[version] Failed to get version info:', error)
    res.status(500).json({
      error: 'failed_to_get_version',
      message: 'Could not retrieve version information',
    })
  }
})

export default router
