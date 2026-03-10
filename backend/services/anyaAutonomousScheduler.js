import { runAutonomousCodeCrawl } from './anyaAutonomousCrawler.js'
import { runAutonomousCrawlers } from './anyaAutonomousFunctionRunner.js'
import { runAutonomousFunctionTests } from './anyaAutonomousFunctionTesting.js'
import { repairFailingTests } from './anyaTestRepair.js'
import { discoverNewCatalogItems } from './itemCatalogService.js'
import { promises as fs } from 'fs'
import path from 'path'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'

const REPO_ROOT = path.resolve(process.cwd())

function isProdEnv() {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase()
  const deployEnv = String(process.env.DEPLOY_ENV || '').toLowerCase()
  return nodeEnv === 'production' || deployEnv === 'production'
}

/**
 * Configuration for autonomous operations
 */
const AUTONOMOUS_CONFIG = {
  // Enable/disable autonomous operations
  enabled: process.env.ANYA_AUTONOMOUS_ENABLED === 'true',
  
  // When to run operations
  runOnStartup: process.env.ANYA_RUN_ON_STARTUP === 'true',
  runOnAdminLogin: process.env.ANYA_RUN_ON_ADMIN_LOGIN === 'true',
  runOnSchedule: process.env.ANYA_RUN_ON_SCHEDULE === 'true',
  
  // What operations to run
  operations: {
    codeCrawl: process.env.ANYA_CODE_CRAWL !== 'false',
    functionTests: process.env.ANYA_FUNCTION_TESTS !== 'false', 
    crawlers: process.env.ANYA_CRAWLERS !== 'false',
    itemDiscovery: process.env.ANYA_ITEM_DISCOVERY !== 'false',
  },
  
  // Schedule (cron-like format)
  schedule: process.env.ANYA_SCHEDULE || '0 3 * * *', // Default: 3 AM daily
  
  // Operation parameters
  params: {
    codeCrawl: {
      fixConsoleLog: process.env.ANYA_FIX_CONSOLE !== 'false',
      fixEmptyCatch: process.env.ANYA_FIX_EMPTY_CATCH !== 'false',
      maxFileChanges: parseInt(process.env.ANYA_MAX_FILE_CHANGES) || 20,
      dryRun: process.env.ANYA_DRY_RUN === 'true',
    },
    crawlers: {
      matchThreshold: parseInt(process.env.ANYA_MATCH_THRESHOLD) || 80,
      saveAllToGlobal: process.env.ANYA_SAVE_GLOBAL !== 'false',
      waitForCompletion: process.env.ANYA_WAIT_COMPLETION === 'true',
    },
    functionTests: {
      fixErrors: process.env.ANYA_FIX_ERRORS === 'true',
      dryRun: process.env.ANYA_DRY_RUN === 'true',
    },
    itemDiscovery: {
      minCount: parseInt(process.env.ANYA_ITEM_DISCOVERY_MIN_COUNT) || 3,
      limit: parseInt(process.env.ANYA_ITEM_DISCOVERY_LIMIT) || 50,
    },
  },
}

/**
 * Log autonomous operations
 */
async function logOperation(operation, status, details = {}, context = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    operation,
    status,
    ...details,
  }

  const db = context?.db
  if (db) {
    try {
      logAuditEvent(db, {
        category: AUDIT_CATEGORIES.ANYA,
        action: `autonomous_scheduler.${String(operation || 'event')}`,
        severity: status === 'failed' ? SEVERITY.ERROR : SEVERITY.INFO,
        userId: context?.user?.userId ?? context?.user?.id ?? null,
        profileId: context?.profile_id ?? context?.profileId ?? null,
        resourceType: 'anya_autonomous_scheduler',
        resourceId: null,
        details: logEntry,
      })
      return
    } catch (error) {
      console.warn('[anyaAutonomousScheduler] audit db write failed:', error?.message || error)
    }
  }

  // Durable fallback: platform logs
  console.log('[audit][autonomous-scheduler]', JSON.stringify(logEntry))

  // Dev-only filesystem sink (explicit opt-in).
  if (!isProdEnv() && String(process.env.ALLOW_DEV_FILESYSTEM_AUDIT_LOGS || '').toLowerCase() === 'true') {
    try {
      const logDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
      await fs.mkdir(logDir, { recursive: true })
      const logFile = path.join(logDir, 'autonomous-scheduler.log')
      await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n', 'utf8')
    } catch {
      // best-effort
    }
  }
}

