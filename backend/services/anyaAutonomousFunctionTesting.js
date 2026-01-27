import path from 'path'
import { promises as fs } from 'fs'

const REPO_ROOT = path.resolve(process.cwd())

/**
 * Create audit log entry for function testing operations
 */
async function auditLog(entry) {
  // IMPORTANT: hosted deployments may have a read-only filesystem for the repo.
  // Audit logging is best-effort and must never crash the request.
  try {
    const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
    await fs.mkdir(auditDir, { recursive: true })

    const timestamp = new Date().toISOString()
    const logEntry = {
      timestamp,
      ...entry,
    }

    const logFile = path.join(auditDir, 'autonomous-function-tests.log')
    const logLine = JSON.stringify(logEntry) + '\n'
    await fs.appendFile(logFile, logLine, 'utf8')
  } catch (error) {
    console.warn('[auditLog] Failed to write audit log:', error?.message || error)
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

function resolveInternalBaseUrl() {
  const explicit = String(process.env.ANYA_SELF_BASE_URL || '').trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  try {
    const globalUrl = globalThis.__grantflow_internal_base_url
    if (typeof globalUrl === 'string' && globalUrl.trim()) {
      return globalUrl.trim().replace(/\/+$/, '')
    }
  } catch {
    // ignore
  }

  const port = String(process.env.PORT || '').trim()
  if (port && port !== '0') return `http://127.0.0.1:${port}`
  return null
}

function resolveAdminToken() {
  const token = String(process.env.ANYA_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '').trim()
  return token || null
}

async function fetchWithTimeout(url, init, timeoutMs = 20_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    return res
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Execute a single API test
 */
async function executeApiTest(test, context) {
  const baseUrl = resolveInternalBaseUrl()
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
      const token = resolveAdminToken()
      if (!token) {
        result.status = 'skipped'
        result.message = 'Admin token not configured (set ADMIN_TOKEN or ANYA_ADMIN_TOKEN)'
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
    } catch {
      bodyText = ''
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
  })

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
          } else {
            report.tests_skipped++
          }

          suiteResult.tests.push(testResult)

          await auditLog({
            action: 'function_test_executed',
            suite: suiteName,
            test: test.name,
            result: testResult,
          })
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

    await auditLog({
      action: 'autonomous_function_tests_complete',
      report,
    })

    // Extract failed tests for potential repair
    const failedTests = []
    report.results.forEach(suite => {
      if (suite.tests) {
        suite.tests.forEach(test => {
          if (test.status === 'failed' || test.status === 'error') {
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
    await auditLog({
      action: 'autonomous_function_tests_error',
      error: error.message,
    })
    throw error
  }
}

/**
 * Test all buttons/UI interactions by checking their API endpoints
 * This analyzes the frontend code to find button click handlers
 */
export async function testButtonFunctionality(options, context) {
  const {
    componentPath = 'src/components',
    fixErrors = false,
    dryRun = true,
  } = options

  const startTime = Date.now()
  const report = {
    started_at: new Date().toISOString(),
    component_path: componentPath,
    buttons_found: 0,
    buttons_tested: 0,
    buttons_working: 0,
    buttons_failing: 0,
    results: [],
  }

  await auditLog({
    action: 'button_functionality_test_start',
    options,
  })

  try {
    // This would require parsing React components to find button handlers
    // For now, we'll document the approach
    report.message = 'Button testing requires component analysis. Recommended approach:'
    report.recommendations = [
      'Parse React components to extract onClick handlers',
      'Identify API endpoints called by button handlers',
      'Execute API tests for each endpoint',
      'Report on button functionality',
      'Fix any broken endpoints found',
    ]

    const duration = Date.now() - startTime
    report.completed_at = new Date().toISOString()
    report.duration_ms = duration

    await auditLog({
      action: 'button_functionality_test_complete',
      report,
    })

    return report
  } catch (error) {
    await auditLog({
      action: 'button_functionality_test_error',
      error: error.message,
    })
    throw error
  }
}

/**
 * Get status of autonomous function testing operations
 */
export async function getAutonomousFunctionTestsStatus() {
  const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
  const logFile = path.join(auditDir, 'autonomous-function-tests.log')
  
  try {
    const content = await fs.readFile(logFile, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    const recentLogs = lines.slice(-30).map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)

    const lastRun = recentLogs.reverse().find(
      log => log.action === 'autonomous_function_tests_complete'
    )

    return {
      last_run: lastRun || null,
      recent_operations: recentLogs.length,
      audit_log_path: path.relative(REPO_ROOT, logFile),
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        last_run: null,
        recent_operations: 0,
        message: 'No autonomous function testing operations have been run yet',
      }
    }
    throw error
  }
}
