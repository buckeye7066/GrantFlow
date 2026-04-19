import path from 'path'
import { promises as fs } from 'fs'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'

const REPO_ROOT = path.resolve(process.cwd())

// ---------------------------------------------------------------------------
// Self-contained audit engine
// No fabricated metrics: every counter below is tied to a real file-system
// action or a real regex match.  Never returns "dry run" without explanation.
//
// Metric contract (honest, non-overlapping meanings):
//   files_discovered    = # file *entries* walk() encountered (pre-filter)
//   files_scanned       = # files that matched the text-file filter and were
//                         read + byte-scanned into memory
//   files_analyzed      = # files whose content was handed to
//                         analyzeFileContent() (equal to files_scanned here
//                         unless a read failed)
//   files_with_findings = # analyzed files that produced >= 1 issue
//   findings_found      = sum(fileIssues.length) across analyzed files
//                         -- THIS IS THE CANONICAL ISSUE COUNT
//   files_modified      = # files that received at least one applied fix
//                         (including dry-run planned fixes)
//   issues_fixed        = sum(modification.changes_count) across modifications
//
//   dry_run_requested     = boolean from the caller's options (pre-gate)
//   writes_explicitly_enabled = env ANYA_AUTONOMOUS_WRITE_CHANGES === 'true'
//   dry_run_effective     = what actually happened (final)
//   dry_run_forced_by_env = true iff the caller asked for writes but the env
//                           gate vetoed them
//
// Legacy back-compat (kept so scheduler + older dashboards don't break):
//   dry_run               = dry_run_effective (same value)
//   issues_found          = findings_found (same value)
//
// NOTE on adminCodeCrawl (services/anyaAdminTools.js): the OLD implementation
// proxied to adminCodeCrawl and did files_scanned = findings_count, which was
// the root of the "6014 issues found" inflation (findings are per-line
// pattern matches, not files). adminCodeCrawl returns:
//   { findings: [{ file, line, severity, description, preview, fix? }, ...],
//     findings_count: number }
// If anyone ever re-integrates adminCodeCrawl, the CORRECT mapping is:
//   findings_found      <= adminCodeCrawl.findings_count
//   files_with_findings <= unique(adminCodeCrawl.findings[].file).length
//   files_scanned       <= a separate walk count; NEVER findings_count
// This module does not depend on adminCodeCrawl to avoid that whole class of
// count-confusion.
// ---------------------------------------------------------------------------

const TEXT_FILE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.json', '.md', '.css', '.scss', '.html',
  '.yml', '.yaml', '.env', '.sh', '.sql',
])

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.turbo',
  'coverage', '.cache', '.idea', '.vscode', '.vercel', '.railway',
  'audit-reports',
])

const ISSUE_TYPES = {
  PLACEHOLDER_LOGIC: 'placeholder_logic',
  MOCK_DATA: 'mock_data',
  DRY_RUN_STUB: 'dry_run_stub',
  TODO_FIXME: 'todo_fixme',
  SILENT_CATCH: 'silent_catch',
  CONSOLE_NOISE: 'console_noise',
  EMPTY_CATCH: 'empty_catch',
}

function isProbablyTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (TEXT_FILE_EXTENSIONS.has(ext)) return true
  const base = path.basename(filePath).toLowerCase()
  if (base === 'dockerfile') return true
  if (base.startsWith('.env')) return true
  return false
}

async function listFilesRecursive(rootDir) {
  // Returns { files, discoveredCount, skippedNonText, skippedIgnoredDirs }
  // so the caller can distinguish between "what we saw on disk" (discovered)
  // and "what we actually scanned" (post text-file filter).
  const files = []
  let discoveredCount = 0
  let skippedNonText = 0
  let skippedIgnoredDirs = 0

  async function walk(current) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) {
          skippedIgnoredDirs++
          continue
        }
        await walk(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      discoveredCount++
      if (!isProbablyTextFile(fullPath)) {
        skippedNonText++
        continue
      }
      files.push(fullPath)
    }
  }
  await walk(rootDir)
  return { files, discoveredCount, skippedNonText, skippedIgnoredDirs }
}

function relativeTo(rootDir, filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, '/')
}

function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex')
}

function countLines(text) {
  if (!text) return 0
  return text.split(/\r?\n/).length
}

