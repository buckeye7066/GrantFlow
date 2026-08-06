import path from 'path'
import { promises as fs } from 'fs'
import jwt from 'jsonwebtoken'
import { fileURLToPath } from 'url'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'
import { collectComponentFiles, scanComponentForButtons } from './anyaButtonScanner.js'
import { getJwtSecretOrThrow } from '../config/env.js'
import { ADMIN_EMAIL } from '../config/constants.js'
import { createLogger } from '../utils/logger.js'
import { resolveInternalSelfBaseUrl } from '../utils/internalSelfBaseUrl.js'
const log = createLogger('anyaAutonomousFunctionTesting')

const REPO_ROOT = path.resolve(process.cwd())
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function uniquePaths(paths) {
  const seen = new Set()
  return paths.filter((entry) => {
    if (!entry) return false
    const resolved = path.resolve(entry)
    if (seen.has(resolved)) return false
    seen.add(resolved)
    return true
  })
}

function defaultComponentSearchPaths() {
  const anchors = [
    REPO_ROOT,
    path.resolve(REPO_ROOT, '..'),
    path.resolve(__dirname, '..', '..'),
    path.resolve(__dirname, '..', '..', '..'),
  ]
  const relativeCandidates = [
    'src/components',
    'frontend/src/components',
    'client/src/components',
    'app/src/components',
    'dist/assets',
    'build/assets',
    'public/assets',
  ]
  const configured = String(process.env.FRONTEND_COMPONENTS_PATH || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return uniquePaths([
    ...configured.map((entry) => path.isAbsolute(entry) ? entry : path.resolve(REPO_ROOT, entry)),
    ...anchors.flatMap((anchor) => relativeCandidates.map((relative) => path.resolve(anchor, relative))),
  ])
}

function isProdEnv() {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase()
  const deployEnv = String(process.env.DEPLOY_ENV || '').toLowerCase()
  return nodeEnv === 'production' || deployEnv === 'production'
}

/**
 * Create audit log entry for function testing operations
 */
async function auditLog(entry, context) {
  const timestamp = new Date().toISOString()
  const logEntry = { timestamp, ...entry }

  const db = context?.db
  if (db) {
    try {
      await logAuditEvent(db, {
        category: AUDIT_CATEGORIES.ANYA,
        action: `autonomous_function_tests.${String(entry?.action || 'event')}`,
        severity: SEVERITY.INFO,
        userId: context?.user?.userId ?? context?.user?.id ?? null,
        profileId: context?.profile_id ?? context?.profileId ?? null,
        resourceType: 'anya_autonomous_function_tests',
        resourceId: null,
        details: logEntry,
      })
      return
    } catch (error) {
      console.warn('[anyaAutonomousFunctionTesting] audit db write failed:', {
        error: error?.message || error,
        action: entry?.action,
        userId: context?.user?.userId ?? context?.user?.id ?? null
      })
    }
  }

  // Durable fallback: platform logs
  log.info('[audit][autonomous-function-tests]', JSON.stringify(logEntry))

  // Dev-only filesystem sink (explicit opt-in).
  if (!isProdEnv() && String(process.env.ALLOW_DEV_FILESYSTEM_AUDIT_LOGS || '').toLowerCase() === 'true') {
    try {
      const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
      await fs.mkdir(auditDir, { recursive: true })
      const logFile = path.join(auditDir, 'autonomous-function-tests.log')
      await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n', 'utf8')
    } catch (error) {
      console.warn('[anyaAutonomousFunctionTesting] Failed to write dev audit log:', error.message)
    }
  }
}

/**
 * Test suite definitions for API endpoints
 */
const API_TEST_SUITES = {
  health: {
    name: 'Health Checks',
    tests: [
      {
        name: 'Server Health',
        method: 'GET',
        path: '/api/health',
        expectedStatus: 200,
      },
      { name: 'Liveness', method: 'GET', path: '/healthz', expectedStatus: 200 },
      // readiness can be 503 in misconfigured prod; keep it informative but non-fatal.
      { name: 'Readiness', method: 'GET', path: '/readyz', expectedStatus: [200, 503] },
    ],
  },
  auth: {
    name: 'Authentication',
    tests: [
      // This should be 401 without auth, 200 with auth.
      { name: 'Auth Me (unauth)', method: 'GET', path: '/api/auth/me', expectedStatus: 401 },
      { name: 'Auth Me (admin token)', method: 'GET', path: '/api/auth/me', expectedStatus: 200, requiresAuth: true },
    ],
  },
  profiles: {
    name: 'Profile Management',
    tests: [
      {
        name: 'List Profiles',
        method: 'GET',
        path: '/api/profiles',
        expectedStatus: 200,
        requiresAuth: true,
      },
      {
        name: 'Profile Schema',
        method: 'GET',
        path: '/api/profiles/schema',
        expectedStatus: 200,
      },
    ],
  },
  opportunities: {
    name: 'Funding Opportunities',
    tests: [
      {
        name: 'List Opportunities',
        method: 'GET',
        path: '/api/opportunities',
        expectedStatus: 200,
      },
    ],
  },
  crawlers: {
    name: 'Crawler System',
    tests: [
      {
        name: 'List Crawler Jobs',
        method: 'GET',
        path: '/api/crawlers/jobs',
        expectedStatus: 200,
        requiresAuth: true,
      },
    ],
  },
  anya: {
    name: 'Anya Assistant',
    tests: [
      {
        name: 'Anya Status',
        method: 'GET',
        path: '/api/anya/status',
        expectedStatus: 200,
        requiresAuth: true,
        requiresAdmin: true,
      },
      {
        name: 'List Tools',
        method: 'GET',
        path: '/api/anya/tools',
        expectedStatus: 200,
        requiresAuth: true,
      },
    ],
  },
}

function resolveInternalBaseUrl(context = {}) {
  let candidate = String(context?.internalBaseUrl || context?.baseUrl || '').trim()

  if (!candidate) {
    try {
      const globalUrl = globalThis.__grantflow_internal_base_url
      if (typeof globalUrl === 'string' && globalUrl.trim()) {
        candidate = globalUrl.trim()
      }
    } catch (error) {
      log.debug('[anyaAutonomousFunctionTesting] globalThis access failed:', error.message)
    }
  }

  const resolved = resolveInternalSelfBaseUrl({
    configured: candidate || process.env.ANYA_SELF_BASE_URL,
    port: process.env.PORT || 8080,
  })
  if (!resolved.ok) {
    log.warn('[anyaAutonomousFunctionTesting] internal base URL refused', { reason: resolved.reason })
    return null
  }
  return resolved.baseUrl
}

function resolveAdminToken() {
  const token = String(process.env.ANYA_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '').trim()
  if (!token) return null
  // Basic validation
  if (token.length < 32 || !/^[a-zA-Z0-9._-]+$/.test(token)) {
    console.warn('[anyaAutonomousFunctionTesting] Invalid admin token format')
    return null
  }
  return token
}

function resolveInternalAdminToken(context) {
  const configuredToken = resolveAdminToken()
  if (configuredToken) return configuredToken

  const user = context?.user || {}
  // DB-backed admin only (context.ctx.isAdmin); never a raw JWT role/is_admin claim.
  const isAdmin = context?.ctx?.isAdmin === true
  if (!isAdmin) return null
  const operatorEmail = String(process.env.AGENT_CONTROL_ADMIN_EMAIL || ADMIN_EMAIL || '').trim().toLowerCase()
  if (!operatorEmail) return null

  try {
    const secret = getJwtSecretOrThrow(process.env)
    return jwt.sign(
      {
        sub: user.userId ?? user.id ?? 'system_admin_token',
        userId: user.userId ?? user.id ?? 'system_admin_token',
        role: 'admin',
        roles: ['admin'],
        is_admin: true,
        // The minted internal-admin JWT must carry the canonical operator
        // email so it passes isControlCenterAdmin() on /api/admin/agent-control
        // and any other canonical-admin gate. The throwaway placeholder used to
        // fail every canonical check, costing us false-positive Sam findings.
        email: operatorEmail,
        typ: 'service',
      },
      secret,
      { expiresIn: '10m' },
    )
  } catch (error) {
    console.warn('[anyaAutonomousFunctionTesting] failed to mint internal admin JWT:', error?.message || error)
    return null
  }
}

async function fetchWithTimeout(url, init, timeoutMs = 20_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, redirect: 'error', signal: controller.signal })
    return res
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Execute a single API test
 */