/**
 * Run all configured autonomous operations
 */
export async function runAllAutonomousOperations(context, trigger = 'manual') {
  if (!AUTONOMOUS_CONFIG.enabled) {
    console.log('[Anya Scheduler] Autonomous operations are disabled')
    return { enabled: false, message: 'Autonomous operations disabled' }
  }
  
  const report = {
    trigger,
    started_at: new Date().toISOString(),
    operations: {},
    errors: [],
  }
  
  await logOperation('batch_start', 'started', { trigger }, context)
  console.log(`[Anya Scheduler] Starting autonomous operations (trigger: ${trigger})`)
  
  try {
    // Phase 1: Code Crawl and Fix
    if (AUTONOMOUS_CONFIG.operations.codeCrawl) {
      console.log('[Anya Scheduler] Phase 1: Running code crawl...')
      try {
        const result = await runAutonomousCodeCrawl(
          AUTONOMOUS_CONFIG.params.codeCrawl,
          context
        )
        report.operations.codeCrawl = {
          status: 'completed',
          files_scanned: result.files_scanned,
          files_modified: result.files_modified,
          issues_fixed: result.issues_fixed,
        }
        console.log(`[Anya Scheduler] Code crawl complete: ${result.files_modified} files modified`)
      } catch (error) {
        report.errors.push({ phase: 'codeCrawl', error: error.message })
        report.operations.codeCrawl = { status: 'failed', error: error.message }
      }
    }
    
    // Phase 2: Function Testing
    if (AUTONOMOUS_CONFIG.operations.functionTests) {
      console.log('[Anya Scheduler] Phase 2: Testing functions...')
      try {
        const result = await runAutonomousFunctionTests(
          AUTONOMOUS_CONFIG.params.functionTests,
          context
        )
        report.operations.functionTests = {
          status: 'completed',
          total_tests: result.total_tests,
          tests_passed: result.tests_passed,
          tests_failed: result.tests_failed,
        }
        console.log(`[Anya Scheduler] Function tests complete: ${result.tests_passed}/${result.total_tests} passed`)
        
        // Phase 2b: Auto-repair failing tests
        if (result.failed_tests && result.failed_tests.length > 0) {
          console.log(`[Anya Scheduler] Phase 2b: Attempting to repair ${result.failed_tests.length} failing tests...`)
          try {
            const repairResult = await repairFailingTests(result.failed_tests, context.db)
            report.operations.testRepair = {
              status: 'completed',
              repaired: repairResult.repaired.length,
              unable_to_repair: repairResult.unable_to_repair.length,
              actions: repairResult.actions_taken
            }
            console.log(`[Anya Scheduler] Test repair complete: ${repairResult.repaired.length}/${result.failed_tests.length} fixed`)
            
            // Re-run tests if any were repaired
            if (repairResult.repaired.length > 0) {
              console.log('[Anya Scheduler] Re-running tests after repairs...')
              const retestResult = await runAutonomousFunctionTests(
                AUTONOMOUS_CONFIG.params.functionTests,
                context
              )
              report.operations.functionTestsAfterRepair = {
                tests_passed: retestResult.tests_passed,
                tests_failed: retestResult.tests_failed,
                improvement: retestResult.tests_passed - result.tests_passed
              }
              console.log(`[Anya Scheduler] After repair: ${retestResult.tests_passed}/${retestResult.total_tests} passing (+${retestResult.tests_passed - result.tests_passed})`)
            }
          } catch (repairError) {
            console.error('[Anya Scheduler] Test repair error:', repairError)
            report.operations.testRepair = { status: 'failed', error: repairError.message }
          }
        }
      } catch (error) {
        report.errors.push({ phase: 'functionTests', error: error.message })
        report.operations.functionTests = { status: 'failed', error: error.message }
      }
    }
    
    // Phase 3: Run Crawlers
    if (AUTONOMOUS_CONFIG.operations.crawlers) {
      console.log('[Anya Scheduler] Phase 3: Running crawlers...')
      try {
        const result = await runAutonomousCrawlers(
          AUTONOMOUS_CONFIG.params.crawlers,
          context
        )
        report.operations.crawlers = {
          status: 'completed',
          profiles_processed: result.profiles_processed,
          jobs_created: result.jobs_created,
          jobs_completed: result.jobs_completed,
        }
        console.log(`[Anya Scheduler] Crawlers complete: ${result.jobs_created} jobs for ${result.profiles_processed} profiles`)
      } catch (error) {
        report.errors.push({ phase: 'crawlers', error: error.message })
        report.operations.crawlers = { status: 'failed', error: error.message }
      }
    }

    // Phase 4: Discover new requestable items (deterministic; uses DB only)
    if (AUTONOMOUS_CONFIG.operations.itemDiscovery) {
      console.log('[Anya Scheduler] Phase 4: Discovering new requestable items...')
      try {
        const result = await discoverNewCatalogItems(context.db, AUTONOMOUS_CONFIG.params.itemDiscovery)
        report.operations.itemDiscovery = {
          status: 'completed',
          inserted: result.inserted ?? 0,
          scanned_opportunities: result.scanned_opportunities ?? null,
          min_count: result.min_count ?? null,
        }
        console.log(`[Anya Scheduler] Item discovery complete: ${result.inserted ?? 0} new items`)
      } catch (error) {
        report.errors.push({ phase: 'itemDiscovery', error: error.message })
        report.operations.itemDiscovery = { status: 'failed', error: error.message }
      }
    }
    
    report.completed_at = new Date().toISOString()
    report.status = report.errors.length > 0 ? 'completed_with_errors' : 'success'
    
    await logOperation('batch_complete', report.status, report, context)
    
    console.log('[Anya Scheduler] ========================================')
    console.log('[Anya Scheduler] AUTONOMOUS OPERATIONS COMPLETE')
    console.log(`[Anya Scheduler] Trigger: ${trigger}`)
    console.log(`[Anya Scheduler] Status: ${report.status}`)
    console.log(`[Anya Scheduler] Errors: ${report.errors.length}`)
    console.log('[Anya Scheduler] ========================================')
    
    return report
  } catch (error) {
    report.status = 'failed'
    report.error = error.message
    await logOperation('batch_error', 'failed', { error: error.message }, context)
    throw error
  }
}

