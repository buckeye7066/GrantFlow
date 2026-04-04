import path from 'path'
import { promises as fs } from 'fs'
import { spawn } from 'node:child_process'
import { adminCodeCrawl, adminCodeAnalyze, adminCodeEdit } from './anyaAdminTools.js'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'

const REPO_ROOT = path.resolve(process.cwd())

function runNodeSyntaxCheck(absolutePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', absolutePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      resolve({ ok: false, error: error?.message || String(error) })
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, error: null })
        return
      }
      resolve({ ok: false, error: stderr.trim() || `node --check failed with exit code ${code}` })
    })
  })
}

async function restoreFromBackup({ filePath, backupRelativePath }) {
  if (!backupRelativePath) return { restored: false, reason: 'backup_missing' }
  const targetPath = path.resolve(REPO_ROOT, filePath)
  const backupPath = path.resolve(REPO_ROOT, backupRelativePath)
  const backupContent = await fs.readFile(backupPath, 'utf8')
  await fs.writeFile(targetPath, backupContent, 'utf8')
  return { restored: true, backupPath: backupRelativePath }
}

function isProdEnv() {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase()
  const deployEnv = String(process.env.DEPLOY_ENV || '').toLowerCase()
  return nodeEnv === 'production' || deployEnv === 'production'
}

/**
 * Create audit log entry for autonomous operations
 */
async function auditLog(entry, context) {
  const db = context?.db
  if (db) {
    try {
      await logAuditEvent(db, {
        category: AUDIT_CATEGORIES.ANYA,
        action: `autonomous.${String(entry?.action || 'event')}`,
        severity: SEVERITY.INFO,
        userId: context?.user?.userId ?? context?.user?.id ?? null,
        profileId: context?.profile_id ?? context?.profileId ?? null,
        resourceType: 'anya_autonomous_crawler',
        resourceId: null,
        details: entry ?? null,
        ipAddress: context?.req?.ip ?? null,
        userAgent: context?.req?.headers?.['user-agent'] ?? null,
      })
      return
    } catch (error) {
      // Fall back to file sink below.
      console.warn('[anyaAutonomousCrawler] audit db write failed:', error?.message || error)
    }
  }

  const timestamp = new Date().toISOString()
  const logEntry = { timestamp, ...entry }

  // Durable fallback: platform logs (structured JSON)
  console.log('[audit][autonomous-crawler]', JSON.stringify(logEntry))

  // Dev-only filesystem sink (explicit opt-in).
  if (!isProdEnv() && String(process.env.ALLOW_DEV_FILESYSTEM_AUDIT_LOGS || '').toLowerCase() === 'true') {
    try {
      const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
      await fs.mkdir(auditDir, { recursive: true })
      const logFile = path.join(auditDir, 'autonomous-crawler.log')
      await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n', 'utf8')
    } catch (error) {
      console.warn('[auditLog] Failed to write dev audit log:', error?.message || error)
    }
  }
}

/**
 * Autonomous code crawler that scans, analyzes, and fixes code issues
 * @param {Object} options
 * @param {string} options.directory - Directory to scan (default: entire repo)
 * @param {string} options.pattern - Regex pattern to search for
 * @param {number} options.maxIterations - Maximum number of files to process
 * @param {number} options.maxFileChanges - Maximum number of files to modify
 * @param {boolean} options.dryRun - If true, don't save changes
 * @param {boolean} options.fixConsoleLog - Fix debug console.log statements
 * @param {boolean} options.fixEmptyCatch - Fix empty catch blocks
 * @param {boolean} options.fixTodos - Convert task-marker comments to tracked issues
 * @param {Object} context - Database and user context
 */