async function executeApiTest(test, context) {
  const baseUrl = resolveInternalBaseUrl(context)
  const result = {
    test_name: test.name,
    method: test.method,
    path: test.path,
    status: 'pending',
    requires_auth: test.requiresAuth || false,
    requires_admin: test.requiresAdmin || false,
  }
  
  try {
    if (!baseUrl) {
      result.status = 'skipped'
      result.message =
        'No internal base URL available. Set ANYA_SELF_BASE_URL or run inside the backend process.'
      return result
    }

    const expectedStatuses = Array.isArray(test.expectedStatus) ? test.expectedStatus : [test.expectedStatus]
    const headers = { 'content-type': 'application/json' }

    if (test.requiresAuth || test.requiresAdmin) {
      const token = resolveInternalAdminToken(context)
      if (!token) {
        result.status = 'failed'
        result.message = 'Unable to obtain internal admin token for authenticated probe'
        return result
      }
      headers.Authorization = `Bearer ${token}`
    }

    const url = `${baseUrl}${test.path}`
    const init = {
      method: test.method,
      headers,
    }
    if (test.body && test.method && String(test.method).toUpperCase() !== 'GET') {
      init.body = JSON.stringify(test.body)
    }

    const res = await fetchWithTimeout(url, init, Number(process.env.ANYA_FUNCTION_TEST_TIMEOUT_MS || 20_000))
    const status = res.status
    let bodyText = ''
    try {
      bodyText = await res.text()
    } catch (error) {
      console.warn(`[anyaAutonomousFunctionTesting] Failed to read response body for ${test.path}:`, error.message)
      bodyText = '<response body read error>'
    }

    result.http_status = status
    result.expected_status = expectedStatuses

    if (expectedStatuses.includes(status)) {
      result.status = 'passed'
      result.message = `HTTP ${status}`
    } else if (status >= 500) {
      result.status = 'failed'
      result.message = `Unexpected HTTP ${status}`
      result.body = bodyText.slice(0, 8000)
    } else {
      // 4xx/3xx mismatches are still useful but usually indicate auth/route drift.
      result.status = 'warning'
      result.message = `Unexpected HTTP ${status}`
      result.body = bodyText.slice(0, 2000)
    }
  } catch (error) {
    result.status = 'failed'
    result.error = error?.message || String(error)
  }

  return result
}