/**
 * Run autonomous operations on server startup
 */
export async function runOnStartup(db) {
  if (!AUTONOMOUS_CONFIG.runOnStartup) {
    console.log('[Anya Scheduler] Startup operations disabled')
    return null
  }
  
  console.log('[Anya Scheduler] Running startup operations...')
  return runAllAutonomousOperations({ db }, 'startup')
}

/**
 * Run autonomous operations on admin login
 */
export async function runOnAdminLogin(db, userId) {
  if (!AUTONOMOUS_CONFIG.runOnAdminLogin) {
    return null
  }
  
  console.log(`[Anya Scheduler] Running operations for admin login: ${userId}`)
  return runAllAutonomousOperations({ db, user: { id: userId, role: 'admin' } }, 'admin_login')
}

let _lastScheduledRunDate = null

/**
 * Check if operations should run on schedule.
 * Called by a setInterval in server.js (every 30 min).
 * Guards against double-execution within the same calendar day.
 */
export async function checkSchedule(db) {
  if (!AUTONOMOUS_CONFIG.runOnSchedule) {
    return null
  }
  
  const now = new Date()
  const hour = now.getHours()
  const scheduleHour = parseInt(AUTONOMOUS_CONFIG.schedule.split(' ')[1]) || 3
  
  if (hour !== scheduleHour) {
    return null
  }

  const today = now.toISOString().slice(0, 10)
  if (_lastScheduledRunDate === today) {
    return null
  }

  _lastScheduledRunDate = today
  console.log('[Anya Scheduler] Running scheduled operations...')
  return runAllAutonomousOperations({ db }, 'schedule')
}

/**
 * In-memory state for admin-triggered background code crawl & repair.
 * Single-instance only; not shared across processes.
 */
const backgroundCodeCrawlState = {
  running: false,
  startedAt: null,
  completedAt: null,
  lastResult: null,
  lastError: null,
}

/**
 * Run only code crawl + function tests + test repair (no crawlers/item discovery).
 * Does not require ANYA_AUTONOMOUS_ENABLED; used for admin-triggered background run.
 */
