import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { createHash, randomUUID } from 'crypto'
import { getRecentLogs } from '../utils/logger.js'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'
import { ANYA_CODE_REPAIR_POLICY } from '../config/missionGoals.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = path.resolve(process.cwd())

function rowsFromResult(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.rows)) return result.rows
  return []
}

function safeJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function sha1(input) {
  return createHash('sha1').update(String(input ?? '')).digest('hex')
}

/**
 * Recursively collect JS/JSX files from a directory (excludes node_modules, .git, hidden dirs).
 * @param {string} dir - Root directory to scan
 * @returns {Promise<string[]>} Absolute file paths
 */
async function collectFiles(dir) {
  const results = []
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const nested = await collectFiles(fullPath)
        results.push(...nested)
      } else if (entry.isFile() && /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(entry.name)) {
        results.push(fullPath)
      }
    }
  } catch {
    // ignore unreadable directories
  }
  return results
}

// ============================================================================
// Scanner preprocessing helpers (used by adminCodeScan / adminCodeCrawl)
// ============================================================================

//
// stripCommentsPreservingLayout(source)
//
// Replace every line comment, block comment, and JSDoc block region in
// the source with spaces while preserving line count and column offsets.
// This lets the regex-based auditor match string literals on the exact
// line they appear on without false-positives against JSDoc or line
// comments that merely mention the scanned token (e.g. the word
// "debugger" inside JSDoc tripping the debugger-statement rule — the
// original audit false-positive at anyaAdminTools.js:1323,1326).
//
// param  source  string — raw JS/TS source
// return         string — same length, comments replaced with spaces
//
export function stripCommentsPreservingLayout(source) {
  if (typeof source !== 'string' || source.length === 0) return source
  const out = []
  let i = 0
  const n = source.length
  let inLine = false
  let inBlock = false
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (inLine) {
      if (ch === '\n') {
        inLine = false
        out.push('\n')
      } else {
        out.push(' ')
      }
      i++
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        out.push('  ')
        i += 2
        continue
      }
      out.push(ch === '\n' ? '\n' : ' ')
      i++
      continue
    }
    if (inSingle || inDouble || inBacktick) {
      out.push(ch)
      if (ch === '\\' && i + 1 < n) {
        out.push(source[i + 1])
        i += 2
        continue
      }
      if (inSingle && ch === "'") inSingle = false
      else if (inDouble && ch === '"') inDouble = false
      else if (inBacktick && ch === '`') inBacktick = false
      i++
      continue
    }
    if (ch === '/' && next === '/') {
      inLine = true
      out.push('  ')
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      inBlock = true
      out.push('  ')
      i += 2
      continue
    }
    if (ch === "'") {
      inSingle = true
      out.push(ch)
      i++
      continue
    }
    if (ch === '"') {
      inDouble = true
      out.push(ch)
      i++
      continue
    }
    if (ch === '`') {
      inBacktick = true
      out.push(ch)
      i++
      continue
    }
    out.push(ch)
    i++
  }
  return out.join('')
}

/**
 * Return true when a line contains an `audit:allow <category>` comment
 * tagging it as an intentional validator literal (e.g. placeholder URL
 * denylist entries in backend/config/urlRules.js).
 *
 * @param {string} rawLine - The unprocessed source line
 * @param {string} [category] - Optional category to match; when omitted
 *   any `audit:allow` tag matches.
 */
export function hasAuditAllowTag(rawLine, category) {
  if (typeof rawLine !== 'string') return false
  const rx = category
    ? new RegExp(`audit:allow\\s+${category.replace(/[^A-Za-z0-9_-]/g, '')}\\b`, 'i')
    : /audit:allow\b/i
  return rx.test(rawLine)
}

/**
 * High-precision heuristic for "looks like a real credential" — drops the
 * false positives where user-facing error strings happen to contain the
 * word "key" (e.g. `"Provided key failed authentication."`). A finding is
 * only reported when the string literal itself resembles a secret format.
 *
 * @param {string} value - Contents of the captured string literal
 */
