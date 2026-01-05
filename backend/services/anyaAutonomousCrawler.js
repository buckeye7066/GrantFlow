import path from 'path'
import { promises as fs } from 'fs'
import { adminCodeCrawl, adminCodeAnalyze, adminCodeEdit } from './anyaAdminTools.js'

const REPO_ROOT = path.resolve(process.cwd())

/**
 * Create audit log entry for autonomous operations
 */
async function auditLog(entry) {
  const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
  await fs.mkdir(auditDir, { recursive: true })
  
  const timestamp = new Date().toISOString()
  const logEntry = {
    timestamp,
    ...entry,
  }
  
  const logFile = path.join(auditDir, 'autonomous-crawler.log')
  const logLine = JSON.stringify(logEntry) + '\n'
  
  try {
    await fs.appendFile(logFile, logLine, 'utf8')
  } catch (error) {
    console.error('[auditLog] Failed to write audit log:', error)
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
 * @param {boolean} options.fixConsoleLog - Fix console.log statements
 * @param {boolean} options.fixEmptyCatch - Fix empty catch blocks
 * @param {boolean} options.fixTodos - Convert TODO comments to tracked issues
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

  const startTime = Date.now()
  const report = {
    started_at: new Date().toISOString(),
    directory: directory || 'entire repository',
    pattern,
    dry_run: dryRun,
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
    dry_run: dryRun,
  })

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
    for (const finding of crawlResult.findings || []) {
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
      let analysisResult
      try {
        analysisResult = await adminCodeAnalyze({ filePath }, context)
      } catch (error) {
        report.errors.push({
          file: filePath,
          type: 'analysis_error',
          message: error.message,
        })
        continue
      }

      // Determine what fixes to apply
      const changes = []
      
      for (const issue of issues) {
        // Fix console.log statements
        if (fixConsoleLog && issue.description === 'console.log statement found') {
          changes.push({
            line: issue.line,
            oldText: 'console.log',
            newText: '// TODO: Remove debug log - console.log',
          })
        }

        // Fix empty catch blocks
        if (fixEmptyCatch && issue.description === 'Empty catch block') {
          changes.push({
            line: issue.line,
            oldText: 'catch (error) {}',
            newText: 'catch (error) { console.error(error) }',
          })
        }
      }

      // Apply changes if any
      if (changes.length > 0) {
        try {
          const editResult = await adminCodeEdit(
            {
              filePath,
              changes,
              save: !dryRun,
            },
            context
          )

          if (editResult.saved || dryRun) {
            report.files_modified++
            report.issues_fixed += changes.length
            report.modifications.push({
              file: filePath,
              changes_count: changes.length,
              backup: editResult.backup_created || null,
              dry_run: dryRun,
            })

            await auditLog({
              action: 'file_modified',
              file: filePath,
              changes_count: changes.length,
              backup: editResult.backup_created,
              dry_run: dryRun,
            })
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
    })

    return report
  } catch (error) {
    await auditLog({
      action: 'autonomous_crawl_error',
      error: error.message,
    })
    throw error
  }
}

/**
 * Get status of autonomous operations
 */
export async function getAutonomousStatus() {
  const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
  const logFile = path.join(auditDir, 'autonomous-crawler.log')
  
  try {
    const content = await fs.readFile(logFile, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    const recentLogs = lines.slice(-20).map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)

    const lastRun = recentLogs.reverse().find(log => log.action === 'autonomous_crawl_complete')

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
        message: 'No autonomous operations have been run yet',
      }
    }
    throw error
  }
}
