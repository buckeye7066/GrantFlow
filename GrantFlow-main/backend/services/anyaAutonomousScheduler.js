import { runAutonomousCodeCrawl } from './anyaAutonomousCrawler.js'
import { runAutonomousCrawlers } from './anyaAutonomousFunctionRunner.js'
import { runAutonomousFunctionTests } from './anyaAutonomousFunctionTesting.js'
import { repairFailingTests } from './anyaTestRepair.js'
import { promises as fs } from 'fs'
import path from 'path'

const REPO_ROOT = path.resolve(process.cwd())

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
  },
}

/**
 * Log autonomous operations
 */
async function logOperation(operation, status, details = {}) {
  const logDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
  await fs.mkdir(logDir, { recursive: true })
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    operation,
    status,
    ...details,
  }
  
  const logFile = path.join(logDir, 'autonomous-scheduler.log')
  await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n', 'utf8')
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
  
  await logOperation('batch_start', 'started', { trigger })
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
    
    report.completed_at = new Date().toISOString()
    report.status = report.errors.length > 0 ? 'completed_with_errors' : 'success'
    
    await logOperation('batch_complete', report.status, report)
    
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
    await logOperation('batch_error', 'failed', { error: error.message })
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

/**
 * Check if operations should run on schedule
 * This would be called by a cron job or interval timer
 */
export async function checkSchedule(db) {
  if (!AUTONOMOUS_CONFIG.runOnSchedule) {
    return null
  }
  
  // In production, you'd use a proper cron library like node-cron
  // For now, this is a placeholder that could be called periodically
  const hour = new Date().getHours()
  
  // Simple check: run at 3 AM (or configured hour)
  const scheduleHour = parseInt(AUTONOMOUS_CONFIG.schedule.split(' ')[1]) || 3
  
  if (hour === scheduleHour) {
    console.log('[Anya Scheduler] Running scheduled operations...')
    return runAllAutonomousOperations({ db }, 'schedule')
  }
  
  return null
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