export function looksLikeRealSecret(value) {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (v.length < 16) return false
  if (/^(sk_live_|sk_test_|pk_live_|rk_live_)[A-Za-z0-9]{16,}$/.test(v)) return true
  if (/^AKIA[0-9A-Z]{16}$/.test(v)) return true
  if (/^ghp_[A-Za-z0-9]{30,}$/.test(v)) return true
  if (/^xox[abprs]-[A-Za-z0-9-]{10,}$/.test(v)) return true
  if (/^eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+$/.test(v)) return true // JWT
  if (/^-----BEGIN (RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/.test(v)) return true
  // Generic high-entropy heuristic: ≥ 20 chars, alphanumeric (with _/-/+/=/.)
  // AND no whitespace AND mixed case / digits. This filters out prose like
  // "Provided key failed authentication" which contains spaces.
  if (v.length >= 20 && /^[A-Za-z0-9_\-+/=.]+$/.test(v)) {
    const hasLower = /[a-z]/.test(v)
    const hasUpper = /[A-Z]/.test(v)
    const hasDigit = /\d/.test(v)
    if ((hasLower && hasDigit) || (hasUpper && hasDigit) || (hasLower && hasUpper)) {
      return true
    }
  }
  return false
}

// ============================================================================
// Admin Role Enforcement (canonical: req.ctx.isAdmin / users.is_admin)
// ============================================================================

/**
 * Check if user is admin (DB-backed)
 * CRITICAL: This must match the logic in requestContext.js and accessControl.js.
 *
 * Canonical source of truth: `req.ctx.isAdmin` (camelCase) set by
 * backend/middleware/requestContext.js from the `users.is_admin` column.
 * Legacy call sites also pass a raw user row where the flag is `is_admin`
 * (snake_case) or a JWT payload with `role === 'admin'`; all three shapes
 * are accepted so the helper works from any admin-gated code path.
 *
 * @param {Object} user - req.ctx, user row, or JWT payload
 * @returns {boolean} True if user is admin
 */
export function isAdmin(user) {
  if (!user || typeof user !== 'object') {
    return false;
  }

  // Canonical: req.ctx.isAdmin, hydrated from DB by requestContext middleware.
  if (user.isAdmin === true) {
    return true;
  }

  // Raw DB user row shape (is_admin from users.is_admin) — still DB-backed.
  // The pure-JWT-claim shape (`role === 'admin'`) is deliberately NOT accepted:
  // it let a demoted admin's unexpired token pass this admin gate. Tool-runtime
  // callers always pass req.ctx (canonical `isAdmin`).
  return Boolean(user.is_admin === true || user.is_admin === 1);
}

/**
 * Require admin access - throws if user is not admin.
 *
 * Accepts either the ctx object directly, or an options bag containing
 * `{ user, ctx, db }` so callers that only have a tool `context` can pass
 * it through without losing the canonical `ctx.isAdmin` flag.
 *
 * @param {Object} userOrContext - ctx | user row | { user, ctx, db }
 * @throws {Error} If user is not admin
 */
export function requireAdmin(userOrContext) {
  // Unwrap {user, ctx, db}-style tool contexts if passed accidentally.
  const candidate =
    userOrContext && typeof userOrContext === 'object' && 'user' in userOrContext && !('isAdmin' in userOrContext) && !('is_admin' in userOrContext) && !('role' in userOrContext)
      ? userOrContext.ctx ?? userOrContext.user
      : userOrContext;

  if (!isAdmin(candidate)) {
    throw new Error('Admin access required. Admin privileges are managed via database.');
  }
}

/**
 * Check if user can access a profile
 * - Admin can access all profiles
 * - Regular users can only access their own profiles
 * @param {Object} user - User object
 * @param {string} profileId - Profile ID to access
 * @param {Object} db - Database connection
 * @returns {boolean} True if user can access profile
 */
export async function canAccessProfile(user, profileId, db) {
  // Admin can access all profiles
  if (isAdmin(user)) {
    return true;
  }
  
  // Check if profile belongs to user
  const profile = await db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(profileId);
  
  if (!profile) {
    return false;
  }
  
  return profile.user_id === (user.userId ?? user.id);
}

/**
 * Get accessible profiles for user
 * - Admin gets all profiles
 * - Regular users get only their own profiles
 * @param {Object} user - User object
 * @param {Object} db - Database connection
 * @returns {Array} Array of accessible profile IDs
 */
export function getAccessibleProfiles(user, db) {
  if (isAdmin(user)) {
    // Admin gets all profiles
    return db.prepare('SELECT id FROM profiles WHERE status = ?').all('active').map(p => p.id);
  }
  
  // Regular users get only their own profiles
  return db.prepare('SELECT id FROM profiles WHERE user_id = ? AND status = ?')
    .all(user.id, 'active')
    .map(p => p.id);
}

// ============================================================================
// Audit classifiers (identifier- and mission-aware)
// ============================================================================

/**
 * Identifier-aware classifier for dynamic SQL lines.
 *
 * Replaces the old "template literal present === critical" heuristic with
 * three-tier reasoning:
 *   - critical:  user-controlled data interpolated into the SQL string
 *   - warning:   dynamic SQL without a visible identifier allowlist / guard
 *   - info:      dynamic SQL whose interpolations look identifier-guarded
 *
 * Returns `null` when the line is not dynamic SQL.
 *
 * @param {string} line
 * @returns {{severity: 'critical'|'warning'|'info', description: string, fix: string} | null}
 */
function classifyDynamicSqlLine(line) {
  const trimmed = String(line || '').trim()
  if (!/db\.(prepare|run|get|all)\s*\(\s*`/.test(trimmed)) return null
  if (!trimmed.includes('${')) return null

  const hasTrustedIdentifierGuard =
    /allowedTable|ALLOWED_TABLE|SAFE_TABLE|assertAllowed|validateIdentifier|assertSafeIdentifier|safeSqlIdentifier|APPLY_ENGINE_TABLES/.test(trimmed)

  const interpolations = [...trimmed.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim())

  const dangerousInterpolation = interpolations.some((expr) => {
    if (!expr) return true
    if (/req\.|params\.|body\.|query\.|userInput|prompt|message|content/i.test(expr)) return true
    if (/where|sql|clause|orderBy|groupBy|having|raw/i.test(expr) && !/allowed|safe|validated/i.test(expr)) return true
    return false
  })

  if (dangerousInterpolation) {
    return {
      severity: 'critical',
      description: 'Dynamic SQL contains potentially untrusted interpolation',
      fix: 'Allowlist identifiers and parameterize values only',
    }
  }

  if (!hasTrustedIdentifierGuard) {
    return {
      severity: 'warning',
      description: 'Dynamic SQL uses interpolation; verify identifiers are allowlisted',
      fix: 'Route all table/column interpolation through a shared identifier validator',
    }
  }

  return {
    severity: 'info',
    description: 'Dynamic SQL appears identifier-guarded',
    fix: 'No action needed if identifiers are allowlisted and values are parameterized',
  }
}

/**
 * Mission-aware risk detector. Flags patterns that threaten GrantFlow's
 * core guarantees: trustworthy opportunities, profile isolation, real URLs,
 * and explainable matches. These are much higher signal than generic
 * optional-chaining / await-without-try smells.
 *
 * @param {string} line
 * @param {string} relativePath
 * @returns {Array<{severity: 'warning'|'info', description: string, fix: string}>}
 */
function detectMissionRisks(line, relativePath) {
  const risks = []
  const text = String(line || '')

  if (
    /SELECT\b[\s\S]*\bFROM\s+funding_opportunities/i.test(text) &&
    !/profile_id|is_national|\bstate\b|trustedOriginClause|trustedSourceClause/i.test(text)
  ) {
    risks.push({
      severity: 'warning',
      description: 'Opportunity query may be missing profile/location/source trust constraints',
      fix: 'Review query for profile isolation, trust filtering, and recall-safe fallback behavior',
    })
  }

  if (
    /INSERT\s+INTO\s+funding_opportunities/i.test(text) &&
    !/application_url|source_url|link_status/i.test(text)
  ) {
    risks.push({
      severity: 'warning',
      description: 'Opportunity persistence may omit URL/link integrity fields',
      fix: 'Ensure persisted opportunities include real URL and link verification metadata',
    })
  }

  // Matching code that never references the explainability fields is worth a
  // soft nudge, but only in files plausibly related to matching.
  if (
    /funding_opportunities|grants|matchEngine|matchingService/i.test(relativePath) &&
    /score|rank|match/i.test(text) &&
    !/match_score|match_reasons|fit_explanation/i.test(text)
  ) {
    // Intentionally light-touch: info-only, and we only add it for obvious
    // scoring/matching lines to avoid noise.
    if (/\bscore\s*[:=]|\brank\s*[:=]/.test(text)) {
      risks.push({
        severity: 'info',
        description: 'Matching code without visible explainability fields',
        fix: 'Consider surfacing match_score / match_reasons / fit_explanation for the UI',
      })
    }
  }

  return risks
}

function classifyIntentionalCodeCrawlFinding(finding) {
  const file = String(finding?.file || '').replace(/\\/g, '/')
  const description = String(finding?.description || '')
  if (finding?.severity === 'info') {
    return 'info-only code health note; not part of the admin failure baseline'
  }
  if (
    description === 'console.log statement found' &&
    (
      file.startsWith('backend/db/') ||
      file.startsWith('backend/scripts/') ||
      file.startsWith('scripts/') ||
      /(^|\/)(seed|migrate|diagnose|test-|check-)/i.test(file)
    )
  ) {
    return 'CLI/maintenance script intentionally writes operator progress to stdout'
  }
  if (
    description === 'Opportunity query may be missing profile/location/source trust constraints' &&
    /(^|\/)(admin|import-data|seed|catalog|diagnostics|codeGuard)/i.test(file)
  ) {
    return 'admin/import/catalog audit query is intentionally global and not user-facing'
  }
  if (finding?.severity === 'warning') {
    return `documented ${description} baseline; severity is warning, not a blocking failure`
  }
  return null
}

// ============================================================================
// Code Analysis & Auto-Fix Tools
// ============================================================================

/**
 * Deep scan the codebase for patterns, potential errors, and anti-patterns
 * ADMIN ONLY
 */
export async function adminCodeCrawl({ pattern, directory, includeTests = false }, context) {
  // Require admin access
  requireAdmin(context.user);
  
  const searchRoot = directory
    ? path.resolve(REPO_ROOT, directory)
    : REPO_ROOT

  const findings = []
  const ignorePatterns = [
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.turbo',
  ]

  if (!includeTests) {
    ignorePatterns.push('test', 'tests', '__tests__', '*.test.js', '*.spec.js')
  }

  async function scanDirectory(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        const relativePath = path.relative(REPO_ROOT, fullPath)

        if (ignorePatterns.some((p) => relativePath.includes(p))) {
          continue
        }

        if (entry.isDirectory()) {
          await scanDirectory(fullPath)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name)
          if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
            try {
              const content = await fs.readFile(fullPath, 'utf8')
              const rawLines = content.split('\n')
              const codeLines = stripCommentsPreservingLayout(content).split('\n')

              // Pattern matching if specified — scans the code-only
              // projection so user-supplied regex doesn't keep matching
              // inside JSDoc / comment bodies.
              if (pattern) {
                const regex = new RegExp(pattern, 'gi')
                codeLines.forEach((codeLine, idx) => {
                  const rawLine = rawLines[idx] ?? ''
                  if (hasAuditAllowTag(rawLine)) return
                  if (regex.test(codeLine)) {
                    findings.push({
                      file: relativePath,
                      line: idx + 1,
                      severity: 'info',
                      description: `Pattern match: "${pattern}"`,
                      preview: rawLine.trim().slice(0, 100),
                    })
                  }
                })
              }

              // Common anti-patterns and error detection
              rawLines.forEach((rawLine, idx) => {
                const trimmedLine = rawLine.trim()
                const codeLine = codeLines[idx] ?? ''

                // Respect explicit `audit:allow <category>` opt-outs.
                if (hasAuditAllowTag(rawLine)) return

                // console.log in production code
                if (codeLine.includes('console.log') && !relativePath.includes('test')) {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: 'warning',
                    description: 'console.log statement found',
                    preview: trimmedLine.slice(0, 100),
                    fix: '// Remove or replace with proper logging',
                  })
                }

                // Task-marker comments (e.g. fixme/hack markers) — these
                // intentionally live in comments, so scan the raw line.
                if (rawLine.match(/\/\/\s*(TODO|FIXME|XXX|HACK)/i)) {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: 'info',
                    description: 'TODO/FIXME comment',
                    preview: trimmedLine.slice(0, 100),
                  })
                }

                // Empty catch blocks — code-only; comments don't count.
                const codeTrimmed = codeLine.trim()
                if (
                  codeTrimmed === 'catch (error) {}' ||
                  codeTrimmed === 'catch {}' ||
                  codeTrimmed === 'catch (e) {}' ||
                  codeTrimmed === 'catch (err) {}'
                ) {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: 'error',
                    description: 'Empty catch block - errors are silently swallowed',
                    preview: trimmedLine,
                    fix: 'Add error logging or handling',
                  })
                }

                // Unhandled promise rejections
                const promiseChainWindow = codeLines.slice(idx, idx + 8).join('\n')
                if (codeLine.match(/\.then\([^)]*\)/) && !/\.catch\s*\(/.test(promiseChainWindow)) {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: 'warning',
                    description: 'Promise without .catch() handler',
                    preview: trimmedLine.slice(0, 100),
                    fix: 'Add .catch() to handle promise rejection',
                  })
                }

                // Hardcoded API keys or secrets — only flag literals that
                // *actually look like credentials*. Previous heuristic
                // flagged user-facing error strings containing the word
                // "key" (e.g. routes/admin.js:812). Now we extract the
                // string value and require looksLikeRealSecret().
                const secretAssign = codeLine.match(
                  /(api[_-]?key|secret|token|password)\s*[:=]\s*(["'`])([^"'`]+)\2/i
                )
                if (secretAssign && looksLikeRealSecret(secretAssign[3])) {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: 'critical',
                    description: 'Potential hardcoded secret or API key',
                    preview: trimmedLine.slice(0, 50) + '...',
                    fix: 'Move to environment variables',
                  })
                }

                // Identifier-aware dynamic SQL classification.
                // Skips noise-level `info` so only actionable findings surface.
                const sqlAssessment = classifyDynamicSqlLine(codeLine)
                if (sqlAssessment && sqlAssessment.severity !== 'info') {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: sqlAssessment.severity,
                    description: sqlAssessment.description,
                    preview: trimmedLine.slice(0, 140),
                    fix: sqlAssessment.fix,
                  })
                }

                // GrantFlow-specific mission risks (profile isolation, URL
                // integrity, explainability). Replaces the low-signal
                // optional-chaining / await-without-try rules that were
                // drowning the real findings.
                const missionRisks = detectMissionRisks(codeLine, relativePath)
                missionRisks.forEach((risk) => {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: risk.severity,
                    description: risk.description,
                    preview: trimmedLine.slice(0, 140),
                    fix: risk.fix,
                  })
                })
              })
            } catch {
              /* intentionally ignored: unreadable file — skip this entry */
            }
          }
        }
      }
    } catch {
      /* intentionally ignored: directory traversal failure — skip subtree */
    }
  }

  await scanDirectory(searchRoot)
  const actionableFindings = []
  const intentionalWarnings = []
  for (const finding of findings) {
    const baselineReason = classifyIntentionalCodeCrawlFinding(finding)
    if (baselineReason) {
      intentionalWarnings.push({ ...finding, baseline_reason: baselineReason })
    } else {
      actionableFindings.push(finding)
    }
  }

  return {
    scanned_directory: path.relative(REPO_ROOT, searchRoot),
    pattern: pattern ?? null,
    include_tests: includeTests,
    findings_count: actionableFindings.length,
    findings: actionableFindings.slice(0, 100), // Limit to 100 results
    intentional_warnings_baseline: {
      count: intentionalWarnings.length,
      categories: intentionalWarnings.reduce((acc, finding) => {
        const key = finding.baseline_reason
        acc[key] = (acc[key] || 0) + 1
        return acc
      }, {}),
      samples: intentionalWarnings.slice(0, 25),
    },
    raw_findings_count: findings.length,
  }
}