/**
 * Run autonomous function/API testing
 * @param {Object} options
 * @param {Array<string>} options.testSuites - Test suites to run (default: all)
 * @param {boolean} options.fixErrors - Attempt to fix errors found (default: false)
 * @param {boolean} options.dryRun - Don't save fixes (default: true)
 * @param {Object} context - Application context
 */
export async function runAutonomousFunctionTests(options, context) {
  const {
    testSuites = Object.keys(API_TEST_SUITES),
    fixErrors = false,
    dryRun = true,
  } = options

  const startTime = Date.now()
  const report = {
    started_at: new Date().toISOString(),
    test_suites: testSuites,
    fix_errors: fixErrors,
    dry_run: dryRun,
    total_tests: 0,
    tests_passed: 0,
    tests_failed: 0,
    tests_skipped: 0,
    errors_found: 0,
    errors_fixed: 0,
    results: [],
  }

  await auditLog({
    action: 'autonomous_function_tests_start',
    options,
  }, context)

  try {
    for (const suiteName of testSuites) {
      const suite = API_TEST_SUITES[suiteName]
      
      if (!suite) {
        report.results.push({
          suite: suiteName,
          error: 'Test suite not found',
        })
        continue
      }

      const suiteResult = {
        suite: suiteName,
        name: suite.name,
        tests: [],
      }

      for (const test of suite.tests) {
        report.total_tests++
        
        try {
          const testResult = await executeApiTest(test, context)
          
          if (testResult.status === 'passed') {
            report.tests_passed++
          } else if (testResult.status === 'failed') {
            report.tests_failed++
            report.errors_found++
          } else if (testResult.status === 'warning') {
            report.tests_warned = (report.tests_warned || 0) + 1
            report.errors_found++
          } else {
            report.tests_skipped++
          }

          suiteResult.tests.push(testResult)

          await auditLog({
            action: 'function_test_executed',
            suite: suiteName,
            test: test.name,
            result: testResult,
          }, context)
        } catch (error) {
          report.tests_failed++
          report.errors_found++
          suiteResult.tests.push({
            test_name: test.name,
            status: 'error',
            error: error.message,
          })
        }
      }

      report.results.push(suiteResult)
    }

    const duration = Date.now() - startTime
    report.completed_at = new Date().toISOString()
    report.duration_ms = duration

    await auditLog(
      {
        action: 'autonomous_function_tests_complete',
        report,
      },
      context,
    )

    // Extract failed tests for potential repair
    const failedTests = []
    report.results.forEach(suite => {
      if (suite.tests) {
        suite.tests.forEach(test => {
          if (test.status === 'failed' || test.status === 'error' || test.status === 'warning') {
            failedTests.push({
              ...test,
              suite: suite.suite
            })
          }
        })
      }
    })
    report.failed_tests = failedTests

    return report
  } catch (error) {
    await auditLog(
      {
        action: 'autonomous_function_tests_error',
        error: error.message,
      },
      context,
    )
    throw error
  }
}