function buildUnifiedDiff(oldText, newText, fileRelPath) {
  if (oldText === newText) return null
  const oldLines = oldText.split(/\r?\n/)
  const newLines = newText.split(/\r?\n/)

  const maxContext = 2
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++

  let oldEnd = oldLines.length - 1
  let newEnd = newLines.length - 1
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--
    newEnd--
  }

  const oldStart = Math.max(0, start - maxContext)
  const newStart = Math.max(0, start - maxContext)
  const oldChunk = oldLines.slice(oldStart, oldEnd + 1 + maxContext)
  const newChunk = newLines.slice(newStart, newEnd + 1 + maxContext)

  const diffLines = [
    `--- a/${fileRelPath}`,
    `+++ b/${fileRelPath}`,
    `@@ -${oldStart + 1},${oldChunk.length} +${newStart + 1},${newChunk.length} @@`,
  ]
  const maxLen = Math.max(oldChunk.length, newChunk.length)
  for (let i = 0; i < maxLen; i++) {
    const o = oldChunk[i]
    const n = newChunk[i]
    if (o === n && o !== undefined) diffLines.push(` ${o}`)
    else {
      if (o !== undefined) diffLines.push(`-${o}`)
      if (n !== undefined) diffLines.push(`+${n}`)
    }
  }
  return diffLines.join('\n')
}

const AUDIT_PATTERNS = [
  {
    type: ISSUE_TYPES.TODO_FIXME,
    regex: /\b(TODO|FIXME|HACK|XXX)\b/,
    message: 'Unresolved engineering marker.',
    severity: 'medium',
    fixable: false,
  },
  {
    type: ISSUE_TYPES.PLACEHOLDER_LOGIC,
    regex: /\b(placeholder|stubbed|mock response|fake data|dummy data)\b/i,
    message: 'Possible placeholder or incomplete production logic.',
    severity: 'high',
    fixable: false,
  },
  {
    type: ISSUE_TYPES.MOCK_DATA,
    regex: /\b(mockData|fakeData|sampleData|demoData)\b/,
    message: 'Possible mock/demo data leaking into production code.',
    severity: 'high',
    fixable: false,
  },
  {
    type: ISSUE_TYPES.DRY_RUN_STUB,
    regex: /\b(files_scanned\s*:\s*.+issues_found\s*:|issues_found\s*=\s*files_scanned)\b/i,
    message: 'Suspicious metric relationship; may be placeholder telemetry.',
    severity: 'high',
    fixable: false,
  },
  {
    type: ISSUE_TYPES.SILENT_CATCH,
    regex: /^\s*catch\s*\((.*?)\)\s*\{\s*\}\s*$/,
    message: 'Silent catch block hides failures.',
    severity: 'high',
    fixable: true,
  },
  {
    type: ISSUE_TYPES.EMPTY_CATCH,
    regex: /^\s*catch\s*\{\s*\}\s*$/,
    message: 'Empty catch block (no error binding).',
    severity: 'high',
    fixable: true,
  },
  {
    type: ISSUE_TYPES.CONSOLE_NOISE,
    regex: /\bconsole\.(log|debug)\(/,
    message: 'Console logging detected in likely application code.',
    severity: 'low',
    fixable: false,
  },
]

function analyzeFileContent(content) {
  const issues = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const pattern of AUDIT_PATTERNS) {
      if (pattern.regex.test(line)) {
        issues.push({
          line: i + 1,
          type: pattern.type,
          severity: pattern.severity,
          message: pattern.message,
          excerpt: line.trim().slice(0, 220),
          fixable: pattern.fixable,
        })
      }
    }
  }
  return issues
}

function applySafeFixes(oldText, { fixEmptyCatch = true, fixConsoleLog = false } = {}) {
  let newText = oldText
  const fixesApplied = []
  let changed = false

  if (fixEmptyCatch) {
    const silentCatchRegex = /^(\s*)catch\s*\(([^)]*?)\)\s*\{\s*\}\s*$/gm
    newText = newText.replace(silentCatchRegex, (match, indent, errVar) => {
      const e = (errVar || '').trim() || 'err'
      changed = true
      fixesApplied.push({
        kind: 'replace_silent_catch',
        message: 'Replaced silent catch block with explicit logging + rethrow.',
      })
      return `${indent}catch (${e}) {\n${indent}  console.error('[AnyaAudit] Suppressed error made explicit:', ${e});\n${indent}  throw ${e};\n${indent}}`
    })

    const bareCatchRegex = /^(\s*)catch\s*\{\s*\}\s*$/gm
    newText = newText.replace(bareCatchRegex, (match, indent) => {
      changed = true
      fixesApplied.push({
        kind: 'replace_bare_catch',
        message: 'Replaced bare empty catch with explicit logging + rethrow.',
      })
      return `${indent}catch (err) {\n${indent}  console.error('[AnyaAudit] Suppressed error made explicit:', err);\n${indent}  throw err;\n${indent}}`
    })
  }

  if (fixConsoleLog) {
    const consoleLogRegex = /^(\s*)(console\.(log|debug)\([^\n]*\);?)$/gm
    newText = newText.replace(consoleLogRegex, (match, indent, call) => {
      changed = true
      fixesApplied.push({
        kind: 'comment_out_console',
        message: 'Commented out console.log/debug statement.',
      })
      return `${indent}// [AnyaAudit] ${call}`
    })
  }

  return { changed, newText, fixesApplied }
}

