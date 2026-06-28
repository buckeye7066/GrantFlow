import path from 'path'
import { promises as fs } from 'fs'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'
import { runGrantFlowDomainAudits } from './anyaGrantFlowAudits.js'
import { ANYA_CODE_REPAIR_POLICY } from '../config/missionGoals.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('anyaAutonomousCrawler')

const REPO_ROOT = path.resolve(process.cwd())

// Lazy-loaded acorn parser. We go through createRequire so the project works
// whether acorn ships as CJS or ESM, and degrade gracefully (regex-only) if
// acorn is unavailable in a given environment.
const requireCjs = createRequire(import.meta.url)
let _acorn = null
function getAcorn() {
  if (_acorn !== null) return _acorn
  try {
    _acorn = requireCjs('acorn')
  } catch {
    _acorn = { parse: null, _unavailable: true }
  }
  return _acorn
}

// search_kind classifies each finding by the analysis technique that produced
// it, so consumers can filter / weight results appropriately.
export const SEARCH_KIND = Object.freeze({
  LITERAL: 'literal',
  REGEX: 'regex',
  HEURISTIC: 'heuristic',
  AST: 'ast',
  DOMAIN: 'domain_audit',
})

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
//   dry_run_requested     = boolean from the caller's options
//   writes_explicitly_enabled = true iff the caller intentionally requested
//                         writes for code-error repair
//   dry_run_effective     = what actually happened (final)
//   dry_run_forced_by_env = retained legacy telemetry; always false because
//                           Anya code-error edits no longer require an env gate
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
  // Returns {
  //   files, discoveredCount, skippedNonText, skippedIgnoredDirs,
  //   dirErrors: [{ dir, message }]
  // }
  // so the caller can distinguish between "what we saw on disk" (discovered),
  // "what we actually scanned" (post text-file filter), and "what we couldn't
  // enumerate" (permission denied / vanishing dirs) instead of swallowing it.
  const files = []
  const dirErrors = []
  let discoveredCount = 0
  let skippedNonText = 0
  let skippedIgnoredDirs = 0

  async function walk(current) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (err) {
      dirErrors.push({
        dir: path.relative(rootDir, current).replace(/\\/g, '/') || '.',
        message: err?.message || String(err),
        code: err?.code || null,
      })
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
  return { files, discoveredCount, skippedNonText, skippedIgnoredDirs, dirErrors }
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

// ---------------------------------------------------------------------------
// Analyzers are deliberately split by *technique*. Each finding is tagged
// with its `search_kind` so downstream consumers (and humans reading audit
// reports) know exactly what evidence produced the finding.
//   LITERAL   : case-sensitive substring match (fast path, deterministic)
//   REGEX     : regular-expression match on a single line
//   HEURISTIC : regex + light context sniffing (e.g. silent catch)
//   AST       : parsed JS/TS AST walk via acorn (most precise)
// ---------------------------------------------------------------------------

// Literal substring tokens: exact matches, no regex engine involved.
const LITERAL_TEXT_PATTERNS = [
  { type: ISSUE_TYPES.TODO_FIXME, token: 'TODO', message: 'Unresolved engineering marker (TODO).', severity: 'medium', fixable: false },
  { type: ISSUE_TYPES.TODO_FIXME, token: 'FIXME', message: 'Unresolved engineering marker (FIXME).', severity: 'medium', fixable: false },
  { type: ISSUE_TYPES.TODO_FIXME, token: 'HACK', message: 'Unresolved engineering marker (HACK).', severity: 'medium', fixable: false },
  { type: ISSUE_TYPES.TODO_FIXME, token: 'XXX', message: 'Unresolved engineering marker (XXX).', severity: 'medium', fixable: false },
]

// Regex patterns: broader phrase matches, not token-aware.
const REGEX_PATTERNS = [
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
    type: ISSUE_TYPES.CONSOLE_NOISE,
    regex: /\bconsole\.(log|debug)\(/,
    message: 'Console logging detected in likely application code.',
    severity: 'low',
    fixable: false,
  },
]

// Heuristic patterns: regex + line-shape constraints (e.g. lines that are
// effectively silent catch blocks).
const HEURISTIC_PATTERNS = [
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
]

// Retained for tests and external consumers that imported the old name. Equal
// to the union of all regex + heuristic patterns (literal patterns use tokens
// instead of regexes and therefore are NOT included here).
export const AUDIT_PATTERNS = [...REGEX_PATTERNS, ...HEURISTIC_PATTERNS]

function runLiteralAnalysis(lines) {
  const issues = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const pattern of LITERAL_TEXT_PATTERNS) {
      if (line.includes(pattern.token)) {
        issues.push({
          line: i + 1,
          type: pattern.type,
          severity: pattern.severity,
          message: pattern.message,
          excerpt: line.trim().slice(0, 220),
          fixable: pattern.fixable,
          search_kind: SEARCH_KIND.LITERAL,
          token: pattern.token,
        })
      }
    }
  }
  return issues
}

