/**
 * Anya Auto-Repair Service
 *
 * Automated code-quality scanner that detects and (optionally) repairs common
 * anti-patterns in the GrantFlow codebase:
 *
 *  1. empty_catch    — `.catch(() => {})` → `.catch(e => console.warn(...))`
 *  2. console_log    — `console.log(` in route handler files → `console.info(`
 *  3. profile_bleed  — SQL queries against `funding_opportunities` that are
 *                      missing a `profile_id` isolation clause (REPORT ONLY)
 *
 * Design guarantees
 * -----------------
 *  • Idempotent: running twice produces the same result
 *  • Creates backups before modifying any file (backend/data/backups/auto-repair/)
 *  • Scoped only to backend/ and src/ directories
 *  • Skips node_modules, .git, and data directories
 *  • Audit-logged via logAuditEvent
 *  • In production, repairs are REPORT-ONLY unless ANYA_AUTO_REPAIR=true
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { promises as fs } from 'fs'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCAN_DIRS = ['backend', 'src']
const SKIP_DIRS = new Set(['node_modules', '.git', 'data'])
const BACKUP_BASE = path.join(PROJECT_ROOT, 'backend', 'data', 'backups', 'auto-repair')

const ROUTE_FILES_PATTERN = /backend[\\/]routes[\\/].+\.js$/

/** Matches `.catch(() => {})` — already-repaired variants are excluded */
const EMPTY_CATCH_RE = /\.catch\(\(\)\s*=>\s*\{\s*\}\)/g
const EMPTY_CATCH_REPLACEMENT = ".catch(e => console.warn('[background]', e?.message || e))"

/** Matches `console.log(` */
const CONSOLE_LOG_RE = /console\.log\(/g
const CONSOLE_LOG_REPLACEMENT = 'console.info('

/**
 * SQL queries against funding_opportunities that do NOT reference profile_id.
 * We detect SELECT/UPDATE/DELETE statements touching the table without the
 * isolation guard.  This is REPORT-ONLY — we never auto-fix SQL.
 */
const PROFILE_BLEED_TABLE_RE = /funding_opportunities/i
const PROFILE_BLEED_ISOLATION_RE = /profile_id/i

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect JS/TS files under a directory, skipping excluded dirs.
 * @param {string} dir
 * @returns {Promise<string[]>} absolute file paths
 */
async function collectFiles(dir) {
  const results = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(full)))
    } else if (entry.isFile() && /\.(js|ts|jsx|tsx)$/.test(entry.name)) {
      results.push(full)
    }
  }
  return results
}

/**
 * Write a backup of a file before modifying it.
 * @param {string} filePath
 * @param {string} content — original content
 */
async function writeBackup(filePath, content) {
  const rel = path.relative(PROJECT_ROOT, filePath).replace(/[\\/]/g, '__')
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(BACKUP_BASE, `${rel}.${ts}.bak`)
  await fs.mkdir(path.dirname(backupPath), { recursive: true })
  await fs.writeFile(backupPath, content, 'utf8')
  return backupPath
}

// ---------------------------------------------------------------------------
// Repair scanners
// ---------------------------------------------------------------------------

/**
 * Scan a single file for empty `.catch(() => {})` patterns.
 * @param {string} filePath
 * @param {string} content
 * @returns {{ matches: number }}
 */
function scanEmptyCatch(filePath, content) {
  const matches = (content.match(EMPTY_CATCH_RE) || []).length
  return { matches }
}

/**
 * Scan a single file for `console.log(` in route handler files.
 * @param {string} filePath
 * @param {string} content
 * @returns {{ matches: number }}
 */
function scanConsoleLog(filePath, content) {
  if (!ROUTE_FILES_PATTERN.test(filePath)) return { matches: 0 }
  const matches = (content.match(CONSOLE_LOG_RE) || []).length
  return { matches }
}

/**
 * Scan a single file for SQL accessing funding_opportunities without
 * profile_id isolation.  Returns an array of flagged snippet previews.
 *
 * Strategy: we extract each string/template-literal that contains
 * "funding_opportunities" and check if it also contains "profile_id".
 * This is intentionally conservative (false-positives are acceptable;
 * false-negatives are not).
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {{ issues: Array<{ line: number, snippet: string }> }}
 */
function scanProfileBleed(filePath, content) {
  const issues = []
  const lines = content.split('\n')
  // Collect multi-line string blocks that contain the table name
  // by scanning for backtick template literals and regular strings
  // We use a simple heuristic: find lines that reference the table,
  // then walk backward/forward to grab the enclosing SQL block.
  const visited = new Set()
  for (let i = 0; i < lines.length; i++) {
    if (!PROFILE_BLEED_TABLE_RE.test(lines[i])) continue
    // Collect a window of ±10 lines as the SQL block context
    const start = Math.max(0, i - 10)
    const end = Math.min(lines.length - 1, i + 10)
    const key = `${start}-${end}-${i}`
    if (visited.has(key)) continue
    visited.add(key)
    const block = lines.slice(start, end + 1).join('\n')
    // Skip if the block already has isolation
    if (PROFILE_BLEED_ISOLATION_RE.test(block)) continue
    // Skip non-SQL contexts (imports, comments about the table name, etc.)
    if (!/SELECT|INSERT|UPDATE|DELETE|FROM\s/i.test(block)) continue
    issues.push({
      line: i + 1,
      snippet: lines[i].trim().slice(0, 120),
    })
  }
  return { issues }
}