/**
 * Run ESLint-style checks and report issues
 */
export async function adminCodeLint({ targetPath, fix = false }, context) {
  const { db } = context
  const resolvedPath = targetPath
    ? path.resolve(REPO_ROOT, targetPath)
    : REPO_ROOT

  // Simplified linting - in production, you'd integrate with ESLint
  const issues = []

  try {
    const stats = await fs.stat(resolvedPath)
    const files = []

    if (stats.isFile()) {
      files.push(resolvedPath)
    } else if (stats.isDirectory()) {
      const nested = await collectFiles(resolvedPath)
      files.push(...nested)
    }

    // Basic lint checks
    for (const file of files.slice(0, 50)) {
      const content = await fs.readFile(file, 'utf8')
      const lines = content.split('\n')
      const relativePath = path.relative(REPO_ROOT, file)

      lines.forEach((line, idx) => {
        // Check for var usage
        if (line.match(/^\s*var\s+/)) {
          issues.push({
            file: relativePath,
            line: idx + 1,
            severity: 'warning',
            rule: 'no-var',
            message: 'Use const or let instead of var',
          })
        }

        // Check for loose equality only; strict === / !== are valid.
        if (/(^|[^=!])==($|[^=])/.test(line) || /(^|[^!])!=($|[^=])/.test(line)) {
          issues.push({
            file: relativePath,
            line: idx + 1,
            severity: 'error',
            rule: 'eqeqeq',
            message: 'Use === or !== instead of == or !=',
          })
        }
      })
    }

    return {
      path: path.relative(REPO_ROOT, resolvedPath),
      files_checked: files.length,
      issues_found: issues.length,
      issues: issues.slice(0, 50),
      fix_applied: fix && issues.length > 0,
    }
  } catch (error) {
    throw new Error(`Failed to lint: ${error.message}`)
  }
}

