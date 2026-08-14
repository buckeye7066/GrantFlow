import { runAutonomousCodeCrawl } from './anyaAutonomousCrawler.js'
import { runAutonomousCrawlers } from './anyaAutonomousFunctionRunner.js'
import { runAutonomousFunctionTests } from './anyaAutonomousFunctionTesting.js'
import { repairFailingTests } from './anyaTestRepair.js'
import { discoverNewCatalogItems } from './itemCatalogService.js'
import { runPortalCheck, markDeadPortalLinks } from './portalCheckService.js'
import { scheduleAdminGeoCrawlOnLogin } from './adminGeoCrawlOnLogin.js'
import { runMatchScoutForAllActiveProfiles } from './anyaMatchScout.js'
import { promises as fs } from 'fs'
import path from 'path'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('anyaAutonomousScheduler')

const REPO_ROOT = path.resolve(process.cwd())

function isProdEnv() {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase()
  const deployEnv = String(process.env.DEPLOY_ENV || '').toLowerCase()
  return nodeEnv === 'production' || deployEnv === 'production'
}

/**
 * Configuration for autonomous operations.
 *
 * Automation doctrine: agents act, persist, audit, and resume. Operators still
 * choose which scheduled loops run, but Anya code-error repair does not require
 * a second write-permission env gate once the code crawl loop is enabled.
 */