// ---------------------------------------------------------------------------
// Repair appliers
// ---------------------------------------------------------------------------

/**
 * Apply empty_catch repair to content.
 * @param {string} content
 * @returns {{ newContent: string, count: number }}
 */
function applyEmptyCatch(content) {
  let count = 0
  const newContent = content.replace(EMPTY_CATCH_RE, () => {
    count++
    return EMPTY_CATCH_REPLACEMENT
  })
  return { newContent, count }
}

/**
 * Apply console_log repair to content (route files only).
 * @param {string} filePath
 * @param {string} content
 * @returns {{ newContent: string, count: number }}
 */
function applyConsoleLog(filePath, content) {
  if (!ROUTE_FILES_PATTERN.test(filePath)) return { newContent: content, count: 0 }
  let count = 0
  const newContent = content.replace(CONSOLE_LOG_RE, () => {
    count++
    return CONSOLE_LOG_REPLACEMENT
  })
  return { newContent, count }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run auto-repair scan (and optionally apply repairs).
 *
 * @param {object} db — db handle for audit logging
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=true]     — if true, report only
 * @param {string[]} [opts.repairTypes]     — subset of ['empty_catch','console_log','profile_bleed']
 *                                            defaults to all three
 * @returns {Promise<object>} report
 */
export async function runAutoRepair(db, { dryRun = true, repairTypes } = {}) {
  const allTypes = ['empty_catch', 'console_log', 'profile_bleed']
  const types = Array.isArray(repairTypes) && repairTypes.length > 0
    ? repairTypes.filter(t => allTypes.includes(t))
    : allTypes

  // In production, force dryRun unless ANYA_AUTO_REPAIR=true
  const isProd = process.env.NODE_ENV === 'production'
  const effectiveDryRun = isProd && process.env.ANYA_AUTO_REPAIR !== 'true' ? true : dryRun

  const report = {
    dryRun: effectiveDryRun,
    scannedFiles: 0,
    repairTypes: types,
    findings: {
      empty_catch: [],
      console_log: [],
      profile_bleed: [],
    },
    repaired: {
      empty_catch: 0,
      console_log: 0,
    },
    errors: [],
    startedAt: new Date().toISOString(),
  }

  // Collect all eligible files
  const files = []
  for (const dir of SCAN_DIRS) {
    const abs = path.join(PROJECT_ROOT, dir)
    files.push(...(await collectFiles(abs)))
  }
  report.scannedFiles = files.length

  for (const filePath of files) {
    let content
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch (err) {
      report.errors.push({ file: path.relative(PROJECT_ROOT, filePath), error: err.message })
      continue
    }

    let modified = false
    let newContent = content

    // --- empty_catch ---
    if (types.includes('empty_catch')) {
      const { matches } = scanEmptyCatch(filePath, newContent)
      if (matches > 0) {
        const rel = path.relative(PROJECT_ROOT, filePath)
        report.findings.empty_catch.push({ file: rel, matches })

        if (!effectiveDryRun) {
          const { newContent: fixed, count } = applyEmptyCatch(newContent)
          if (count > 0) {
            newContent = fixed
            modified = true
            report.repaired.empty_catch += count
          }
        }
      }
    }

    // --- console_log ---
    if (types.includes('console_log')) {
      const { matches } = scanConsoleLog(filePath, newContent)
      if (matches > 0) {
        const rel = path.relative(PROJECT_ROOT, filePath)
        report.findings.console_log.push({ file: rel, matches })

        if (!effectiveDryRun) {
          const { newContent: fixed, count } = applyConsoleLog(filePath, newContent)
          if (count > 0) {
            newContent = fixed
            modified = true
            report.repaired.console_log += count
          }
        }
      }
    }

    // --- profile_bleed (always report-only) ---
    if (types.includes('profile_bleed')) {
      const { issues } = scanProfileBleed(filePath, content)
      if (issues.length > 0) {
        const rel = path.relative(PROJECT_ROOT, filePath)
        report.findings.profile_bleed.push({ file: rel, issues })
      }
    }

    // Write backup + apply changes
    if (modified) {
      try {
        const backupPath = await writeBackup(filePath, content)
        await fs.writeFile(filePath, newContent, 'utf8')
        // Record backup in report as a note (not an error)
        const rel = path.relative(PROJECT_ROOT, filePath)
        const backupRel = path.relative(PROJECT_ROOT, backupPath)
        report.findings._repairs = report.findings._repairs || []
        report.findings._repairs.push({ file: rel, backup: backupRel })
      } catch (err) {
        const rel = path.relative(PROJECT_ROOT, filePath)
        report.errors.push({ file: rel, error: `Write failed: ${err.message}` })
      }
    }
  }

  report.completedAt = new Date().toISOString()

  // Audit log
  try {
    logAuditEvent(db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'anya_auto_repair',
      severity: SEVERITY.INFO,
      details: {
        dryRun: effectiveDryRun,
        repairTypes: types,
        scannedFiles: report.scannedFiles,
        emptyCatchFindings: report.findings.empty_catch.length,
        consoleLogFindings: report.findings.console_log.length,
        profileBleedFindings: report.findings.profile_bleed.length,
        repairedEmptyCatch: report.repaired.empty_catch,
        repairedConsoleLog: report.repaired.console_log,
      },
    })
  } catch {
    // Audit logging is best-effort — never block the repair report
  }

  return report
}