export async function runAutonomousCodeCrawl(options, context) {
  const {
    directory = '',
    pattern = null,
    maxIterations = 50,
    maxFileChanges = 20,
    dryRun = false,
    fixConsoleLog = true,
    fixEmptyCatch = false,
    fixTodos = false,
  } = options
  const writesExplicitlyEnabled = String(process.env.ANYA_AUTONOMOUS_WRITE_CHANGES || '').toLowerCase() === 'true'
  const effectiveDryRun = Boolean(dryRun || !writesExplicitlyEnabled)

  const startTime = Date.now()
  const report = {
    started_at: new Date().toISOString(),
    directory: directory || 'entire repository',
    pattern,
    dry_run: effectiveDryRun,
    max_iterations: maxIterations,
    max_file_changes: maxFileChanges,
    files_scanned: 0,
    files_analyzed: 0,
    files_modified: 0,
    issues_found: 0,
    issues_fixed: 0,
    errors: [],
    modifications: [],
  }

  await auditLog({
    action: 'autonomous_crawl_start',
    options,
    dry_run: effectiveDryRun,
    writes_explicitly_enabled: writesExplicitlyEnabled,
  }, context)

  try {
    // Step 1: Crawl codebase for issues
    const crawlResult = await adminCodeCrawl(
      {
        pattern,
        directory,
        includeTests: false,
      },
      context
    )

    report.files_scanned = crawlResult.findings_count || 0
    report.issues_found = crawlResult.findings_count || 0

    // Group findings by file
    const fileIssues = {}
    const findings = Array.isArray(crawlResult?.findings) ? crawlResult.findings : []
    for (const finding of findings) {
      if (!fileIssues[finding.file]) {
        fileIssues[finding.file] = []
      }
      fileIssues[finding.file].push(finding)
    }

    const filesToProcess = Object.keys(fileIssues).slice(0, maxIterations)

    // Step 2: Process each file with issues
    for (const filePath of filesToProcess) {
      if (report.files_modified >= maxFileChanges) {
        report.errors.push({
          type: 'limit_reached',
          message: `Maximum file changes limit (${maxFileChanges}) reached`,
        })
        break
      }

      const issues = fileIssues[filePath]
      report.files_analyzed++

      // Analyze file for detailed issues
      try {
        await adminCodeAnalyze({ filePath }, context)
      } catch (error) {
        report.errors.push({
          file: filePath,
          type: 'analysis_error',
          message: error.message,
        })
        continue
      }

      // Read file content once per file, before processing issues
      let fileContent = ''
      let fileLines = []
      try {
        fileContent = await fs.readFile(path.resolve(REPO_ROOT, filePath), 'utf8')
        fileLines = fileContent.split('\n')
      } catch (readError) {
        report.errors.push({
          file: filePath,
          type: 'read_error',
          message: readError.message,
        })
        continue
      }

      // Determine what fixes to apply
      const changes = []
      const changedLines = new Set()
      const pushUniqueChange = (change) => {
        if (changedLines.has(change.line)) return false
        changedLines.add(change.line)
        changes.push(change)
        return true
      }

      for (const issue of issues) {
        // Fix console.log statements
        if (fixConsoleLog && issue.description === 'console.log statement found') {
          const actualLine = fileLines[issue.line - 1]

          if (actualLine && actualLine.includes('console.log')) {
            pushUniqueChange({
              line: issue.line,
              oldText: actualLine.trim(),
              // Comment-out rather than delete so the original content is preserved in the diff/backup
              newText: `// [autonomous-crawler] removed console.log: ${actualLine.trim()}`,
            })
          }
        }

        // Fix empty catch blocks  
        if (fixEmptyCatch && issue.description.includes('Empty catch block')) {
          const variations = [
            { old: 'catch (error) {}', new: 'catch (error) { console.error("Error:", error) }' },
            { old: 'catch (e) {}', new: 'catch (e) { console.error("Error:", e) }' },
            { old: 'catch (err) {}', new: 'catch (err) { console.error("Error:", err) }' },
            { old: 'catch {}', new: 'catch (error) { console.error("Error:", error) }' },
          ]

          for (const variant of variations) {
            const normalizedPreview = String(issue?.preview || '').replace(/\s+/g, ' ').trim()
            const normalizedOld = variant.old.replace(/\s+/g, ' ').trim()
            if (normalizedPreview.includes(normalizedOld)) {
              pushUniqueChange({
                line: issue.line,
                oldText: variant.old,
                newText: variant.new,
              })
              break
            }
          }
        }
        
        // Convert TODOs to tracked issues (if enabled)
        if (fixTodos && issue.description === 'TODO/FIXME comment') {
          // Log TODO for tracking but don't modify the code
          await auditLog({
            action: 'todo_found',
            file: filePath,
            line: issue.line,
            content: issue.preview,
            tracked: true,
          }, context)
        }
      }

      // Apply changes if any
      if (changes.length > 0) {
        try {
          const editResult = await adminCodeEdit(
            {
              filePath,
              changes,
              save: !effectiveDryRun,
            },
            context
          )

          if (editResult.saved && !effectiveDryRun) {
            const absoluteFilePath = path.resolve(REPO_ROOT, filePath)
            const syntaxCheck = await runNodeSyntaxCheck(absoluteFilePath)
            if (!syntaxCheck.ok) {
              const restoreOutcome = await restoreFromBackup({
                filePath,
                backupRelativePath: editResult.backup_created || null,
              })
              const restoreNote = restoreOutcome.restored
                ? `File restored from backup ${restoreOutcome.backupPath}`
                : 'Failed to restore from backup'
              report.errors.push({
                file: filePath,
                type: 'post_edit_validation_failed',
                message: `Rejected invalid edit: ${syntaxCheck.error}. ${restoreNote}`,
              })
              await auditLog({
                action: 'file_edit_reverted',
                file: filePath,
                reason: 'post_edit_validation_failed',
                validation_error: syntaxCheck.error,
                backup: editResult.backup_created || null,
                restored: restoreOutcome.restored,
              }, context)
              continue
            }
          }

          if (editResult.saved || effectiveDryRun) {
            report.files_modified++
            report.issues_fixed += changes.length
            report.modifications.push({
              file: filePath,
              changes_count: changes.length,
              backup: editResult.backup_created || null,
              dry_run: effectiveDryRun,
            })

            await auditLog({
              action: 'file_modified',
              file: filePath,
              changes_count: changes.length,
              backup: editResult.backup_created,
              dry_run: effectiveDryRun,
            }, context)
          }
        } catch (error) {
          report.errors.push({
            file: filePath,
            type: 'edit_error',
            message: error.message,
          })
        }
      }
    }

    const duration = Date.now() - startTime
    report.completed_at = new Date().toISOString()
    report.duration_ms = duration

    await auditLog({
      action: 'autonomous_crawl_complete',
      report,
    }, context)

    return report
  } catch (error) {
    await auditLog({
      action: 'autonomous_crawl_error',
      error: error.message,
    }, context)
    throw error
  }
}