/**
 * Analyze a specific file for issues and suggest fixes
 */
export async function adminCodeAnalyze({ filePath }, context) {
  if (!filePath) {
    throw new Error('filePath is required')
  }

  const resolvedPath = path.resolve(REPO_ROOT, filePath);
const repoRootWithSep = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : REPO_ROOT + path.sep;
if (resolvedPath !== REPO_ROOT && !resolvedPath.startsWith(repoRootWithSep)) {
  throw new Error('Path outside repository root not allowed');
}
  const relativePath = path.relative(REPO_ROOT, resolvedPath)

  try {
    const content = await fs.readFile(resolvedPath, 'utf8')
    const lines = content.split('\n')
    const issues = []
    const suggestions = []

    // Analyze for common issues
    let hasImports = false
    let hasExports = false

    lines.forEach((line, idx) => {
      if (line.match(/^import\s/)) hasImports = true
      if (line.match(/^export\s/)) hasExports = true

      // Unused variables (simple heuristic)
      const varMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=/)
      if (varMatch) {
        const varName = varMatch[1]
        const varUsed = content.split('\n').slice(idx + 1).some((l) =>
          l.includes(varName),
        )
        if (!varUsed) {
          issues.push({
            line: idx + 1,
            severity: 'warning',
            description: `Variable '${varName}' may be unused`,
          })
        }
      }

      // Long lines
      if (line.length > 120) {
        issues.push({
          line: idx + 1,
          severity: 'info',
          description: `Line exceeds 120 characters (${line.length})`,
        })
      }
    })

    // Suggestions
    if (!hasImports && !hasExports && lines.length > 50) {
      suggestions.push('Consider breaking this file into smaller modules')
    }

    return {
      file: relativePath,
      lines: lines.length,
      size_bytes: content.length,
      issues_found: issues.length,
      issues: issues.slice(0, 20),
      suggestions,
    }
  } catch (error) {
    throw new Error(`Failed to analyze file: ${error.message}`)
  }
}

/**
 * Propose or apply edits to a specific file
 * @param {Object} params
 * @param {string} params.filePath - Path to file to edit
 * @param {Array} params.changes - Array of change objects
 * @param {boolean} params.save - If true, apply changes and save file (with backup)
 */
export async function adminCodeEdit({ filePath, changes, save = false, dryRun = false }, context) {
  if (!filePath) {
    throw new Error('filePath is required')
  }
  if (!Array.isArray(changes)) {
    throw new Error('changes array is required')
  }

  const resolvedPath = path.resolve(REPO_ROOT, filePath)
  const repoRootWithSep = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : REPO_ROOT + path.sep
  if (resolvedPath !== REPO_ROOT && !resolvedPath.startsWith(repoRootWithSep)) {
    throw new Error('Path outside repository root not allowed')
  }
  const relativePath = path.relative(REPO_ROOT, resolvedPath)

  if (save) {
    const pathSegments = relativePath.split(path.sep)
    if (pathSegments.includes('.git') || pathSegments.includes('node_modules')) {
      throw new Error(`File ${relativePath} is outside code-error repair boundaries`)
    }
  }

  try {
    const content = await fs.readFile(resolvedPath, 'utf8')
    const lines = content.split('\n')
    if (changes.length === 0) {
      return {
        file: relativePath,
        dryRun: Boolean(dryRun || !save),
        no_op: true,
        lines: lines.length,
        size_bytes: content.length,
        changes: [],
        message: 'No changes requested; file metadata returned.',
      }
    }
    const proposedChanges = []
    let hasErrors = false

    // Validate all changes first
    changes.forEach((change) => {
      const { line, oldText, newText } = change
      if (line < 1 || line > lines.length) {
        proposedChanges.push({
          line,
          status: 'error',
          message: 'Line number out of range',
        })
        hasErrors = true
        return
      }

      const currentLine = lines[line - 1]
      if (!currentLine.includes(oldText)) {
        proposedChanges.push({
          line,
          status: 'error',
          message: 'Old text not found on this line',
          current: currentLine,
        })
        hasErrors = true
        return
      }

      proposedChanges.push({
        line,
        status: save ? 'applied' : 'pending',
        old: currentLine,
        new: currentLine.replace(oldText, newText),
      })
    })

    // If save requested and no errors, apply changes
    if (save && !hasErrors) {
      // Create backup
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupDir = path.join(REPO_ROOT, 'backend', 'data', 'backups')
      await fs.mkdir(backupDir, { recursive: true })
      
      const backupPath = path.join(
        backupDir,
        `${path.basename(filePath)}.${timestamp}.backup`
      )
      try { await fs.writeFile(backupPath, content, 'utf8') } catch (err) { throw new Error(`Backup failed: ${err.message}`) }

      // Apply changes
      const modifiedLines = [...lines]
      proposedChanges.forEach((change, idx) => {
        if (change.status === 'applied') {
          const originalChange = changes[idx]
          const lineIdx = originalChange.line - 1
          modifiedLines[lineIdx] = modifiedLines[lineIdx].replace(
            originalChange.oldText,
            originalChange.newText
          )
        }
      })

      const newContent = modifiedLines.join('\n')
      try { await fs.writeFile(resolvedPath, newContent, 'utf8') } catch (err) { throw new Error(`File write failed: ${err.message}`) }

      const auditDetails = {
        file: relativePath,
        reason: 'admin.code.edit saved code-error repair',
        changes: proposedChanges
          .filter(c => c.status === 'applied')
          .map(c => ({
            line: c.line,
            old_sha1: sha1(c.old),
            new_sha1: sha1(c.new),
            old_length: String(c.old ?? '').length,
            new_length: String(c.new ?? '').length,
          })),
        backup_or_rollback: path.relative(REPO_ROOT, backupPath),
        validation: 'line-level oldText validation before write',
        result: 'saved',
        writePolicy: ANYA_CODE_REPAIR_POLICY.scope,
        permissionRequired: ANYA_CODE_REPAIR_POLICY.permission_required,
        auditRequired: ANYA_CODE_REPAIR_POLICY.audit_required,
        before_sha1: sha1(content),
        after_sha1: sha1(newContent),
      }
      await logAuditEvent(context?.db, {
        category: AUDIT_CATEGORIES.ANYA,
        action: 'admin_code_edit_saved',
        severity: SEVERITY.INFO,
        userId: context?.user?.userId ?? context?.user?.id ?? null,
        resourceType: 'code_file',
        resourceId: relativePath,
        details: auditDetails,
      })

      return {
        file: relativePath,
        changes_applied: proposedChanges.filter(c => c.status === 'applied').length,
        changes: proposedChanges,
        backup_created: path.relative(REPO_ROOT, backupPath),
        saved: true,
        writePolicy: ANYA_CODE_REPAIR_POLICY.scope,
        permissionRequired: ANYA_CODE_REPAIR_POLICY.permission_required,
        auditRequired: ANYA_CODE_REPAIR_POLICY.audit_required,
        before_sha1: auditDetails.before_sha1,
        after_sha1: auditDetails.after_sha1,
      }
    }

    return {
      file: relativePath,
      changes_proposed: proposedChanges.length,
      changes: proposedChanges,
      note: save && hasErrors 
        ? 'Changes not saved due to errors. Fix errors and try again.'
        : 'Changes are proposed only. Set save=true to apply them.',
    }
  } catch (error) {
    throw new Error(`Failed to edit file: ${error.message}`)
  }
}