function runRegexAnalysis(lines) {
  const issues = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const pattern of REGEX_PATTERNS) {
      if (pattern.regex.test(line)) {
        issues.push({
          line: i + 1,
          type: pattern.type,
          severity: pattern.severity,
          message: pattern.message,
          excerpt: line.trim().slice(0, 220),
          fixable: pattern.fixable,
          search_kind: SEARCH_KIND.REGEX,
        })
      }
    }
  }
  return issues
}

function runHeuristicAnalysis(lines) {
  const issues = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const pattern of HEURISTIC_PATTERNS) {
      if (pattern.regex.test(line)) {
        issues.push({
          line: i + 1,
          type: pattern.type,
          severity: pattern.severity,
          message: pattern.message,
          excerpt: line.trim().slice(0, 220),
          fixable: pattern.fixable,
          search_kind: SEARCH_KIND.HEURISTIC,
        })
      }
    }
  }
  return issues
}

// AST analysis for JS/MJS/CJS. TS/JSX/TSX are skipped unless the file happens
// to parse as plain JS under acorn.
function runAstAnalysis(content, filePath) {
  const acorn = getAcorn()
  if (!acorn.parse) return { issues: [], ast_available: false, parse_error: null }

  const ext = path.extname(filePath).toLowerCase()
  const isJs = ['.js', '.mjs', '.cjs'].includes(ext)
  if (!isJs) return { issues: [], ast_available: false, parse_error: 'not_js' }

  const sourceType = ext === '.cjs' ? 'script' : 'module'

  let ast
  try {
    ast = acorn.parse(content, {
      ecmaVersion: 'latest',
      sourceType,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      locations: true,
    })
  } catch (err) {
    return {
      issues: [],
      ast_available: true,
      parse_error: err?.message || String(err),
    }
  }

  const issues = []

  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }

    // CatchClause with empty body => silent catch (AST-precise, no false
    // positives from string literals or comments that the regex matches).
    if (node.type === 'CatchClause' && node.body && node.body.type === 'BlockStatement' && node.body.body.length === 0) {
      const loc = node.loc?.start || { line: 0 }
      issues.push({
        line: loc.line,
        type: node.param ? ISSUE_TYPES.SILENT_CATCH : ISSUE_TYPES.EMPTY_CATCH,
        severity: 'high',
        message: node.param
          ? 'AST: silent catch block hides failures.'
          : 'AST: empty catch block (no error binding).',
        excerpt: '',
        fixable: true,
        search_kind: SEARCH_KIND.AST,
      })
    }

    // CallExpression console.log / log.debug(AST-precise: ignores string
    // literals containing "log.info(").
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'MemberExpression' &&
      node.callee.object &&
      node.callee.object.type === 'Identifier' &&
      node.callee.object.name === 'console' &&
      node.callee.property &&
      node.callee.property.type === 'Identifier' &&
      ['log', 'debug'].includes(node.callee.property.name)
    ) {
      const loc = node.loc?.start || { line: 0 }
      issues.push({
        line: loc.line,
        type: ISSUE_TYPES.CONSOLE_NOISE,
        severity: 'low',
        message: `AST: console.${node.callee.property.name}() call in application code.`,
        excerpt: '',
        fixable: false,
        search_kind: SEARCH_KIND.AST,
      })
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue
      visit(node[key])
    }
  }

  try {
    visit(ast)
  } catch (err) {
    return {
      issues,
      ast_available: true,
      parse_error: `walk_failed: ${err?.message || String(err)}`,
    }
  }

  return { issues, ast_available: true, parse_error: null }
}