/**
 * Test all buttons/UI interactions by statically analyzing React component
 * handlers and (optionally) probing the resolved API endpoints with
 * supertest against the in-process Express app.
 *
 * The scan walks `componentPath` (default: frontend/src/components with
 * src/components fallback) for JSX/TSX
 * files, extracts every <Button>/<button>/<IconButton>/etc. with an
 * onClick/onSubmit handler, resolves the handler body, and pulls out the
 * HTTP endpoint references inside it (fetch, axios, api.*, bare `/api/...`
 * string literals).
 *
 * When `probe` is true (or when `context.app` is a supertest-compatible
 * Express app), each detected GET endpoint whose URL is literally known
 * (no template holes) is exercised with supertest and reported pass/fail
 * based on whether the response status is < 500. A 4xx is treated as
 * "endpoint exists but rejected our unauth probe" — still a live wiring.
 */
export async function testButtonFunctionality(options, context) {
  const {
    componentPath = null,
    componentPaths = null,
    probe = true,
  } = options || {}

  const startTime = Date.now()
  const report = {
    started_at: new Date().toISOString(),
    component_path: componentPaths ?? componentPath,
    files_scanned: 0,
    buttons_found: 0,
    buttons_tested: 0,
    buttons_working: 0,
    buttons_failing: 0,
    buttons_unknown: 0,
    endpoints_probed: 0,
    endpoints_ok: 0,
    endpoints_failing: 0,
    results: [],
  }

  await auditLog(
    { action: 'button_functionality_test_start', options },
    context,
  )

  try {
    const requestedPaths = Array.isArray(componentPaths)
      ? componentPaths
      : String(componentPath || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    const candidatePaths = requestedPaths.length > 0
      ? requestedPaths.map((entry) => path.isAbsolute(entry) ? entry : path.resolve(REPO_ROOT, entry))
      : defaultComponentSearchPaths()
    const looked = []
    const rootsWithFiles = []
    report.component_paths = candidatePaths
    const filesByPath = new Map()
    for (const entry of candidatePaths) {
      const root = path.resolve(entry)
      looked.push(root)
      const found = await collectComponentFiles(root)
      if (found.length > 0) rootsWithFiles.push(root)
      for (const file of found) filesByPath.set(file, true)
    }
    const files = Array.from(filesByPath.keys())
    if (files.length === 0) {
      const err = new Error(`No component files found. Looked in: ${looked.join(', ')}`)
      err.status = 400
      throw err
    }
    report.component_path = rootsWithFiles[0] || path.dirname(files[0])
    report.resolved_component_paths = rootsWithFiles
    report.files_scanned = files.length

    // Lazy load supertest + app so static analysis works even when we
    // cannot probe (e.g. running outside of a Node server context).
    let probeFn = null
    if (probe) {
      try {
        const app = context?.app ?? null
        if (app) {
          const { default: request } = await import('supertest')
          probeFn = async (url) => {
            try {
              const res = await request(app).get(url).set('Accept', 'application/json')
              return { status: res.status, ok: res.status < 500 }
            } catch (err) {
              return { status: 0, ok: false, error: err?.message || String(err) }
            }
          }
        }
      } catch (err) {
        report.probe_error = err?.message || String(err)
      }
    }

    for (const file of files) {
      const scan = await scanComponentForButtons(file)
      if (scan.error || !scan.buttons.length) continue
      for (const btn of scan.buttons) {
        report.buttons_found += 1
        const buttonEntry = {
          file: path.relative(process.cwd(), file).replace(/\\/g, '/'),
          line: btn.lineIndex,
          tag: btn.tag,
          label: btn.label,
          handler: btn.handler,
          endpoints: btn.endpoints,
          probe_results: [],
          status: 'unknown',
        }
        if (btn.endpoints.length === 0) {
          // Local-only handlers (navigation, toggles) are not failures.
          buttonEntry.status = btn.handler.has_body ? 'local_only' : 'unresolved'
          report.buttons_unknown += 1
        } else if (!probeFn) {
          buttonEntry.status = 'wired'
          report.buttons_tested += 1
          report.buttons_working += 1
        } else {
          let sawFailure = false
          let probed = 0
          for (const ep of btn.endpoints) {
            if (ep.method !== 'GET') continue
            if (/[`${}]/.test(ep.url)) continue // template literal; skip
            probed += 1
            const probeRes = await probeFn(ep.url)
            report.endpoints_probed += 1
            if (probeRes.ok) report.endpoints_ok += 1
            else {
              report.endpoints_failing += 1
              sawFailure = true
            }
            buttonEntry.probe_results.push({ ...ep, ...probeRes })
          }
          report.buttons_tested += 1
          if (probed === 0) {
            buttonEntry.status = 'wired'
            report.buttons_working += 1
          } else if (sawFailure) {
            buttonEntry.status = 'failing'
            report.buttons_failing += 1
          } else {
            buttonEntry.status = 'working'
            report.buttons_working += 1
          }
        }
        report.results.push(buttonEntry)
      }
    }

    const duration = Date.now() - startTime
    report.completed_at = new Date().toISOString()
    report.duration_ms = duration

    await auditLog(
      { action: 'button_functionality_test_complete', report: summarizeReportForAudit(report) },
      context,
    )

    return report
  } catch (error) {
    await auditLog(
      { action: 'button_functionality_test_error', error: error.message },
      context,
    )
    throw error
  }
}

function summarizeReportForAudit(report) {
  return {
    files_scanned: report.files_scanned,
    buttons_found: report.buttons_found,
    buttons_tested: report.buttons_tested,
    buttons_working: report.buttons_working,
    buttons_failing: report.buttons_failing,
    endpoints_probed: report.endpoints_probed,
    endpoints_failing: report.endpoints_failing,
    duration_ms: report.duration_ms,
  }
}

/**
 * Get status of autonomous function testing operations
 */
export async function getAutonomousFunctionTestsStatus(db = null) {
  // Prefer durable DB audit logs when available.
  if (db) {
    try {
      const row = await db
        .prepare(
          `
            SELECT *
            FROM audit_logs
            WHERE category = ?
              AND action = ?
            ORDER BY created_at DESC
            LIMIT 1
          `,
        )
        .get(AUDIT_CATEGORIES.ANYA, 'autonomous_function_tests.autonomous_function_tests_complete')

      if (!row) {
        return { last_run: null, recent_operations: 0, message: 'No autonomous function testing operations have been run yet' }
      }

      let details = null
      try {
        details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details
      } catch {
        details = row.details ?? null
      }

      return {
        last_run: details?.report ?? details ?? null,
        recent_operations: 1,
        audit_event_id: row.id,
        created_at: row.created_at,
      }
    } catch (error) {
      return { last_run: null, recent_operations: 0, message: error?.message || String(error) }
    }
  }

  // Dev-only filesystem fallback (explicit opt-in).
  if (!isProdEnv() && String(process.env.ALLOW_DEV_FILESYSTEM_AUDIT_LOGS || '').toLowerCase() === 'true') {
    const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
    const logFile = path.join(auditDir, 'autonomous-function-tests.log')
    try {
      const content = await fs.readFile(logFile, 'utf8')
      const lines = content.trim().split('\n').filter(Boolean)
      const recentLogs = lines
        .slice(-30)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch (error) {
            log.debug('[anyaAutonomousFunctionTesting] Failed to parse audit log line:', error.message)
            return null
          }
        })
        .filter(Boolean)

      const lastRun = recentLogs.reverse().find((log) => log.action === 'autonomous_function_tests_complete')
      return {
        last_run: lastRun || null,
        recent_operations: recentLogs.length,
        audit_log_path: path.relative(REPO_ROOT, logFile),
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          last_run: null,
          recent_operations: 0,
          message: 'No autonomous function testing operations have been run yet',
        }
      }
      // Non-ENOENT filesystem errors should still return a valid shape, not undefined.
      console.warn('[anyaAutonomousFunctionTesting] Unexpected error reading dev audit log:', error?.message || error)
      return {
        last_run: null,
        recent_operations: 0,
        message: `Audit log read error: ${error?.message || String(error)}`,
      }
    }
  }

  return { last_run: null, recent_operations: 0, message: 'No autonomous function testing logs available' }
}