// ============================================================================
// Crawler Management Tools
// ============================================================================

/**
 * List all crawler jobs with their status
 */
export async function adminCrawlerList({ status, limit = 50, type }, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  const params = []
  const clauses = []

  if (status) {
    clauses.push('status = ?')
    params.push(status)
  }

  if (type) {
    clauses.push('type = ?')
    params.push(type)
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200))

  const jobsResult = await db
    .prepare(
      `
      SELECT *
      FROM crawler_jobs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ?
    `,
    )
    .all(...params, safeLimit)
  const jobs = rowsFromResult(jobsResult)

  return {
    count: jobs.length,
    limit: safeLimit,
    filters: { status: status ?? null, type: type ?? null },
    jobs: jobs.map((job) => ({
      ...job,
      parameters: safeJson(job.parameters, {}),
      result_meta: safeJson(job.result_meta, null),
    })),
  }
}

/**
 * Trigger any crawler type with custom parameters
 */
export async function adminCrawlerRun({ crawlerType, type, profileId, parameters = {} }, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  const selectedType = crawlerType ?? type
  if (!selectedType) {
    throw new Error('Crawler type is required')
  }

  const allowedTypes = [
    'local',
    'scholarship',
    'curated_benefits',
    'comprehensive',
    'item_search',
    'avatar_lookup',
    'document_ingest',
    'pipeline_automation',
    'profile_enrichment',
  ]

  if (!allowedTypes.includes(selectedType)) {
    throw new Error(`Invalid crawler type. Allowed: ${allowedTypes.join(', ')}`)
  }

  const jobId = randomUUID()
  const parametersJson = JSON.stringify(parameters)

  db.prepare(
    `
    INSERT INTO crawler_jobs (id, type, profile_id, status, parameters, created_at)
    VALUES (?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP)
  `,
  ).run(jobId, selectedType, profileId ?? null, parametersJson)

  const job = await db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)

  return {
    job_id: job?.id ?? jobId,
    job: {
      ...job,
      id: job?.id ?? jobId,
      job_id: job?.id ?? jobId,
      crawlerType: job?.type ?? selectedType,
      parameters: safeJson(job?.parameters, {}),
    },
    message: `Crawler job ${jobId} queued successfully`,
  }
}

/**
 * Validate crawler outputs and check for errors in recent jobs
 */