async function writeAuditReport(rootDir, report) {
  const auditDir = path.join(rootDir, 'audit-reports')
  await fs.mkdir(auditDir, { recursive: true })
  const filename = `anya-audit-${Date.now()}.json`
  const fullPath = path.join(auditDir, filename)
  await fs.writeFile(fullPath, JSON.stringify(report, null, 2), 'utf8')
  return relativeTo(rootDir, fullPath)
}

async function backupFile(filePath, content) {
  const backupPath = `${filePath}.bak.${Date.now()}`
  await fs.writeFile(backupPath, content, 'utf8')
  return backupPath
}

function summarizeIssuesByType(allIssues) {
  const map = new Map()
  for (const fileRecord of allIssues) {
    for (const issue of fileRecord.issues) {
      const key = issue.type
      const current = map.get(key) || { type: key, count: 0, severityCounts: {} }
      current.count++
      current.severityCounts[issue.severity] = (current.severityCounts[issue.severity] || 0) + 1
      map.set(key, current)
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count)
}

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
    fixConsoleLog = false,
    fixEmptyCatch = true,
    fixTodos = false,
  } = options || {}

  const dryRunRequested = Boolean(dryRun)
  const writesExplicitlyEnabled = String(process.env.ANYA_AUTONOMOUS_WRITE_CHANGES || '').toLowerCase() === 'true'
  const effectiveDryRun = dryRunRequested || !writesExplicitlyEnabled
  // dry_run_forced_by_env: caller asked for writes (dryRunRequested=false) but
  // the env safety gate vetoed them, so we're running effectively dry.
  const dryRunForcedByEnv = !dryRunRequested && !writesExplicitlyEnabled

  // Resolve per call so tests that chdir() into a temp dir work, and so that
  // absolute directory arguments are honored as-is.
  const cwd = process.cwd()
  const rootDir = directory
    ? (path.isAbsolute(directory) ? directory : path.resolve(cwd, directory))
    : cwd

  const startedAtIso = new Date().toISOString()
  const startTime = Date.now()

  await auditLog({
    action: 'autonomous_crawl_start',
    options: { directory, pattern, maxIterations, maxFileChanges, dryRun: dryRunRequested, fixConsoleLog, fixEmptyCatch, fixTodos },
    dry_run_requested: dryRunRequested,
    dry_run_effective: effectiveDryRun,
    dry_run_forced_by_env: dryRunForcedByEnv,
    writes_explicitly_enabled: writesExplicitlyEnabled,
  }, context)

  const allIssues = []
  const modifications = []
  const errors = []
  let iterations = 0
  let filesAnalyzed = 0
  let filesModified = 0
  let findingsFound = 0
  let issuesFixed = 0

  try {
    const walk = await listFilesRecursive(rootDir)
    const allFiles = walk.files
    const filesDiscovered = walk.discoveredCount

    const filteredFiles = pattern
      ? allFiles.filter((f) => relativeTo(rootDir, f).includes(pattern))
      : allFiles
    const filesScanned = filteredFiles.length

    for (const filePath of filteredFiles) {
      if (iterations >= maxIterations) {
        errors.push({ type: 'limit_reached', stage: 'iterate', message: `maxIterations (${maxIterations}) reached` })
        break
      }
      iterations++

      const relFile = relativeTo(rootDir, filePath)
      let content
      try {
        content = await fs.readFile(filePath, 'utf8')
      } catch (readErr) {
        errors.push({ file: relFile, stage: 'read', message: readErr?.message || String(readErr) })
        continue
      }

      filesAnalyzed++

      const fileIssues = analyzeFileContent(content)
      if (fileIssues.length === 0) continue

      findingsFound += fileIssues.length
      allIssues.push({
        file: relFile,
        lineCount: countLines(content),
        issueCount: fileIssues.length,
        issues: fileIssues,
      })
      // files_with_findings is derived from allIssues.length at report time

      if (fixTodos) {
        for (const issue of fileIssues) {
          if (issue.type === ISSUE_TYPES.TODO_FIXME) {
            await auditLog({
              action: 'todo_found',
              file: relFile,
              line: issue.line,
              content: issue.excerpt,
              tracked: true,
            }, context)
          }
        }
      }

      if (filesModified >= maxFileChanges) continue
      const hasFixable = fileIssues.some((i) => i.fixable)
      if (!hasFixable) continue

      try {
        const { changed, newText, fixesApplied } = applySafeFixes(content, { fixEmptyCatch, fixConsoleLog })
        if (!changed || newText === content) continue

        const diff = buildUnifiedDiff(content, newText, relFile)
        const diffPreview = diff
          ? diff.split('\n').slice(0, 40).join('\n') + (diff.split('\n').length > 40 ? '\n... [diff truncated]' : '')
          : null
        const beforeHash = sha1(content)
        const afterHash = sha1(newText)

        let backup = null
        if (!effectiveDryRun) {
          backup = await backupFile(filePath, content)
          await fs.writeFile(filePath, newText, 'utf8')

          // Safety net: if the edit breaks Node syntax, restore immediately.
          const ext = path.extname(filePath).toLowerCase()
          if (['.js', '.mjs', '.cjs'].includes(ext)) {
            const syntaxCheck = await runNodeSyntaxCheck(filePath)
            if (!syntaxCheck.ok) {
              let restored = false
              try {
                await fs.writeFile(filePath, content, 'utf8')
                restored = true
              } catch {
                restored = false
              }
              errors.push({
                file: relFile,
                stage: 'post_edit_validation_failed',
                message: `Rejected invalid edit: ${syntaxCheck.error}. ${restored ? 'Restored original content' : 'Restore failed'}`,
              })
              await auditLog({
                action: 'file_edit_reverted',
                file: relFile,
                reason: 'post_edit_validation_failed',
                validation_error: syntaxCheck.error,
                backup: relativeTo(rootDir, backup),
                restored,
              }, context)
              continue
            }
          }
        }

        filesModified++
        issuesFixed += fixesApplied.length

        modifications.push({
          file: relFile,
          changes_count: fixesApplied.length,
          backup: backup ? relativeTo(rootDir, backup) : null,
          dry_run: effectiveDryRun,
          dry_run_requested: dryRunRequested,
          dry_run_forced_by_env: dryRunForcedByEnv,
          fixes_applied: fixesApplied,
          diff,
          diff_preview: diffPreview,
          before_sha1: beforeHash,
          after_sha1: afterHash,
        })

        await auditLog({
          action: 'file_modified',
          file: relFile,
          changes_count: fixesApplied.length,
          backup: backup ? relativeTo(rootDir, backup) : null,
          dry_run: effectiveDryRun,
        }, context)
      } catch (fixErr) {
        errors.push({ file: relFile, stage: 'fix', message: fixErr?.message || String(fixErr) })
      }
    }

    const completedAtIso = new Date().toISOString()
    const durationMs = Date.now() - startTime

    const filesWithFindings = allIssues.length

    const report = {
      started_at: startedAtIso,
      directory: directory ? `${directory}${pattern ? ` (pattern="${pattern}")` : ''}` : 'entire repository',
      pattern,

      // Dry-run provenance (canonical)
      dry_run_requested: dryRunRequested,
      dry_run_effective: effectiveDryRun,
      dry_run_forced_by_env: dryRunForcedByEnv,
      writes_explicitly_enabled: writesExplicitlyEnabled,

      max_iterations: maxIterations,
      max_file_changes: maxFileChanges,

      // Honest metrics (canonical names)
      files_discovered: filesDiscovered,
      files_scanned: filesScanned,
      files_analyzed: filesAnalyzed,
      files_with_findings: filesWithFindings,
      findings_found: findingsFound,
      files_modified: filesModified,
      issues_fixed: issuesFixed,

      errors,
      modifications,
      issue_summary_by_type: summarizeIssuesByType(allIssues),
      issue_summary_by_file: allIssues
        .sort((a, b) => b.issueCount - a.issueCount)
        .slice(0, 50),
      completed_at: completedAtIso,
      duration_ms: durationMs,

      // Backward-compatibility aliases (retained so the scheduler + any older
      // dashboards keep working). These mirror the canonical fields above.
      // Prefer the canonical names. Do not compute anything from these.
      dry_run: effectiveDryRun,
      issues_found: findingsFound,
      _deprecated_fields: {
        dry_run: 'use dry_run_effective + dry_run_requested + dry_run_forced_by_env',
        issues_found: 'use findings_found',
      },
    }

    // Persist a full JSON report on disk for auditability.
    try {
      const reportPath = await writeAuditReport(rootDir, report)
      report.report_path = reportPath
    } catch (writeErr) {
      report.report_path = null
      report.errors.push({ stage: 'write_report', message: writeErr?.message || String(writeErr) })
    }

    await auditLog({ action: 'autonomous_crawl_complete', report }, context)
    return report
  } catch (error) {
    await auditLog({ action: 'autonomous_crawl_error', error: error?.message || String(error) }, context)
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