/**
 * Get status of autonomous operations
 */
export async function getAutonomousStatus(context) {
  // Primary source: database audit log (available in all environments)
  if (context?.db) {
    try {
      const rows = await context.db.all(
        `SELECT details, created_at FROM audit_log
         WHERE resource_type = 'anya_autonomous_crawler'
           AND action LIKE 'autonomous.%'
         ORDER BY created_at DESC
         LIMIT 20`,
      )
      const recentLogs = rows.map(r => {
        try {
          return typeof r.details === 'string' ? JSON.parse(r.details) : r.details
        } catch {
          return null
        }
      }).filter(Boolean)
      const lastRun = recentLogs.find(log => log.action === 'autonomous_crawl_complete')
      return {
        last_run: lastRun || null,
        recent_operations: recentLogs.length,
        source: 'database',
      }
    } catch (dbError) {
      console.warn('[getAutonomousStatus] db query failed, falling back to filesystem:', dbError?.message)
    }
  }

  // Fallback: dev filesystem log
  const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
  const logFile = path.join(auditDir, 'autonomous-crawler.log')

  try {
    const content = await fs.readFile(logFile, 'utf8').catch(() => '')
    const lines = content.trim().split('\n').filter(Boolean)
    const recentLogs = lines.slice(-20).map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)

    const lastRun = recentLogs.slice().reverse().find(log => log.action === 'autonomous_crawl_complete')

    return {
      last_run: lastRun || null,
      recent_operations: recentLogs.length,
      audit_log_path: path.relative(REPO_ROOT, logFile),
      source: 'filesystem',
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        last_run: null,
        recent_operations: 0,
        message: 'No autonomous operations have been run yet',
      }
    }
    throw error
  }
}