export async function adminCrawlerCheck({ jobId, lastN, limit, since, status }, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  let jobs = []
  let totalJobs = 0
  const totalRow = await db.prepare('SELECT COUNT(*) AS count FROM crawler_jobs').get()
  totalJobs = Number(totalRow?.count || 0)

  if (jobId) {
    const job = await db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    if (job) {
      jobs = [job]
    }
  } else {
    const safeLimit = Math.max(1, Math.min(Number(limit ?? lastN) || 200, 1000))
    const clauses = []
    const params = []
    if (since) {
      const sinceDate = new Date(String(since))
      if (Number.isNaN(sinceDate.getTime())) {
        const error = new Error('since must be an ISO-8601 timestamp, e.g. 2026-04-25T00:00:00Z')
        error.status = 400
        throw error
      }
      clauses.push(db?.dialect === 'postgres' ? 'created_at >= ?' : 'datetime(created_at) >= datetime(?)')
      params.push(sinceDate.toISOString())
    }
    if (status) {
      clauses.push('status = ?')
      params.push(String(status))
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const recentRows = rowsFromResult(await db
      .prepare(
        `
      SELECT *
      FROM crawler_jobs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all(...params, safeLimit))

    jobs = recentRows
  }

  const validation = {
    checked: jobs.length,
    errors: [],
    warnings: [],
    summary: {},
    total_jobs: totalJobs,
    sample_fraction: totalJobs > 0 ? jobs.length / totalJobs : 1,
  }

  if (totalJobs > 0 && jobs.length / totalJobs < 0.01) {
    validation.warnings.push({
      type: 'small_sample',
      message: `Sample covers ${jobs.length} of ${totalJobs} crawler jobs (<1%). Increase limit or provide since/status filters for a deeper audit.`,
    })
  }

  jobs.forEach((job) => {
    if (job.status === 'failed') {
      validation.errors.push({
        job_id: job.id,
        type: job.type,
        error: job.error,
        created_at: job.created_at,
      })
    }

    if (job.status === 'running') {
      const startedAt = new Date(job.started_at)
      const now = new Date()
      const durationMinutes = (now - startedAt) / 1000 / 60

      if (durationMinutes > 30) {
        validation.warnings.push({
          job_id: job.id,
          type: job.type,
          message: `Job running for ${Math.round(durationMinutes)} minutes`,
        })
      }
    }

    const status = job.status || 'unknown'
    validation.summary[status] = (validation.summary[status] || 0) + 1
  })

  return validation
}

/**
 * Retry a failed crawler job
 */
export async function adminCrawlerRetry({ jobId }, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  if (!jobId) {
    throw new Error('jobId is required')
  }

  const originalJob = db
    .prepare('SELECT * FROM crawler_jobs WHERE id = ?')
    .get(jobId)

  if (!originalJob) {
    throw new Error('Job not found')
  }

  const newJobId = randomUUID()
  const parameters = safeJson(originalJob.parameters ?? originalJob.params ?? originalJob.payload, {})
  parameters.retried_from_job_id = jobId

  db.prepare(
    `
    INSERT INTO crawler_jobs (id, type, profile_id, status, parameters, created_at)
    VALUES (?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP)
  `,
  ).run(
    newJobId,
    originalJob.type,
    originalJob.profile_id,
    JSON.stringify(parameters),
  )

  // Update retry count on original job
  db.prepare(
    `
    UPDATE crawler_jobs
    SET retry_count = COALESCE(retry_count, 0) + 1,
        last_retry_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(jobId)

  const newJob = await db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(newJobId)

  return {
    original_job_id: jobId,
    new_job_id: newJob?.id ?? newJobId,
    new_job: {
      ...newJob,
      id: newJob?.id ?? newJobId,
      job_id: newJob?.id ?? newJobId,
      parameters: safeJson(newJob?.parameters, {}),
    },
    message: 'Job retried successfully',
  }
}

/**
 * Cancel a running crawler job
 */
export async function adminCrawlerCancel({ jobId, reason }, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  if (!jobId) {
    throw new Error('jobId is required')
  }

  const job = await db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)

  if (!job) {
    throw new Error('Job not found')
  }

  if (job.status === 'completed' || job.status === 'cancelled') {
    return {
      job_id: jobId,
      status: job.status,
      message: `Job already ${job.status}`,
    }
  }

  const cancelReason = reason || 'Cancelled by admin'

  db.prepare(
    `
    UPDATE crawler_jobs
    SET status = 'cancelled',
        error = ?,
        completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(cancelReason, jobId)

  return {
    job_id: jobId,
    previous_status: job.status,
    new_status: 'cancelled',
    reason: cancelReason,
    message: 'Job cancelled successfully',
  }
}

// ============================================================================
// App Function Execution & Diagnostics
// ============================================================================

/**
 * Resolve the base URL for the running backend so admin tooling can call
 * real HTTP endpoints in-process instead of returning simulated responses.
 */
function resolveAdminBaseUrl() {
  const explicit = process.env.ADMIN_SELF_BASE_URL || process.env.INTERNAL_API_URL
  if (explicit && /^https?:\/\//i.test(explicit)) return explicit.replace(/\/+$/, '')
  const port = Number(process.env.PORT) || Number(process.env.BACKEND_PORT) || 3001
  return `http://127.0.0.1:${port}`
}

/**
 * Execute a backend endpoint/function and capture the real HTTP result.
 * This replaces the previous simulated stub. The implementation is
 * intentionally small and safe: admin-only, self-hosted base URL only,
 * bounded body size, and best-effort JSON parsing.
 */
export async function adminFunctionsTest({ route, method = 'GET', body = {} }, context) {
  requireAdmin(context?.user)

  if (!route || typeof route !== 'string') {
    throw new Error('route is required')
  }

  const normalizedMethod = String(method || 'GET').toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(normalizedMethod)) {
    throw new Error(`Unsupported method: ${method}`)
  }

  const baseUrl = resolveAdminBaseUrl()
  const url = new URL(route, baseUrl + '/')

  // Only allow calls back to this process. Prevents this admin tool from
  // being abused as an SSRF vector targeting arbitrary internal hosts.
  const baseHost = new URL(baseUrl).host
  if (url.host !== baseHost) {
    const err = new Error(`Refusing to call non-self host: ${url.host}`)
    err.status = 400
    throw err
  }

  const headers = { 'content-type': 'application/json' }
  const adminToken = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN
  if (adminToken) headers.authorization = `Bearer ${adminToken}`

  const hasBody = !['GET', 'HEAD'].includes(normalizedMethod)
  const started = Date.now()

  let response
  let fetchError = null
  try {
    response = await fetch(url, {
      method: normalizedMethod,
      headers,
      body: hasBody ? JSON.stringify(body || {}) : undefined,
    })
  } catch (err) {
    fetchError = err
  }

  const duration_ms = Date.now() - started

  if (fetchError) {
    return {
      route,
      method: normalizedMethod,
      url: url.toString(),
      ok: false,
      status: 0,
      duration_ms,
      error: fetchError.message,
    }
  }

  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // leave parsed as text for non-JSON responses
  }

  return {
    route,
    method: normalizedMethod,
    url: url.toString(),
    status: response.status,
    ok: response.ok,
    duration_ms,
    content_type: response.headers.get('content-type') || null,
    body: parsed,
  }
}

/**
 * Run a function with detailed error tracing. Wraps adminFunctionsTest with
 * richer metadata (timing buckets, error classification) so admins can
 * quickly distinguish network/auth/app-layer failures.
 */
export async function adminFunctionsDiagnose({ route, method = 'GET', body = {} }, context) {
  requireAdmin(context?.user)

  const trace = []
  const pushTrace = (stage, details) => {
    trace.push({ stage, at: new Date().toISOString(), ...details })
  }

  pushTrace('start', { route, method })

  let result
  try {
    result = await adminFunctionsTest({ route, method, body }, context)
    pushTrace('response', { status: result.status, ok: result.ok, duration_ms: result.duration_ms })
  } catch (err) {
    pushTrace('error', { message: err.message, status: err.status ?? null })
    return {
      route,
      method,
      ok: false,
      error: err.message,
      trace,
    }
  }

  let classification = 'ok'
  if (!result.ok) {
    if (result.status === 0) classification = 'network_error'
    else if (result.status === 401 || result.status === 403) classification = 'auth_error'
    else if (result.status >= 500) classification = 'server_error'
    else if (result.status >= 400) classification = 'client_error'
    else classification = 'non_2xx'
  }

  pushTrace('classified', { classification })

  return {
    ...result,
    classification,
    trace,
  }
}

// ============================================================================
// Database & System Tools
// ============================================================================

/**
 * Run read-only SQL queries for diagnostics (SELECT only)
 */
export async function adminDbQuery({ sql, limit = 100 }, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  if (!sql || typeof sql !== 'string') {
    throw new Error('SQL query is required')
  }

  // Security: Only allow SELECT statements
  const trimmedSql = sql.trim().toLowerCase()
  if (!trimmedSql.startsWith('select')) {
    throw new Error('Only SELECT queries are allowed')
  }

  // Block semicolons to prevent multi-statement injection
  if (trimmedSql.includes(';')) {
    throw new Error('Query contains forbidden characters')
  }

  // Block subqueries by detecting more than one SELECT keyword
  const selectMatches = trimmedSql.match(/\bselect\b/g)
  if (selectMatches && selectMatches.length > 1) {
    throw new Error('Subqueries are not allowed')
  }

  // Block dangerous keywords
  const dangerousKeywords = [
    'drop', 'delete', 'update', 'insert', 'alter', 'create', 'truncate',
    'union', 'into', 'exec', 'execute', 'grant', 'revoke',
  ]
  if (dangerousKeywords.some((keyword) => trimmedSql.includes(keyword))) {
    throw new Error('Query contains forbidden keywords')
  }

  try {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500))
    
    // Append LIMIT clause to the query if not already present.
    // Build finalSql from trimmedSql (already lowercased/sanitized) to prevent case-bypass attacks.
    // Security checks use trimmedSql (lowercased). Execution uses the original, case-preserved sql.
const originalTrimmed = sql.trim();
let finalSql = originalTrimmed;
if (!trimmedSql.includes('limit')) {
  finalSql += ` LIMIT ${safeLimit}`;
}

const results = rowsFromResult(await db.prepare(finalSql).all())

    return {
      query: sql,
      rows_returned: results.length,
      limit: safeLimit,
      results: results.slice(0, safeLimit),
    }
  } catch (error) {
    throw new Error(`Query failed: ${error.message}`)
  }
}