// Dedupe (line, type, search_kind) so AST results don't double-count with
// regex/heuristic results on the same line.
function dedupeIssues(issues) {
  const seen = new Set()
  const out = []
  for (const issue of issues) {
    const key = `${issue.line}|${issue.type}`
    // Prefer AST over heuristic/regex/literal when both fire on the same
    // (line,type): insert order puts AST last in our pipeline, so we replace.
    const existingIdx = out.findIndex((x) => `${x.line}|${x.type}` === key)
    if (existingIdx === -1) {
      out.push(issue)
      seen.add(key)
    } else {
      const existing = out[existingIdx]
      const rank = { literal: 1, regex: 2, heuristic: 3, ast: 4 }
      if ((rank[issue.search_kind] || 0) > (rank[existing.search_kind] || 0)) {
        out[existingIdx] = issue
      }
    }
  }
  return out
}

function analyzeFileContent(content, filePath = '') {
  const lines = content.split(/\r?\n/)
  const literalIssues = runLiteralAnalysis(lines)
  const regexIssues = runRegexAnalysis(lines)
  const heuristicIssues = runHeuristicAnalysis(lines)
  const astResult = filePath ? runAstAnalysis(content, filePath) : { issues: [], ast_available: false, parse_error: null }

  const combined = [
    ...literalIssues,
    ...regexIssues,
    ...heuristicIssues,
    ...astResult.issues,
  ]

  return {
    issues: dedupeIssues(combined),
    breakdown: {
      literal: literalIssues.length,
      regex: regexIssues.length,
      heuristic: heuristicIssues.length,
      ast: astResult.issues.length,
      ast_available: astResult.ast_available,
      parse_error: astResult.parse_error,
    },
  }
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
  log.info('[audit][autonomous-crawler]', JSON.stringify(logEntry))

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
    maxIterations = 2000,
    maxFileChanges = 20,
    dryRun = true,
    fixConsoleLog = false,
    fixEmptyCatch = true,
    fixTodos = false,
    // Findings pagination. Default: return ALL findings (no silent truncation)
    // plus a capped summary. Caller can set findingsLimit to paginate.
    findingsLimit = null,      // number | null (null => no limit)
    findingsOffset = 0,        // number
    // Domain audits (GrantFlow-specific): opportunity URLs, matching coverage,
    // fallback logic, UI/backend consistency, Anya grounding. Default on; a
    // DB connection is needed for most of them and missing DB is surfaced as
    // an audit-scoped error rather than swallowed.
    includeDomainAudits = true,
    // Skip AST analysis entirely (mostly for unit tests that don't want acorn
    // loaded).
    skipAst = false,
    // Legacy per-invocation flag from the CLI/admin route. It is retained for
    // telemetry, but dryRun=false is now the write decision. The old env gate
    // was removed by the Anya code-error repair policy.
    writeFlag = false,
  } = options || {}

  const dryRunRequested = Boolean(dryRun)
  const writeFlagEnabled = Boolean(writeFlag)
  // Writes are controlled by the caller's dryRun choice. No environment
  // permission gate is required for Anya code-error repair.
  const writesExplicitlyEnabled = !dryRunRequested
  const effectiveDryRun = dryRunRequested
  // Retained for older dashboards that still read this field.
  const dryRunForcedByEnv = false
  const writesEnvEnabled = true
  const envWriteGateRequired = false

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
    writes_env_enabled: writesEnvEnabled,
    write_flag_enabled: writeFlagEnabled,
    env_write_gate_required: envWriteGateRequired,
    write_policy: ANYA_CODE_REPAIR_POLICY.scope,
    permission_required: ANYA_CODE_REPAIR_POLICY.permission_required,
    audit_required: ANYA_CODE_REPAIR_POLICY.audit_required,
  }, context)

  const allIssues = []
  const modifications = []
  const errors = []
  const scanErrorsDetail = []  // read/dir/parse errors, surfaced not swallowed
  const searchKindBreakdown = { literal: 0, regex: 0, heuristic: 0, ast: 0, domain_audit: 0 }
  let iterations = 0
  let filesAnalyzed = 0
  let filesModified = 0
  let findingsFound = 0
  let issuesFixed = 0
  let filesSkipped = 0 // binary-filtered + read-failed + oversized + too-deep
  let astFilesAttempted = 0
  let astFilesFailed = 0

  try {
    const walk = await listFilesRecursive(rootDir)
    const allFiles = walk.files
    const filesDiscovered = walk.discoveredCount
    // Dir-enumeration errors are real scan errors -- surface them.
    for (const de of walk.dirErrors) {
      errors.push({ stage: 'readdir', dir: de.dir, code: de.code, message: de.message })
      scanErrorsDetail.push({ stage: 'readdir', dir: de.dir, code: de.code, message: de.message })
    }
    // Non-text and ignored-dir skips are discovered-but-skipped.
    filesSkipped += walk.skippedNonText

    const filteredFiles = pattern
      ? allFiles.filter((f) => relativeTo(rootDir, f).includes(pattern))
      : allFiles
    const filesScanned = filteredFiles.length

    for (const filePath of filteredFiles) {
      if (iterations >= maxIterations) {
        errors.push({ type: 'limit_reached', status: 'ran_out_of_iterations', stage: 'iterate', message: `Ran out of iterations after ${maxIterations} files. Increase maxIterations to continue the crawl.` })
        break
      }
      iterations++

      const relFile = relativeTo(rootDir, filePath)
      let content
      try {
        content = await fs.readFile(filePath, 'utf8')
      } catch (readErr) {
        filesSkipped++
        const entry = { file: relFile, stage: 'read', message: readErr?.message || String(readErr), code: readErr?.code || null }
        errors.push(entry)
        scanErrorsDetail.push(entry)
        continue
      }

      filesAnalyzed++

      const ext = path.extname(filePath).toLowerCase()
      if (!skipAst && ['.js', '.mjs', '.cjs'].includes(ext)) astFilesAttempted++

      const analysis = analyzeFileContent(content, skipAst ? '' : filePath)
      const fileIssues = analysis.issues
      searchKindBreakdown.literal += analysis.breakdown.literal
      searchKindBreakdown.regex += analysis.breakdown.regex
      searchKindBreakdown.heuristic += analysis.breakdown.heuristic
      searchKindBreakdown.ast += analysis.breakdown.ast
      if (analysis.breakdown.parse_error && analysis.breakdown.parse_error !== 'not_js') {
        astFilesFailed++
        const entry = { file: relFile, stage: 'ast_parse', message: analysis.breakdown.parse_error }
        errors.push(entry)
        scanErrorsDetail.push(entry)
      }

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
          write_policy: ANYA_CODE_REPAIR_POLICY.scope,
          permission_required: ANYA_CODE_REPAIR_POLICY.permission_required,
          audit_required: ANYA_CODE_REPAIR_POLICY.audit_required,
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
          write_policy: ANYA_CODE_REPAIR_POLICY.scope,
          permission_required: ANYA_CODE_REPAIR_POLICY.permission_required,
          audit_required: ANYA_CODE_REPAIR_POLICY.audit_required,
        }, context)
      } catch (fixErr) {
        errors.push({ file: relFile, stage: 'fix', message: fixErr?.message || String(fixErr) })
      }
    }

    // Domain audits (GrantFlow-specific). Run AFTER code scan so that
    // domain findings can reference the scanned codebase (e.g. matching
    // coverage inspects which profile fields are read in matchEngine.js).
    let domainAudit = null
    if (includeDomainAudits) {
      try {
        domainAudit = await runGrantFlowDomainAudits({
          rootDir,
          db: context?.db ?? null,
          scannedFiles: filteredFiles.map((f) => relativeTo(rootDir, f)),
        })
        for (const finding of domainAudit.findings) {
          allIssues.push({
            file: finding.file || '(domain)',
            lineCount: 0,
            issueCount: 1,
            issues: [{
              line: finding.line || 0,
              type: finding.type,
              severity: finding.severity,
              message: finding.message,
              excerpt: finding.excerpt || '',
              fixable: false,
              search_kind: SEARCH_KIND.DOMAIN,
              audit: finding.audit,
              evidence: finding.evidence || null,
            }],
          })
          findingsFound++
          searchKindBreakdown.domain_audit++
        }
        for (const auditErr of domainAudit.errors || []) {
          const entry = { stage: `domain_audit:${auditErr.audit || 'unknown'}`, message: auditErr.message }
          errors.push(entry)
          scanErrorsDetail.push(entry)
        }
      } catch (domainErr) {
        const entry = { stage: 'domain_audit', message: domainErr?.message || String(domainErr) }
        errors.push(entry)
        scanErrorsDetail.push(entry)
      }
    }

    const completedAtIso = new Date().toISOString()
    const durationMs = Date.now() - startTime

    const filesWithFindings = allIssues.length

    // Build the flat findings list explicitly. NEVER silently truncate.
    // Caller can set findingsLimit to paginate; in that case we always expose
    // findings_total + findings_truncated so nothing is hidden.
    const flatFindings = []
    for (const rec of allIssues) {
      for (const issue of rec.issues) {
        flatFindings.push({
          file: rec.file,
          line: issue.line,
          type: issue.type,
          severity: issue.severity,
          message: issue.message,
          excerpt: issue.excerpt,
          fixable: issue.fixable,
          search_kind: issue.search_kind,
          ...(issue.token ? { token: issue.token } : {}),
          ...(issue.audit ? { audit: issue.audit } : {}),
          ...(issue.evidence ? { evidence: issue.evidence } : {}),
        })
      }
    }

    const findingsTotal = flatFindings.length
    const effectiveLimit = ((findingsLimit !== null && findingsLimit !== undefined) && Number.isFinite(findingsLimit) && findingsLimit >= 0)
      ? Math.min(findingsLimit, findingsTotal)
      : findingsTotal
    const effectiveOffset = Math.max(0, Number(findingsOffset) || 0)
    const findingsPage = flatFindings.slice(effectiveOffset, effectiveOffset + effectiveLimit)
    const findingsTruncated = findingsPage.length < findingsTotal

    // issue_summary_by_file: return ALL, NOT a silent slice. If callers need
    // a shorter view they can slice themselves. We surface the total length
    // explicitly so this is never hidden.
    const issueSummaryByFileAll = allIssues.slice().sort((a, b) => b.issueCount - a.issueCount)

    const report = {
      status: errors.some((error) => error?.status === 'ran_out_of_iterations') ? 'ran_out_of_iterations' : 'completed',
      started_at: startedAtIso,
      directory: directory ? `${directory}${pattern ? ` (pattern="${pattern}")` : ''}` : 'entire repository',
      pattern,

      // Dry-run provenance (canonical)
      dry_run_requested: dryRunRequested,
      dry_run_effective: effectiveDryRun,
      dry_run_forced_by_env: dryRunForcedByEnv,
      writes_explicitly_enabled: writesExplicitlyEnabled,
      writes_env_enabled: writesEnvEnabled,
      write_flag_enabled: writeFlagEnabled,
      env_write_gate_required: envWriteGateRequired,
      write_policy: ANYA_CODE_REPAIR_POLICY.scope,
      permission_required: ANYA_CODE_REPAIR_POLICY.permission_required,
      audit_required: ANYA_CODE_REPAIR_POLICY.audit_required,

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
      files_skipped: filesSkipped,
      scan_errors: scanErrorsDetail.length,

      // Analyzer breakdown: how many findings came from each technique.
      search_kind_breakdown: searchKindBreakdown,
      ast_files_attempted: astFilesAttempted,
      ast_files_failed: astFilesFailed,
      ast_available: !getAcorn()._unavailable,

      // Findings (flat). Paginated if findingsLimit set; otherwise complete.
      findings: findingsPage,
      findings_total: findingsTotal,
      findings_truncated: findingsTruncated,
      findings_offset: effectiveOffset,
      findings_limit: effectiveLimit,

      // Domain audit summary (null if disabled).
      domain_audit_summary: domainAudit ? domainAudit.summary : null,

      errors,
      scan_errors_detail: scanErrorsDetail,
      modifications,
      issue_summary_by_type: summarizeIssuesByType(allIssues),
      issue_summary_by_file: issueSummaryByFileAll,
      issue_summary_by_file_count: issueSummaryByFileAll.length,
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