const AUTONOMOUS_CONFIG = {
  // Enable/disable autonomous operations.
  // ON by default (owner directive 2026-06-29). Disable explicitly with
  // ANYA_AUTONOMOUS_ENABLED=false, or flip the persisted Control-Center toggle
  // (agent_settings 'anya.autonomous_enabled'), which is loaded at boot and via
  // setAutonomousEnabled() so it survives restarts.
  enabled: process.env.ANYA_AUTONOMOUS_ENABLED !== 'false',

  // When to run operations.
  runOnStartup: process.env.ANYA_RUN_ON_STARTUP === 'true',     // off: don't hammer every boot
  runOnAdminLogin: process.env.ANYA_RUN_ON_ADMIN_LOGIN === 'true',
  runOnSchedule: process.env.ANYA_RUN_ON_SCHEDULE !== 'false',  // on: the daily autonomous loop

  // What operations to run. The recommend-only + discovery ops default ON so the
  // scheduler does real work; the two CODE-SELF-MODIFICATION ops (codeCrawl,
  // functionTests) stay OFF by default — they edit source / run tests and must
  // be opted into explicitly. matchScout is recommend-only (writes
  // anya_match_suggestions, never auto-adds to pipelines). Operators can mute
  // per-user via user_preferences.custom_preferences.
  operations: {
    codeCrawl: process.env.ANYA_CODE_CRAWL === 'true',          // opt-in (edits source)
    functionTests: process.env.ANYA_FUNCTION_TESTS === 'true',  // opt-in (runs tests)
    crawlers: process.env.ANYA_CRAWLERS !== 'false',
    itemDiscovery: process.env.ANYA_ITEM_DISCOVERY !== 'false',
    portalChecks: process.env.ANYA_PORTAL_CHECKS !== 'false',
    geoCrawl: process.env.ANYA_GEO_CRAWL !== 'false',
    matchScout: process.env.ANYA_MATCH_SCOUT !== 'false',
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
      // matchThreshold is intentionally removed from the scheduler config.
      // Pre-filtering by score before computeMatchDecision() runs violates
      // Goal 4 (single decision authority) and Goal 7 (recall over suppression).
      // The canonical decision engine in matchEngine.js is the sole gating authority.
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
  log.info('[audit][autonomous-scheduler]', JSON.stringify(logEntry))

  // Dev-only filesystem sink (explicit opt-in).
  if (!isProdEnv() && String(process.env.ALLOW_DEV_FILESYSTEM_AUDIT_LOGS || '').toLowerCase() === 'true') {
    try {
      const logDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
      await fs.mkdir(logDir, { recursive: true })
      const logFile = path.join(logDir, 'autonomous-scheduler.log')
      await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n', 'utf8')
    } catch (error) {
      console.warn('[anyaAutonomousScheduler] Failed to write dev audit log:', error?.message)
    }
  }
}

/**
 * Run all configured autonomous operations
 */
export async function runAllAutonomousOperations(context, trigger = 'manual') {
  if (!AUTONOMOUS_CONFIG.enabled) {
    log.info('[Anya Scheduler] Autonomous operations are disabled')
    return { enabled: false, message: 'Autonomous operations disabled' }
  }
  
  const report = {
    trigger,
    started_at: new Date().toISOString(),
    operations: {},
    errors: [],
  }
  
  await logOperation('batch_start', 'started', { trigger }, context)
  log.info(`[Anya Scheduler] Starting autonomous operations (trigger: ${trigger})`)
  
  try {
    // Phase 1: Code Crawl and Fix
    if (AUTONOMOUS_CONFIG.operations.codeCrawl) {
      log.info('[Anya Scheduler] Phase 1: Running code crawl...')
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
        log.info(`[Anya Scheduler] Code crawl complete: ${result.files_modified} files modified`)
      } catch (error) {
        report.errors.push({ phase: 'codeCrawl', error: error.message })
        report.operations.codeCrawl = { status: 'failed', error: error.message }
      }
    }
    
    // Phase 2: Function Testing
    if (AUTONOMOUS_CONFIG.operations.functionTests) {
      log.info('[Anya Scheduler] Phase 2: Testing functions...')
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
        log.info(`[Anya Scheduler] Function tests complete: ${result.tests_passed}/${result.total_tests} passed`)
        
        // Phase 2b: Auto-repair failing tests
        if (result.failed_tests && result.failed_tests.length > 0) {
          log.info(`[Anya Scheduler] Phase 2b: Attempting to repair ${result.failed_tests.length} failing tests...`)
          try {
            const repairResult = await repairFailingTests(result.failed_tests, context.db)
            report.operations.testRepair = {
              status: 'completed',
              repaired: repairResult.repaired.length,
              unable_to_repair: repairResult.unable_to_repair.length,
              actions: repairResult.actions_taken
            }
            log.info(`[Anya Scheduler] Test repair complete: ${repairResult.repaired.length}/${result.failed_tests.length} fixed`)
            
            // Re-run tests if any were repaired
            if (repairResult.repaired.length > 0) {
              log.info('[Anya Scheduler] Re-running tests after repairs...')
              const retestResult = await runAutonomousFunctionTests(
                AUTONOMOUS_CONFIG.params.functionTests,
                context
              )
              report.operations.functionTestsAfterRepair = {
                tests_passed: retestResult.tests_passed,
                tests_failed: retestResult.tests_failed,
                improvement: retestResult.tests_passed - result.tests_passed
              }
              log.info(`[Anya Scheduler] After repair: ${retestResult.tests_passed}/${retestResult.total_tests} passing (+${retestResult.tests_passed - result.tests_passed})`)
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
      log.info('[Anya Scheduler] Phase 3: Running crawlers...')
      try {
        const crawlerProfileId = context?.profileId ?? context?.profile_id ?? null
        const contextProfileIds = Array.isArray(context?.profileIds)
          ? context.profileIds.filter(Boolean).map(String)
          : []
        const crawlerProfileIds = contextProfileIds.length > 0
          ? contextProfileIds
          : crawlerProfileId
            ? [String(crawlerProfileId)]
            : null

        if (crawlerProfileIds) {
          log.info(`[Anya Scheduler] Phase 3: Crawler OS scoped to ${crawlerProfileIds.length} profile${crawlerProfileIds.length === 1 ? '' : 's'}`)
        } else {
          log.info('[Anya Scheduler] Phase 3: Crawler OS will process active profiles one profile at a time')
        }

        if (process.env.ANYA_LEGACY_CRAWLER_CONTEXT_WARNING === '1') {
          console.warn(
            '[Anya Scheduler] Phase 3 legacy warning requested; Crawler OS scope=' +
              (crawlerProfileIds ? crawlerProfileIds.join(',') : 'all_active_profiles'),
          )
        }

        const crawlerParams = {
          ...AUTONOMOUS_CONFIG.params.crawlers,
          profileIds: crawlerProfileIds,
        }
        const result = await runAutonomousCrawlers(crawlerParams, context)
        report.operations.crawlers = {
          // A fleet sweep can be refused by admission control (another sweep is
          // already running, or one just ran) — that is a SKIP, never a
          // "completed" run of zero profiles. Reporting it honestly keeps the
          // morning report from claiming work that did not happen.
          status: result?.skipped ? 'skipped' : 'completed',
          ...(result?.skipped ? { skipped_reason: result.skipped_reason } : {}),
          profiles_processed: result.profiles_processed,
          jobs_created: result.jobs_created,
          jobs_completed: result.jobs_completed,
        }
        if (result?.skipped) {
          log.info(`[Anya Scheduler] Crawlers skipped: ${result.skipped_reason}`)
        } else {
          log.info(`[Anya Scheduler] Crawlers complete: ${result.jobs_created} jobs for ${result.profiles_processed} profiles`)
        }
      } catch (error) {
        report.errors.push({ phase: 'crawlers', error: error.message })
        report.operations.crawlers = { status: 'failed', error: error.message }
      }
    }

    // Phase 4: Discover new requestable items (deterministic; uses DB only)
    if (AUTONOMOUS_CONFIG.operations.itemDiscovery) {
      log.info('[Anya Scheduler] Phase 4: Discovering new requestable items...')
      try {
        const result = await discoverNewCatalogItems(context.db, AUTONOMOUS_CONFIG.params.itemDiscovery)
        report.operations.itemDiscovery = {
          status: 'completed',
          inserted: result.inserted ?? 0,
          scanned_opportunities: result.scanned_opportunities ?? null,
          min_count: result.min_count ?? null,
        }
        log.info(`[Anya Scheduler] Item discovery complete: ${result.inserted ?? 0} new items`)
      } catch (error) {
        report.errors.push({ phase: 'itemDiscovery', error: error.message })
        report.operations.itemDiscovery = { status: 'failed', error: error.message }
      }
    }

    // Phase 5: Portal check-in for student profiles
    if (AUTONOMOUS_CONFIG.operations.portalChecks && context.db) {
      log.info('[Anya Scheduler] Phase 5: Running portal checks for student profiles...')
      try {
        // Student primary_type values — mirrors the list used in autoDiscoveryCrawlers.js
        // and grants.js. No shared constant exists; keep in sync if new student types are added.
        // Portal checks apply to all active profiles, not only students.
        // Restricting to student types violates Goal 6 (serve all applicant types).
        const eligibleProfiles = await context.db
          .prepare(
            `SELECT id FROM profiles WHERE status = 'active'`,
          )
          .all()

        let portalChecksTotal = 0
        let portalAwardsTotal = 0
        let deadPortalsMarkedTotal = 0

        for (const profile of eligibleProfiles) {
          try {
            const result = await runPortalCheck(context.db, profile.id, { checkType: 'scheduled' })
            portalChecksTotal += result.portalsChecked ?? 0
            portalAwardsTotal += result.awardsDetected ?? 0
            // dead_portal_link_status_persisted: a portal this nightly check
            // found unreachable used to be reported in publicSignals and then
            // discarded — nothing ever wrote a link_status, so a known-dead
            // portal kept resurfacing every night.
            try {
              const deadPortalStats = await markDeadPortalLinks(context.db, result.publicSignals, {
                verifiedBy: 'anya-portal-check-scheduler',
              })
              deadPortalsMarkedTotal += deadPortalStats.marked ?? 0
            } catch (deadPortalErr) {
              console.warn(`[Anya Scheduler] Dead-portal marking failed for profile ${profile.id}:`, deadPortalErr?.message)
            }
          } catch (profileErr) {
            console.warn(`[Anya Scheduler] Portal check failed for profile ${profile.id}:`, profileErr?.message)
          }
        }

        report.operations.portalChecks = {
          status: 'completed',
          profiles_checked: eligibleProfiles.length,
          portals_checked: portalChecksTotal,
          awards_detected: portalAwardsTotal,
          dead_portals_marked: deadPortalsMarkedTotal,
        }
        log.info(`[Anya Scheduler] Portal checks complete: ${portalAwardsTotal} awards detected, ${deadPortalsMarkedTotal} dead portal(s) marked, across ${portalChecksTotal} portals for ${eligibleProfiles.length} profiles`)
      } catch (error) {
        report.errors.push({ phase: 'portalChecks', error: error.message })
        report.operations.portalChecks = { status: 'failed', error: error.message }
      }
    }

    // Phase 6: Geo crawl — progressively discover funding sources across all US ZIP codes.
    // Each run resumes from the last checkpoint, so over successive daily runs all ~43k ZIPs
    // get covered without any single run needing to process them all.
    if (AUTONOMOUS_CONFIG.operations.geoCrawl && context.db) {
      log.info('[Anya Scheduler] Phase 6: Scheduling resumable geo crawl...')
      try {
        const result = await scheduleAdminGeoCrawlOnLogin(
          context.db,
          { role: 'admin', is_admin: true, id: context.user?.id ?? 'anya_scheduler' },
          {},
        )
        report.operations.geoCrawl = {
          status: result.scheduled ? 'scheduled' : 'skipped',
          reason: result.reason ?? null,
          job_id: result.job_id ?? null,
          run_id: result.run_id ?? null,
        }
        log.info(`[Anya Scheduler] Geo crawl: ${result.scheduled ? 'scheduled job=' + result.job_id : 'skipped (' + result.reason + ')'}`)
      } catch (error) {
        report.errors.push({ phase: 'geoCrawl', error: error.message })
        report.operations.geoCrawl = { status: 'failed', error: error.message }
      }
    }

    // Phase 7: Anya Match Scout — recommend-only background scan that
    // surfaces high-confidence (>=ANYA_MATCH_SCOUT_THRESHOLD, whose default is
    // the canonical data-point-scale strong-match bar)
    // matches per profile as pending suggestions + notifications. NEVER
    // auto-adds to pipelines. Honors the per-user mute preference.
    if (AUTONOMOUS_CONFIG.operations.matchScout && context.db) {
      log.info('[Anya Scheduler] Phase 7: Running Anya Match Scout across all active profiles...')
      try {
        const result = await runMatchScoutForAllActiveProfiles(context.db)
        report.operations.matchScout = {
          status: 'completed',
          profiles_scanned: result.profiles_scanned,
          profiles_with_suggestions: result.profiles_with_suggestions,
          suggestions_created: result.suggestions_created,
          notifications_created: result.notifications_created,
        }
        log.info(
          `[Anya Scheduler] Match Scout complete: ${result.suggestions_created} suggestions created across ${result.profiles_with_suggestions}/${result.profiles_scanned} profiles`,
        )
      } catch (error) {
        report.errors.push({ phase: 'matchScout', error: error.message })
        report.operations.matchScout = { status: 'failed', error: error.message }
      }
    }

    report.completed_at = new Date().toISOString()
    report.status = report.errors.length > 0 ? 'completed_with_errors' : 'success'
    
    await logOperation('batch_complete', report.status, report, context)
    
    log.info('[Anya Scheduler] ========================================')
    log.info('[Anya Scheduler] AUTONOMOUS OPERATIONS COMPLETE')
    log.info(`[Anya Scheduler] Trigger: ${trigger}`)
    log.info(`[Anya Scheduler] Status: ${report.status}`)
    log.info(`[Anya Scheduler] Errors: ${report.errors.length}`)
    for (const err of report.errors) {
      console.warn(`[Anya Scheduler]   → ${err.phase}: ${err.error}`)
    }
    log.info('[Anya Scheduler] ========================================')
    
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
    log.info('[Anya Scheduler] Startup operations disabled')
    return null
  }
  
  log.info('[Anya Scheduler] Running startup operations...')
  return runAllAutonomousOperations({ db, user: { id: 'system', role: 'admin', is_admin: true } }, 'startup')
}

let _adminLoginRunInProgress = false

/**
 * Run autonomous operations on admin login (with concurrency guard)
 */
export async function runOnAdminLogin(db, userId) {
  if (!AUTONOMOUS_CONFIG.runOnAdminLogin) {
    return null
  }
  if (_adminLoginRunInProgress) {
    log.info('[Anya Scheduler] Admin login ops already in progress, skipping')
    return null
  }
  
  _adminLoginRunInProgress = true
  log.info(`[Anya Scheduler] Running operations for admin login: ${userId}`)
  try {
    return await runAllAutonomousOperations({ db, user: { id: userId, role: 'admin' } }, 'admin_login')
  } finally {
    _adminLoginRunInProgress = false
  }
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

  log.info('[Anya Scheduler] Running scheduled operations...')
  try {
    const result = await runAllAutonomousOperations({ db, user: { id: 'system', role: 'admin', is_admin: true } }, 'schedule')
    _lastScheduledRunDate = today
    return result
  } catch (err) {
    console.error('[Anya Scheduler] Scheduled run failed:', err.message)
    return null
  }
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
      backgroundCodeCrawlState.lastResult = result
    })
    .catch((err) => {
      backgroundCodeCrawlState.lastError = err?.message || String(err)
    })
    .finally(() => {
      backgroundCodeCrawlState.running = false
      backgroundCodeCrawlState.completedAt = new Date().toISOString()
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
 * In-memory state for admin-triggered background crawler runs.
 * Single-instance only; not shared across processes. Mirrors
 * backgroundCodeCrawlState above.
 */
const backgroundCrawlerRunState = {
  running: false,
  startedAt: null,
  completedAt: null,
  lastResult: null,
  lastError: null,
}

/**
 * Start an autonomous crawler run (Crawler OS, per active/scoped profile) in
 * the background. Returns immediately; state is updated when the run
 * completes. Safe to call from an HTTP handler.
 *
 * BUG FIX (2026-07-20): POST /api/anya/autonomous/crawlers used to `await`
 * runAutonomousCrawlers() directly inside the route handler. That function
 * now drives the Crawler OS synchronously, one real profile at a time
 * (fetch + reality-gate + match per source, no batching) — at current
 * profile counts this routinely exceeds Railway/Vercel's proxy timeout and
 * the owner-facing button 504s even though the run itself eventually
 * succeeds server-side. Fire-and-forget here, exactly like
 * startBackgroundCodeCrawlAndRepair above; the caller polls
 * admin.anya.getStatus for progress/result.
 */
export function startBackgroundCrawlerRun(options, context) {
  if (backgroundCrawlerRunState.running) {
    return { queued: false, message: 'A background crawler run is already in progress.' }
  }
  backgroundCrawlerRunState.running = true
  backgroundCrawlerRunState.startedAt = new Date().toISOString()
  backgroundCrawlerRunState.lastResult = null
  backgroundCrawlerRunState.lastError = null

  runAutonomousCrawlers(options, context)
    .then((result) => {
      backgroundCrawlerRunState.lastResult = result
    })
    .catch((err) => {
      backgroundCrawlerRunState.lastError = err?.message || String(err)
    })
    .finally(() => {
      backgroundCrawlerRunState.running = false
      backgroundCrawlerRunState.completedAt = new Date().toISOString()
    })

  return { queued: true, message: 'Autonomous crawler run started in the background.' }
}

/**
 * Get current background crawler run state (for status API).
 */
export function getBackgroundCrawlerRunState() {
  return {
    running: backgroundCrawlerRunState.running,
    startedAt: backgroundCrawlerRunState.startedAt,
    completedAt: backgroundCrawlerRunState.completedAt,
    lastResult: backgroundCrawlerRunState.lastResult,
    lastError: backgroundCrawlerRunState.lastError,
  }
}

/**
 * Get current configuration
 */
export function getAutonomousConfig() {
  return AUTONOMOUS_CONFIG
}

/** Is the autonomous scheduler currently enabled (master switch)? */
export function isAutonomousEnabled() {
  return AUTONOMOUS_CONFIG.enabled === true
}

/**
 * Set the master enabled switch at runtime. Persistence (so it survives
 * restarts) is the caller's job — the Control-Center toggle endpoint writes the
 * `anya.autonomous_enabled` agent_setting AND calls this; boot reads that
 * setting and calls this to seed the in-memory config.
 */
export function setAutonomousEnabled(enabled) {
  AUTONOMOUS_CONFIG.enabled = Boolean(enabled)
  return AUTONOMOUS_CONFIG.enabled
}

/**
 * Update configuration at runtime (admin only)
 */
const BLOCKED_CONFIG_KEYS = new Set(['matchThreshold'])

export function updateAutonomousConfig(updates) {
  Object.keys(updates).forEach(key => {
    if (key in AUTONOMOUS_CONFIG) {
      if (BLOCKED_CONFIG_KEYS.has(key)) {
        console.warn(
          `[anyaAutonomousScheduler] updateAutonomousConfig: refusing blocked key "${key}" ` +
          '— pre-filter thresholds must not override computeMatchDecision() (Goals 4, 7)'
        )
        return
      }
      // Only allow shallow merges on the nested objects (params, operations)
      // to prevent full replacement of sub-trees.
      if (
        key === 'params' || key === 'operations'
      ) {
        if (updates[key] !== null && typeof updates[key] === 'object' && !Array.isArray(updates[key])) {
          Object.keys(updates[key]).forEach(subKey => {
            if (key === 'params' && subKey in AUTONOMOUS_CONFIG.params) {
              if (AUTONOMOUS_CONFIG.params[subKey] !== null && typeof AUTONOMOUS_CONFIG.params[subKey] === 'object') {
                Object.assign(AUTONOMOUS_CONFIG.params[subKey], updates[key][subKey])
              } else {
                AUTONOMOUS_CONFIG.params[subKey] = updates[key][subKey]
              }
            } else if (key === 'operations' && subKey in AUTONOMOUS_CONFIG.operations) {
              AUTONOMOUS_CONFIG.operations[subKey] = updates[key][subKey]
            }
          })
        }
        return
      }
      AUTONOMOUS_CONFIG[key] = updates[key]
    }
  })

  return AUTONOMOUS_CONFIG
}