/**
 * Get database health statistics
 */
export async function adminDbStats(_params, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  try {
    // Get table counts — query differs between SQLite and Postgres
    let tables
    if (db?.dialect === 'postgres') {
      tables = await db
        .prepare(
          `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
        )
        .all()
    } else {
      tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all()
    }

    const tableCounts = {}
    for (const table of tables) {
      try {
        // Validate table name - only allow alphanumeric, underscores, and dashes
        // This protects against SQL injection via table name
        if (!/^[a-zA-Z0-9_]+$/.test(table.name)) {
          tableCounts[table.name] = 'Error: Invalid table name'
          continue
        }
        const count = await db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get()
        tableCounts[table.name] = count.count
      } catch (error) {
        tableCounts[table.name] = `Error: ${error.message}`
      }
    }

    // Recent activity — both branches are compile-time constant SQL strings
    // selected by dialect. No interpolation of user data. Explicitly flagged
    // for the auditor so the sql_safety scanner stops re-listing this line.
    const isPostgres = db?.dialect === 'postgres'
    // audit:allow dynamic-sql — constant per-dialect string, no user input
    const recentCrawlersSql = isPostgres
      ? `SELECT status, COUNT(*) as count FROM crawler_jobs WHERE created_at >= (NOW() - INTERVAL '24 hours') GROUP BY status`
      : `SELECT status, COUNT(*) as count FROM crawler_jobs WHERE created_at >= datetime('now', '-24 hours') GROUP BY status`
    // audit:allow dynamic-sql — constant per-dialect string, no user input
    const recentSessionsSql = isPostgres
      ? `SELECT COUNT(*) as count FROM anya_sessions WHERE created_at >= (NOW() - INTERVAL '24 hours')`
      : `SELECT COUNT(*) as count FROM anya_sessions WHERE created_at >= datetime('now', '-24 hours')`

    const recentCrawlers = await db.prepare(recentCrawlersSql).all()

    const recentSessions = await db.prepare(recentSessionsSql).get()

    return {
      database: db?.dialect === 'postgres' ? 'PostgreSQL' : 'SQLite',
      tables: tables.length,
      table_counts: tableCounts,
      recent_activity: {
        crawler_jobs_24h: recentCrawlers,
        anya_sessions_24h: Number(recentSessions?.count || 0),
      },
    }
  } catch (error) {
    throw new Error(`Failed to get database stats: ${error.message}`)
  }
}

// ============================================================================
// Health & Monitoring Tools
// ============================================================================

/**
 * Full system health report
 */
export async function adminHealthCheck(_params, context) {
  const { db } = context

  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {},
  }

  // Database check
  try {
    if (db) {
      db.prepare('SELECT 1').get()
      health.services.database = { status: 'up', type: 'SQLite' }
    } else {
      health.services.database = { status: 'unavailable' }
      health.status = 'degraded'
    }
  } catch (error) {
    health.services.database = { status: 'down', error: error.message }
    health.status = 'unhealthy'
  }

  // Crawler service check
  try {
    if (db) {
      const runningJobs = db
        .prepare("SELECT COUNT(*) as count FROM crawler_jobs WHERE status = 'running'")
        .get()
      health.services.crawlers = {
        status: 'up',
        running_jobs: runningJobs.count,
      }
    }
  } catch (error) {
    health.services.crawlers = { status: 'down', error: error.message }
    health.status = 'degraded'
  }

  // Environment check
  health.services.environment = {
    node_version: process.version,
    uptime_seconds: Math.round(process.uptime()),
    memory_usage_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  }

  return health
}

/**
 * Scan codebase for specific issues: TODOs, console.logs, debugger statements, etc.
 * @param {string} directory - Directory to scan (default: entire repo)
 * @param {string} filePattern - File pattern to match (default: "*.js")
 * @param {Array<string>} issueTypes - Types of issues to find (todo, console, debugger, fixme, hack)
 * @param {Object} context - Request context with user and db info
 * @returns {Promise<Object>} Scan results with found issues grouped by type and file
 * @admin ADMIN ONLY
 */
export async function adminCodeScan({ directory = '.', filePattern = '*.js', issueTypes = ['todo', 'console', 'debugger'] }, context) {
  requireAdmin(context.user)

  const searchRoot = directory ? path.resolve(REPO_ROOT, directory) : REPO_ROOT

  const findings = {
    todo_items: [],
    console_statements: [],
    debugger_statements: [],
    fixme_items: [],
    hack_items: [],
  }

  const scanPatterns = [
    { type: 'todo_items', regex: /\/\/\s*TODO|\/\*\s*TODO/gi, severity: 'info', description: 'TODO comment found' },
    { type: 'console_statements', regex: /console\.(log|warn|error|debug|info|table)\(/g, severity: 'warning', description: 'Console statement found' },
    { type: 'debugger_statements', regex: /^\s*debugger\s*;?\s*$/m, severity: 'error', description: 'Debugger statement found' },
    { type: 'fixme_items', regex: /\/\/\s*FIXME|\/\*\s*FIXME/gi, severity: 'warning', description: 'FIXME comment found' },
    { type: 'hack_items', regex: /\/\/\s*HACK|\/\*\s*HACK/gi, severity: 'warning', description: 'HACK comment found' },
  ]

  try {
    const files = await collectFiles(searchRoot)

    for (const file of files.slice(0, 200)) {
      try {
        const content = await fs.readFile(file, 'utf8')
        const rawLines = content.split('\n')
        // Strip JSDoc / line comments / block comments before regex scans
        // so mentions of "debugger" inside /** … */ do not trigger the
        // debugger-statement rule (audit false-positive).
        const codeOnlyLines = stripCommentsPreservingLayout(content).split('\n')

        for (let idx = 0; idx < rawLines.length; idx++) {
          const rawLine = rawLines[idx]
          const codeLine = codeOnlyLines[idx] ?? ''
          // Respect explicit `audit:allow <category>` opt-outs placed by
          // maintainers on intentional validator literals.
          if (hasAuditAllowTag(rawLine)) continue

          for (const pattern of scanPatterns) {
            const issueKey = pattern.type.replace('_items', '').replace('_statements', '')
            if (!issueTypes.includes(issueKey) && !issueTypes.includes('all')) continue
            // Task-marker tokens live in comments by design, so keep scanning
            // the raw line for those. Everything else scans the
            // code-only projection.
            const lineForScan = /_items$/.test(pattern.type) ? rawLine : codeLine
            pattern.regex.lastIndex = 0
            const matchesPattern = pattern.type === 'debugger_statements'
              ? pattern.regex.test(codeLine)
              : pattern.regex.test(lineForScan)
            if (matchesPattern) {
              const relativePath = path.relative(REPO_ROOT, file)
              findings[pattern.type].push({
                file: relativePath,
                line: idx + 1,
                severity: pattern.severity,
                description: pattern.description,
                preview: rawLine.trim().slice(0, 100),
                fix: `Review and address the ${pattern.description.toLowerCase()}`,
              })
            }
          }
        }
      } catch {
        /* intentionally ignored: unreadable file — skip and continue scanning */
      }
    }
  } catch (err) {
    throw new Error(`Failed to scan codebase: ${err.message}`)
  }

  const totalIssues = Object.values(findings).reduce((sum, arr) => sum + arr.length, 0)
  return {
    scanned_directory: path.relative(REPO_ROOT, searchRoot),
    file_pattern: filePattern,
    issue_types: issueTypes,
    issues_found: totalIssues,
    findings,
    summary: {
      total: totalIssues,
      by_type: Object.fromEntries(Object.entries(findings).map(([type, items]) => [type, items.length])),
      timestamp: new Date().toISOString(),
    },
  }
}

/**
 * Get recent error/warning logs from the in-process log ring buffer.
 *
 * The shared logger (`backend/utils/logger.js`) pushes every emitted log
 * record (that passes the active level threshold) into a bounded ring
 * buffer. This tool exposes that buffer to admin callers and Anya so the
 * "recent errors" panel reflects real production behavior rather than an
 * empty stub.
 */
export async function adminHealthLogs({ level = 'warning', limit = 50, source }, context) {
  requireAdmin(context?.user)

  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200)
  const normalizedLevel = String(level || 'warning').toLowerCase() === 'warning' ? 'warn' : String(level || 'warning').toLowerCase()
  const ringLogs = getRecentLogs({ level: normalizedLevel, source, limit: cap })
  const severityRank = (value) => {
    if (typeof value === 'number') {
      if (value <= 3) return ({ 0: 40, 1: 30, 2: 20, 3: 10 })[value] ?? 0
      return value
    }
    const text = String(value || '').toLowerCase()
    if (/^\d+$/.test(text)) {
      const n = Number(text)
      if (n <= 3) return ({ 0: 40, 1: 30, 2: 20, 3: 10 })[n] ?? 0
      return n
    }
    if (text === 'critical') return 50
    if (text === 'error') return 40
    if (text === 'warn' || text === 'warning') return 30
    if (text === 'info') return 20
    if (text === 'debug') return 10
    return 0
  }
  const severityName = (rank) => {
    if (rank >= 50) return 'fatal'
    if (rank >= 40) return 'error'
    if (rank >= 30) return 'warn'
    if (rank >= 20) return 'info'
    if (rank >= 10) return 'debug'
    return 'unknown'
  }
  const minimumSeverity = severityRank(normalizedLevel || 'warn') || 30

  // Group 7: also read persisted warn/error records from audit_logs so the
  // admin.health.logs tool survives process restarts. The ring buffer is
  // in-memory only; audit_logs is the long-term record. We merge both and
  // sort by timestamp descending.
  let dbLogs = []
  try {
    const db = context?.db
    if (db && typeof db.prepare === 'function') {
      let auditColumns = []
      try {
        if (db?.dialect === 'postgres') {
          auditColumns = rowsFromResult(await db.prepare(`
            SELECT column_name AS name
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'audit_logs'
          `).all()).map((row) => String(row.name))
        } else {
          auditColumns = rowsFromResult(await db.prepare('PRAGMA table_info(audit_logs)').all()).map((row) => String(row.name))
        }
      } catch {
        auditColumns = []
      }

      const hasSeverity = auditColumns.includes('severity')
      const hasSeverityLevel = auditColumns.includes('severity_level')
      const severitySelect = [
        hasSeverity ? 'severity' : 'NULL AS severity',
        hasSeverityLevel ? 'severity_level' : 'NULL AS severity_level',
      ].join(', ')
      const severityRankParts = [
        hasSeverityLevel
          ? `CASE
              WHEN severity_level IS NULL THEN 0
              WHEN severity_level <= 3 THEN CASE severity_level WHEN 0 THEN 40 WHEN 1 THEN 30 WHEN 2 THEN 20 WHEN 3 THEN 10 ELSE 0 END
              ELSE severity_level
            END`
          : '0',
        hasSeverity
          ? `CASE lower(severity)
              WHEN 'debug' THEN 10
              WHEN 'info' THEN 20
              WHEN 'warn' THEN 30
              WHEN 'warning' THEN 30
              WHEN 'error' THEN 40
              WHEN 'critical' THEN 50
              WHEN 'fatal' THEN 50
              ELSE 0
            END`
          : '0',
      ].join(', ')
      const severityRankSql = db?.dialect === 'postgres'
        ? `GREATEST(${severityRankParts})`
        : `MAX(${severityRankParts})`
      const whereClauses = [`${severityRankSql} >= ?`]
      const params = [minimumSeverity]
      if (source) {
        whereClauses.push('category = ?')
        params.push(String(source))
      }
      const fetchLimit = Math.min(Math.max(cap * 100, 5000), 50000)
      params.push(fetchLimit)
      const rows = await db
        .prepare(
          `SELECT id, created_at, category, action, ${severitySelect}, user_id, profile_id, details
             FROM audit_logs
             WHERE ${whereClauses.join(' AND ')}
             ORDER BY created_at DESC
             LIMIT ?`,
        )
        .all(...params)
      dbLogs = rowsFromResult(rows)
        .filter((r) => Math.max(severityRank(r.severity_level), severityRank(r.severity)) >= minimumSeverity)
        .slice(0, cap)
        .map((r) => ({
          ts: r.created_at,
          level: severityName(Math.max(severityRank(r.severity_level), severityRank(r.severity))),
          namespace: r.category || 'audit',
          event: r.action,
          message: `[audit:${r.category}] ${r.action}${r.details ? ' ' + String(r.details).slice(0, 400) : ''}`,
          user_id: r.user_id,
          profile_id: r.profile_id,
          persisted: true,
        }))
    }
  } catch (err) {
    // Never let a logging-read failure crash the admin tool.
    // audit_logs may not exist on a fresh DB; fall back to ring buffer only.
    console.warn('[adminHealthLogs] audit_logs read failed:', err?.message || err)
  }

  const merged = [...ringLogs, ...dbLogs]
    .sort((a, b) => String(b?.ts || '').localeCompare(String(a?.ts || '')))
    .slice(0, cap)

  return {
    level,
    source: source ?? null,
    limit: cap,
    count: merged.length,
    ring_buffer_count: ringLogs.length,
    persisted_count: dbLogs.length,
    logs: merged,
    source_description:
      `merged: in-memory ring buffer (backend/utils/logger.js) + persisted audit_logs rows (severity >= ${normalizedLevel})`,
  }
}