export async function runCodeCrawlAndRepairOnly(context) {
  const report = {
    trigger: 'background',
    started_at: new Date().toISOString(),
    operations: {},
    errors: [],
  }

  await logOperation('background_code_repair_start', 'started', { trigger: 'background' }, context)

  try {
    if (AUTONOMOUS_CONFIG.operations.codeCrawl) {
      try {
        const result = await runAutonomousCodeCrawl(AUTONOMOUS_CONFIG.params.codeCrawl, context)
        report.operations.codeCrawl = { status: 'completed', files_scanned: result.files_scanned, files_modified: result.files_modified, issues_fixed: result.issues_fixed }
      } catch (error) {
        report.errors.push({ phase: 'codeCrawl', error: error.message })
        report.operations.codeCrawl = { status: 'failed', error: error.message }
      }
    }

    if (AUTONOMOUS_CONFIG.operations.functionTests) {
      try {
        const result = await runAutonomousFunctionTests(AUTONOMOUS_CONFIG.params.functionTests, context)
        report.operations.functionTests = { status: 'completed', total_tests: result.total_tests, tests_passed: result.tests_passed, tests_failed: result.tests_failed }
        if (result.failed_tests && result.failed_tests.length > 0) {
          try {
            const repairResult = await repairFailingTests(result.failed_tests, context.db)
            report.operations.testRepair = { status: 'completed', repaired: repairResult.repaired.length, unable_to_repair: repairResult.unable_to_repair.length }
            if (repairResult.repaired.length > 0) {
              const retestResult = await runAutonomousFunctionTests(AUTONOMOUS_CONFIG.params.functionTests, context)
              report.operations.functionTestsAfterRepair = { tests_passed: retestResult.tests_passed, tests_failed: retestResult.tests_failed }
            }
          } catch (repairError) {
            report.operations.testRepair = { status: 'failed', error: repairError.message }
          }
        }
      } catch (error) {
        report.errors.push({ phase: 'functionTests', error: error.message })
        report.operations.functionTests = { status: 'failed', error: error.message }
      }
    }

    report.completed_at = new Date().toISOString()
    report.status = report.errors.length > 0 ? 'completed_with_errors' : 'success'
    await logOperation('background_code_repair_complete', report.status, report, context)
    return report
  } catch (error) {
    report.status = 'failed'
    report.error = error.message
    await logOperation('background_code_repair_error', 'failed', { error: error.message }, context)
    throw error
  }
}

/**
 * Start code crawl and repair in the background. Returns immediately.
 * Safe to call from HTTP handler; state is updated when the run completes.
 */
export function startBackgroundCodeCrawlAndRepair(context) {
  if (backgroundCodeCrawlState.running) {
    return { queued: false, message: 'A background code crawl & repair is already running.' }
  }
  backgroundCodeCrawlState.running = true
  backgroundCodeCrawlState.startedAt = new Date().toISOString()
  backgroundCodeCrawlState.lastResult = null
  backgroundCodeCrawlState.lastError = null

  runCodeCrawlAndRepairOnly(context)
    .then((result) => {
      backgroundCodeCrawlState.running = false
      backgroundCodeCrawlState.completedAt = new Date().toISOString()
      backgroundCodeCrawlState.lastResult = result
    })
    .catch((err) => {
      backgroundCodeCrawlState.running = false
      backgroundCodeCrawlState.completedAt = new Date().toISOString()
      backgroundCodeCrawlState.lastError = err?.message || String(err)
    })

  return { queued: true, message: 'Code crawl and repair started in the background.' }
}

/**
 * Get current background code crawl & repair state (for status API).
 */
export function getBackgroundCodeCrawlState() {
  return {
    running: backgroundCodeCrawlState.running,
    startedAt: backgroundCodeCrawlState.startedAt,
    completedAt: backgroundCodeCrawlState.completedAt,
    lastResult: backgroundCodeCrawlState.lastResult,
    lastError: backgroundCodeCrawlState.lastError,
  }
}

/**
 * Get current configuration
 */
export function getAutonomousConfig() {
  return AUTONOMOUS_CONFIG
}

/**
 * Update configuration at runtime (admin only)
 */
export function updateAutonomousConfig(updates) {
  Object.keys(updates).forEach(key => {
    if (key in AUTONOMOUS_CONFIG) {
      AUTONOMOUS_CONFIG[key] = updates[key]
    }
  })
  
  return AUTONOMOUS_CONFIG
}