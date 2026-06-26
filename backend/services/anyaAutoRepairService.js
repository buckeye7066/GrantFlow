/**
 * Anya Auto-Repair Service
 *
 * Automated code-quality scanner that detects and (optionally) repairs common
 * anti-patterns in the GrantFlow codebase. The patterns here are derived from
 * real production incidents — every entry below corresponds to a recent fix
 * commit that took the site down for some surface (see commit history for
 * 2026-04 / 2026-05 fix(profiles), fix(saved-grants), fix(ui), fix(apply),
 * fix(deploy)).
 *
 * Patterns
 * --------
 *  1. empty_catch         — `.catch(() => {})` → `.catch(e => console.warn(...))`
 *  2. console_log         — `log.info(` in route handler files → `log.info(`
 *  3. profile_bleed       — SQL queries against `funding_opportunities` missing
 *                            `profile_id` isolation (REPORT-ONLY)
 *  4. missing_db_await    — `db.prepare(...).all/get/run(...)` not preceded by
 *                            `await`. Treats the returned Promise as an Array
 *                            on Postgres → 500s ("documents.slice is not a
 *                            function", "userRows.map is not a function", etc.)
 *  5. column_typo         — Known-typo column names that compile against zero
 *                            production migrations and 500 the route on
 *                            Postgres (e.g. `requires_matching_funds`).
 *  6. unstructured_500    — `console.error(...)` immediately before
 *                            `res.status(500)` in a route catch — the
 *                            message ends up unsearchable in production logs.
 *                            Auto-fixed if `routeLogger` is already imported.
 *  7. react_object_render — JSX renders an iterated `*reasons*` value
 *                            directly (`{reason}`) without coercion. Caused
 *                            React error #31 ("found: object with keys
 *                            {reason, source}") on multiple routes. REPORT-
 *                            ONLY because the fix needs an import edit.
 *  8. dockerfile_drift    — `backend/start.js` reachable file lives outside
 *                            the Dockerfile COPY whitelist → boot crash with
 *                            ERR_MODULE_NOT_FOUND on Railway. Runs the
 *                            existing `scripts/check-runtime-imports.mjs`.
 *                            REPORT-ONLY (Dockerfile edits need human review).
 *
 * Design guarantees
 * -----------------
 *  • Idempotent: running twice produces the same result
 *  • Creates backups before modifying any file (backend/data/backups/auto-repair/)
 *  • Scoped only to backend/ and src/ directories
 *  • Skips node_modules, .git, and data directories
 *  • Audit-logged via logAuditEvent
 *  • Code-error repair writes require no extra environment permission gate
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { promises as fs } from 'fs'
import { spawn } from 'node:child_process'
import { parse as babelParse } from '@babel/parser'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'
import { ANYA_CODE_REPAIR_POLICY } from '../config/missionGoals.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('anyaAutoRepairService')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCAN_DIRS = ['backend', 'src']
const SKIP_DIRS = new Set(['node_modules', '.git', 'data'])
const BACKUP_BASE = path.join(PROJECT_ROOT, 'backend', 'data', 'backups', 'auto-repair')

const ROUTE_FILES_PATTERN = /backend[\\/]routes[\\/].+\.js$/

// Files that intentionally reference the anti-patterns this service detects
// (the service itself and its tests / harness). Skipping them avoids the
// scanner reporting on its own documentation strings and unit-test fixtures.
const SELF_SKIP_PATTERNS = [
  /backend[\\/]services[\\/]anyaAutoRepairService\.js$/,
  /backend[\\/]tests[\\/]anyaAutoRepairService\.test\.js$/,
  /scripts[\\/]_anya-self-test\.mjs$/,
]

function isSelfSkipped(filePath) {
  return SELF_SKIP_PATTERNS.some((re) => re.test(filePath))
}

/**
 * Replace the contents of every block comment, JSDoc, and `// ...` line comment
 * with whitespace of the same length, preserving line numbers and column
 * offsets. We use the comment-stripped view for scanners that would
 * otherwise match anti-patterns embedded in documentation strings (the
 * scanner self-references its own regexes in its module header, for
 * example). Code paths that need raw content (e.g. apply rewrites) keep
 * using the original.
 */
function stripCommentsPreservingLayout(source) {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    // Line comment
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out += ' '.repeat(stop - i)
      i = stop
      continue
    }
    // Block / JSDoc comment
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      for (let k = i; k < stop; k++) {
        out += source[k] === '\n' ? '\n' : ' '
      }
      i = stop
      continue
    }
    // Single / double / template strings: preserve as-is. Real comments
    // never appear inside strings, and stripping them would corrupt the
    // scanner's view of legitimate code patterns embedded in SQL strings.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c
      i++
      while (i < n) {
        const ch = source[i]
        out += ch
        if (ch === '\\' && i + 1 < n) {
          out += source[i + 1]
          i += 2
          continue
        }
        i++
        if (ch === quote) break
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/** Matches `.catch(() => {})` — already-repaired variants are excluded */
const EMPTY_CATCH_RE = /\.catch\(\(\)\s*=>\s*\{\s*\}\)/g
const EMPTY_CATCH_REPLACEMENT = ".catch(e => console.warn('[background]', e?.message || e))"

/** Matches `log.info(` */
const CONSOLE_LOG_RE = /console\.log\(/g
const CONSOLE_LOG_REPLACEMENT = 'log.info('

/**
 * SQL queries against funding_opportunities that do NOT reference profile_id.
 * We detect SELECT/UPDATE/DELETE statements touching the table without the
 * isolation guard.  This is REPORT-ONLY — we never auto-fix SQL.
 */
const PROFILE_BLEED_TABLE_RE = /funding_opportunities/i
const PROFILE_BLEED_ISOLATION_RE = /profile_id/i

/**
 * Chained `<expr>.prepare(<sql>).<method>(...)` where method is all/get/run.
 * The capture intentionally stops at the inner `(` so the replacement can
 * inject `await ` directly in front of the chain head.
 *
 * NB: this regex is intentionally only chained-form. Two-step bindings like
 *   const stmt = db.prepare('...')
 *   const row = stmt.get(id)            // <-- not detected, by design
 * are out of scope because the shape of the surrounding context is too
 * variable to repair safely. The chained form is by far the most common
 * pattern in our routes and is responsible for every "missing await"
 * production 500 we have shipped a fix for in 2026-04/05.
 */
// IMPORTANT: the body of prepare(...) must NOT span across statement
// boundaries. The codebase uses a no-semi style, so a `;` boundary alone is
// not sufficient -- we also reject statement-introducing keywords inside the
// lazy body (`const`, `let`, `var`, `return`, `await`, control-flow words).
// Real SQL strings never contain those tokens, but a 2-step pattern always
// will (`const s = db.prepare(sql)` followed by ` ... await s.run()`).
// Without this guard the regex bridges across the closing paren of prepare
// into a much later chained `.run(`, and the applier injects `await` in
// front of the prepare statement -- which is wrong and was the root cause
// of the 90+ false-positive rewrites that landed in the previous repair
// pass before being reverted.
const DB_PREPARE_CALL_RE = new RegExp(
  String.raw`(\b(?:\w+\.)*\w*[Dd]b\.prepare\s*\(` +
    String.raw`(?:(?!\b(?:const|let|var|return|await|if|for|while|function|=>)\b)[^;])*?` +
    String.raw`\)\s*\.\s*(?:all|get|run)\s*\()`,
  'g',
)

/**
 * Known column-name typos that compile against zero production migrations
 * and turn the entire route into a 500 on Postgres (the SQLite test fixture
 * masks the bug because the route's own test invents the typo'd column).
 * Each entry maps the bad token → the canonical column name in
 * `backend/db/schema.sql`. Values must be verifiable in production — never
 * add a "guess" here.
 */
const COLUMN_TYPOS = {
  requires_matching_funds: 'requires_match',
}

/**
 * Detect a `console.error(...)` call that is followed (within 6 lines) by
 * `res.status(500)` in the same catch block — the canonical "route returned
 * 500 with an opaque error" pattern. Auto-fix uses `routeLogger.error(...)`
 * iff a `const routeLogger = createLogger(...)` declaration already exists
 * in the file. Otherwise we emit a finding and let a human wire up the
 * logger.
 */
const ROUTE_LOGGER_DECL_RE = /\b(?:const|let|var)\s+routeLogger\s*=/
const UNSTRUCTURED_500_RE =
  /console\.error\(([^\n]*?)\)\s*\n([\s\S]{0,300}?)res\.status\(500\)/g

/**
 * JSX maps over an array whose name signals "structured backend record"
 * (match_reasons, trust_reasons, matched_needs, matched_fields,
 * matchReasons, reviewReasons, etc.) and renders the iteration variable
 * directly as `{var}` without coercion. This is the React #31 ("Objects
 * are not valid as a React child") shape that crashed multiple routes in
 * production — first GrantDetail/Dashboard via match_reasons (commit
 * 973cfcac), then GrantDetail again via matched_needs.
 *
 * Detection only — repair would also need to insert an import for
 * `formatReasonText` from `@/utils/reasonText`, which is too invasive
 * for a regex-driven applier. We surface every site so a human can
 * wrap it.
 */
const REASON_LIKE_VAR_RE = /\b\w*(?:[Rr]easons?|matched_needs|matched_fields|matchedNeeds|matchedFields)\b/
const REASON_MAP_RENDER_RE =
  /\b(\w*(?:[Rr]easons?|matched_needs|matched_fields|matchedNeeds|matchedFields))\b\s*(?:\.slice\([^)]*\))?\s*\.map\s*\(\s*\(?\s*(\w+)\b[^)]*\)\s*=>\s*\(?\s*<[^>]+>\s*\{\2\}\s*</g

/**
 * Direct-route fetch of /api/profiles/<id> from a frontend file when the
 * id can be the UI-only __admin__ sentinel. We detect any string or
 * template literal that interpolates an id segment after /api/profiles/
 * inside src/ when the file does not import the boundary guard
 * assertRealProfileId from @/api/profileIdGuards (or a relative path
 * equivalent). The Documents page reproduced this in production
 * (admin login -> /api/profiles/__admin__ 404).
 *
 * Report-only; auto-fix would need to wire up an import + a runtime
 * guard, which is too invasive for a regex applier.
 */
const PROFILE_FETCH_TEMPLATE_RE = /['"`]\/api\/profiles\/(?:\$\{|\$\()/g
const PROFILE_GUARD_IMPORT_RE = /from\s+['"][^'"]*profileIdGuards['"]/

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
 * Scan a single file for `log.info(` in route handler files.
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

/**
 * Scan for chained `db.prepare(...).all/get/run(...)` calls that are NOT
 * preceded by `await`. Returns an array of {line, snippet} entries.
 *
 * False-positive control:
 *   - Skipped when the file does not contain `async ` at all (no async
 *     context to await in).
 *   - Skipped when the immediately-preceding 12 chars contain `await `
 *     (chained calls like `await db.prepare(...).all()` are correct).
 *   - Skipped inside `// ` line comments.
 */
function scanMissingDbAwait(filePath, content) {
  if (!content.includes('async ')) return { issues: [] }
  // Strip comments first so JSDoc / inline comments that reference the
  // anti-pattern (e.g. our own module header) don't get reported.
  const view = stripCommentsPreservingLayout(content)
  const issues = []
  for (const match of view.matchAll(DB_PREPARE_CALL_RE)) {
    const offset = match.index ?? 0
    const before = view.slice(Math.max(0, offset - 12), offset)
    if (/\bawait\s*$/.test(before)) continue
    const lineNum = view.slice(0, offset).split('\n').length
    const lineStart = view.lastIndexOf('\n', offset) + 1
    const lineEnd = view.indexOf('\n', offset)
    // Use the ORIGINAL content for the snippet so the reported line is
    // human-readable (the stripped view has comments replaced with spaces).
    const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
    issues.push({ line: lineNum, snippet: line.slice(0, 160) })
  }
  return { issues }
}

/**
 * Scan for known column-name typos. Returns one issue per match.
 */
function scanColumnTypos(filePath, content) {
  // Strip comments so the COLUMN_TYPOS dictionary itself (defined in this
  // very service) and any JSDoc that discusses the typo don't get reported.
  const view = stripCommentsPreservingLayout(content)
  const issues = []
  for (const [typo, canonical] of Object.entries(COLUMN_TYPOS)) {
    const re = new RegExp(`\\b${typo}\\b`, 'g')
    for (const m of view.matchAll(re)) {
      const idx = m.index ?? 0
      const lineNum = view.slice(0, idx).split('\n').length
      const lineStart = view.lastIndexOf('\n', idx) + 1
      const lineEnd = view.indexOf('\n', idx)
      const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
      issues.push({
        line: lineNum,
        typo,
        canonical,
        snippet: line.slice(0, 160),
      })
    }
  }
  return { issues }
}

/**
 * Scan for `console.error(...)` followed by `res.status(500)` in route files.
 */
function scanUnstructured500(filePath, content) {
  if (!ROUTE_FILES_PATTERN.test(filePath)) return { issues: [], canAutoFix: false }
  const issues = []
  const canAutoFix = ROUTE_LOGGER_DECL_RE.test(content)
  for (const match of content.matchAll(UNSTRUCTURED_500_RE)) {
    const offset = match.index ?? 0
    const lineNum = content.slice(0, offset).split('\n').length
    issues.push({ line: lineNum, snippet: match[0].split('\n')[0].trim().slice(0, 160) })
  }
  return { issues, canAutoFix }
}

/**
 * Scan for JSX renders of `*reasons*` / `matched_needs` / `matched_fields`
 * map variables without coercion. This is the React #31 fingerprint.
 * Report-only — auto-fix would also need to insert/verify
 * `import { formatReasonText } from '@/utils/reasonText'`, which is
 * unsafe for a regex-driven applier.
 */
function scanReasonObjectRender(filePath, content) {
  if (!/\.(jsx|tsx)$/.test(filePath)) return { issues: [] }
  // Cheap pre-filter: skip files that already use formatReasonText (they
  // were repaired in commit 973cfcac and any new sites should use the same
  // helper).
  if (content.includes('formatReasonText')) return { issues: [] }
  if (!REASON_LIKE_VAR_RE.test(content)) return { issues: [] }
  const issues = []
  for (const match of content.matchAll(REASON_MAP_RENDER_RE)) {
    const offset = match.index ?? 0
    const lineNum = content.slice(0, offset).split('\n').length
    const lineStart = content.lastIndexOf('\n', offset) + 1
    const lineEnd = content.indexOf('\n', offset)
    const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
    issues.push({ line: lineNum, snippet: line.slice(0, 160) })
  }
  return { issues }
}

/**
 * Scan frontend files for direct `/api/profiles/${id}` HTTP calls that
 * skip the `assertRealProfileId` boundary guard. The Documents page
 * shipped this regression after admin login, where `id` could be the
 * UI-only `__admin__` sentinel and produced `404 Not Found`. We treat
 * any raw call as a finding when:
 *   1. the file lives under `src/`,
 *   2. it contains a `/api/profiles/${...}` template literal, AND
 *   3. it does NOT import `profileIdGuards` (so the boundary guard is
 *      not applied somewhere upstream).
 * Files that route through `getProfile` / `updateProfile` / etc. inside
 * `src/api/profiles.js` are safe because the helper applies the guard.
 *
 * Report-only — repair requires inserting an import and a guard, which
 * is too invasive for regex-driven autofix.
 */
function scanProfileAdminSentinel(filePath, content) {
  // Accept relative ("src/...") and absolute ("/.../src/...") paths.
  if (!/(?:^|[\\/])src[\\/]/.test(filePath)) return { issues: [] }
  if (!/\.(jsx?|tsx?|mjs)$/.test(filePath)) return { issues: [] }
  // The boundary itself + the helpers it gates are safe by construction.
  if (/(?:^|[\\/])src[\\/]api[\\/]profiles?(IdGuards)?\.js$/.test(filePath)) return { issues: [] }
  if (PROFILE_GUARD_IMPORT_RE.test(content)) return { issues: [] }
  // Use the comment-stripped view so a docstring that documents the
  // sentinel doesn't masquerade as a call site.
  const view = stripCommentsPreservingLayout(content)
  const issues = []
  for (const m of view.matchAll(PROFILE_FETCH_TEMPLATE_RE)) {
    const offset = m.index ?? 0
    const lineNum = view.slice(0, offset).split('\n').length
    const lineStart = view.lastIndexOf('\n', offset) + 1
    const lineEnd = view.indexOf('\n', offset)
    const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
    issues.push({ line: lineNum, snippet: line.slice(0, 160) })
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

/**
 * (Deprecated regex helper, retained only so existing tests that import it
 * keep type-checking. The current applyMissingDbAwait uses @babel/parser
 * for precise async-context detection — see callIsDbPrepareChain /
 * nearestAsyncFunction below.)
 */
function isInsideAsyncFunction(view, offset) {
  // Scan up to 20k chars back; that covers any reasonable enclosing
  // function while keeping the scan bounded.
  const start = Math.max(0, offset - 20000)
  const window = view.slice(start, offset)
  // Walk backward, balancing `{`/`}` to find the enclosing function-body
  // opening brace. We track depth: every `}` we encounter while walking
  // backward increases depth (we're "skipping" a sibling block); every `{`
  // decreases depth. When depth hits -1 we've found the enclosing block's
  // open brace.
  let depth = 0
  let i = window.length - 1
  let braceIdx = -1
  while (i >= 0) {
    const ch = window[i]
    if (ch === '}') depth++
    else if (ch === '{') {
      if (depth === 0) {
        braceIdx = i
        break
      }
      depth--
    }
    i--
  }
  if (braceIdx === -1) {
    // Not inside any block. Top-level module: ESM top-level await is OK.
    return true
  }
  // Look at the chars immediately before the `{`. The function signature
  // ends here. We allow up to 240 chars of signature lookback to cover
  // params spread over multiple lines.
  const sigStart = Math.max(0, braceIdx - 240)
  const sig = window.slice(sigStart, braceIdx).trim()
  // The signature ends right before the `{`, so we anchor patterns to the
  // END of `sig`. This is the critical invariant -- without it the regex
  // matches `async` keywords on SIBLING functions (e.g. an earlier
  // `beforeAll(async () => {` block) and false-flags later
  // non-async arrow callbacks like `beforeEach(() => {` as async, which
  // produced the test-suite parser regression in the first dry-run.
  // Arrow function: `... =>` at end of sig means the body's function is
  // an arrow function. Check whether the arrow is preceded by `async`.
  if (/=>\s*$/.test(sig)) {
    // Look for `async` immediately before the params or the arrow.
    return /\basync\s*\([^()]*\)\s*=>\s*$/.test(sig) || /\basync\s+[\w$]+\s*=>\s*$/.test(sig)
  }
  // Function expression: `function name(args)` or `function(args)` ending
  // right before the brace.
  const funcMatch = sig.match(/(?:^|[^\w$])(async\s+)?function\b[^()]*\([^()]*\)\s*$/)
  if (funcMatch) return Boolean(funcMatch[1])
  // Method shorthand inside an object/class: `name(args)` ending right
  // before the brace. Async methods are written `async name(args) { ... }`.
  const methodMatch = sig.match(/(?:^|[^\w$])(async\s+)?[\w$]+\s*\([^()]*\)\s*$/)
  if (methodMatch) return Boolean(methodMatch[1])
  // Could not determine signature shape (likely a bare block `{ ... }`,
  // catch handler, or an unusual layout). Default conservatively to true:
  // bare blocks inherit the async context from their enclosing function,
  // and a try/catch sits inside whatever function wraps it.
  return true
}

/**
 * AST helpers for missing_db_await detection.
 *
 * The original regex-based applier produced parser-error regressions
 * because it could not reliably tell whether a chained
 * `db.prepare().run()` call sat inside an async function body, a
 * synchronous `db.transaction(() => { ... })` callback, a top-level
 * `.forEach((x) => { ... })` migration, or an arrow expression body. We
 * now parse with @babel/parser, walk the AST, and only fire on calls
 * whose nearest enclosing function is `async: true`. This eliminates
 * both classes of false positive (sibling-async match,
 * arrow-expression-body match) without giving up any genuine fixes.
 */
function callIsDbPrepareChain(node) {
  if (!node || node.type !== 'CallExpression') return false
  const outerCallee = node.callee
  if (!outerCallee || outerCallee.type !== 'MemberExpression') return false
  const outerProp = outerCallee.property
  const outerName =
    outerProp?.type === 'Identifier'
      ? outerProp.name
      : outerProp?.type === 'StringLiteral'
        ? outerProp.value
        : null
  if (outerName !== 'get' && outerName !== 'all' && outerName !== 'run') return false
  const inner = outerCallee.object
  if (!inner || inner.type !== 'CallExpression') return false
  const innerCallee = inner.callee
  if (!innerCallee || innerCallee.type !== 'MemberExpression') return false
  const innerProp = innerCallee.property
  const innerName =
    innerProp?.type === 'Identifier'
      ? innerProp.name
      : innerProp?.type === 'StringLiteral'
        ? innerProp.value
        : null
  if (innerName !== 'prepare') return false
  // The receiver of `.prepare` must be something that ends in `db` or `_db`
  // (e.g. `req.db`, `this._db`, `singleton._db`).
  let receiver = innerCallee.object
  while (receiver && receiver.type === 'MemberExpression') {
    receiver = receiver.property
  }
  const receiverName =
    receiver?.type === 'Identifier'
      ? receiver.name
      : receiver?.type === 'StringLiteral'
        ? receiver.value
        : null
  if (!receiverName) return false
  return /[Dd]b$/.test(receiverName)
}

function walkAstForDbCalls(node, parents, onCall) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walkAstForDbCalls(child, parents, onCall)
    return
  }
  if (typeof node.type !== 'string') return
  if (node.type === 'CallExpression' && callIsDbPrepareChain(node)) {
    onCall(node, parents)
  }
  parents.push(node)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue
    const child = node[key]
    if (child && (Array.isArray(child) || typeof child === 'object')) {
      walkAstForDbCalls(child, parents, onCall)
    }
  }
  parents.pop()
}

function nearestAsyncFunction(parents) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i]
    if (
      p.type === 'FunctionDeclaration' ||
      p.type === 'FunctionExpression' ||
      p.type === 'ArrowFunctionExpression' ||
      p.type === 'ObjectMethod' ||
      p.type === 'ClassMethod'
    ) {
      return p.async === true
    }
    if (p.type === 'Program') {
      // Top-level: ESM modules support top-level await; CommonJS does not.
      return p.sourceType === 'module'
    }
  }
  return false
}

/**
 * Apply missing_db_await repair: prepend `await ` to every chained
 * `db.prepare(...).all/get/run(...)` call whose nearest enclosing function
 * is async (and that isn't already wrapped in an AwaitExpression).
 */
function applyMissingDbAwait(content) {
  if (!content.includes('async ')) return { newContent: content, count: 0 }
  let ast
  try {
    ast = babelParse(content, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript', 'topLevelAwait'],
      errorRecovery: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
    })
  } catch {
    // Parse failure → skip silently; never crash the repair pass.
    return { newContent: content, count: 0 }
  }
  const offsets = []
  walkAstForDbCalls(ast.program, [ast.program], (node, parents) => {
    const parent = parents[parents.length - 1]
    if (parent && parent.type === 'AwaitExpression') return
    if (!nearestAsyncFunction(parents)) return
    if (typeof node.start === 'number') offsets.push(node.start)
  })
  if (offsets.length === 0) return { newContent: content, count: 0 }
  offsets.sort((a, b) => a - b)
  // Splice from the back so earlier offsets remain valid.
  let result = content
  for (let i = offsets.length - 1; i >= 0; i--) {
    result = `${result.slice(0, offsets[i])}await ${result.slice(offsets[i])}`
  }
  return { newContent: result, count: offsets.length }
}

/**
 * Apply column_typo repair: replace every `requires_matching_funds` (etc.)
 * with the canonical column name. We only rewrite the bare token so we
 * don't accidentally rewrite identifiers inside string-only contexts that
 * legitimately reference the typo (none today, but defensive). Backup +
 * audit log preserve the original.
 */
function applyColumnTypos(content) {
  let count = 0
  let result = content
  // Stripped view drives the offset list — never rewrite typos that appear
  // only inside comments (e.g. the COLUMN_TYPOS dictionary docstring).
  const view = stripCommentsPreservingLayout(content)
  for (const [typo, canonical] of Object.entries(COLUMN_TYPOS)) {
    const re = new RegExp(`\\b${typo}\\b`, 'g')
    const offsets = []
    for (const m of view.matchAll(re)) {
      offsets.push(m.index ?? 0)
    }
    for (let i = offsets.length - 1; i >= 0; i--) {
      const offset = offsets[i]
      result = result.slice(0, offset) + canonical + result.slice(offset + typo.length)
      count++
    }
  }
  return { newContent: result, count }
}

/**
 * Apply unstructured_500 repair: replace `console.error(...)` immediately
 * before `res.status(500)` with `routeLogger.error(...)`, iff the file
 * already declares a `routeLogger`. This is intentionally conservative —
 * if the logger isn't present we leave the call alone and let the
 * dry-run report flag the file for manual repair.
 */
function applyUnstructured500(filePath, content) {
  if (!ROUTE_FILES_PATTERN.test(filePath)) return { newContent: content, count: 0 }
  if (!ROUTE_LOGGER_DECL_RE.test(content)) return { newContent: content, count: 0 }
  let count = 0
  const newContent = content.replace(UNSTRUCTURED_500_RE, (match, args, between) => {
    count++
    return `routeLogger.error(${args})\n${between}res.status(500)`
  })
  return { newContent, count }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run `scripts/check-runtime-imports.mjs` as a child process and parse its
 * exit status. Returns an array of violation entries (each entry already
 * formatted by the script). Report-only: Dockerfile edits are too risky to
 * apply via regex.
 */
async function scanDockerfileDrift() {
  return new Promise((resolve) => {
    const checkScript = path.join(PROJECT_ROOT, 'scripts', 'check-runtime-imports.mjs')
    const violations = []
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, [checkScript], {
      cwd: PROJECT_ROOT,
      env: process.env,
    })
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', () => {
      resolve({ ok: true, violations: [], note: 'check-runtime-imports.mjs unavailable' })
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, violations: [], note: stdout.trim() })
        return
      }
      // Parse violations out of the stderr — the script prints `  - <rel>`
      // followed by `    <reason>` for each violation. We capture both.
      const lines = stderr.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s+-\s+(.+)$/)
        if (m) {
          const file = m[1].trim()
          const reason = (lines[i + 1] || '').trim()
          violations.push({ file, reason })
        }
      }
      resolve({ ok: false, violations, note: stderr.split('\n').slice(0, 5).join('\n') })
    })
  })
}

const ALL_REPAIR_TYPES = [
  'empty_catch',
  'console_log',
  'profile_bleed',
  'missing_db_await',
  'column_typo',
  'unstructured_500',
  'react_object_render',
  'dockerfile_drift',
  'profile_admin_sentinel',
]

/**
 * Run auto-repair scan (and optionally apply repairs).
 *
 * @param {object} db — db handle for audit logging
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=true]     — if true, report only
 * @param {string[]} [opts.repairTypes]     — subset of ALL_REPAIR_TYPES;
 *                                            defaults to all of them.
 * @returns {Promise<object>} report
 */
export async function runAutoRepair(db, { dryRun = true, repairTypes } = {}) {
  const types = Array.isArray(repairTypes) && repairTypes.length > 0
    ? repairTypes.filter(t => ALL_REPAIR_TYPES.includes(t))
    : ALL_REPAIR_TYPES

  const effectiveDryRun = Boolean(dryRun)

  const report = {
    dryRun: effectiveDryRun,
    writePolicy: ANYA_CODE_REPAIR_POLICY.scope,
    permissionRequired: ANYA_CODE_REPAIR_POLICY.permission_required,
    auditRequired: ANYA_CODE_REPAIR_POLICY.audit_required,
    scannedFiles: 0,
    repairTypes: types,
    findings: {
      empty_catch: [],
      console_log: [],
      profile_bleed: [],
      missing_db_await: [],
      column_typo: [],
      unstructured_500: [],
      react_object_render: [],
      dockerfile_drift: [],
      profile_admin_sentinel: [],
      repairs: [],
    },
    repaired: {
      empty_catch: 0,
      console_log: 0,
      missing_db_await: 0,
      column_typo: 0,
      unstructured_500: 0,
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
    if (isSelfSkipped(filePath)) continue

    let content
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch (err) {
      report.errors.push({ file: path.relative(PROJECT_ROOT, filePath), error: err.message })
      continue
    }

    let modified = false
    let newContent = content
    const rel = path.relative(PROJECT_ROOT, filePath)

    // --- empty_catch ---
    if (types.includes('empty_catch')) {
      const { matches } = scanEmptyCatch(filePath, newContent)
      if (matches > 0) {
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
      const { issues } = scanProfileBleed(filePath, newContent)
      if (issues.length > 0) {
        report.findings.profile_bleed.push({ file: rel, issues })
      }
    }

    // --- missing_db_await ---
    if (types.includes('missing_db_await')) {
      const { issues } = scanMissingDbAwait(filePath, newContent)
      if (issues.length > 0) {
        report.findings.missing_db_await.push({ file: rel, issues })

        if (!effectiveDryRun) {
          const { newContent: fixed, count } = applyMissingDbAwait(newContent)
          if (count > 0) {
            newContent = fixed
            modified = true
            report.repaired.missing_db_await += count
          }
        }
      }
    }

    // --- column_typo ---
    if (types.includes('column_typo')) {
      const { issues } = scanColumnTypos(filePath, newContent)
      if (issues.length > 0) {
        report.findings.column_typo.push({ file: rel, issues })

        if (!effectiveDryRun) {
          const { newContent: fixed, count } = applyColumnTypos(newContent)
          if (count > 0) {
            newContent = fixed
            modified = true
            report.repaired.column_typo += count
          }
        }
      }
    }

    // --- unstructured_500 ---
    if (types.includes('unstructured_500')) {
      const { issues, canAutoFix } = scanUnstructured500(filePath, newContent)
      if (issues.length > 0) {
        report.findings.unstructured_500.push({ file: rel, issues, canAutoFix })

        if (!effectiveDryRun && canAutoFix) {
          const { newContent: fixed, count } = applyUnstructured500(filePath, newContent)
          if (count > 0) {
            newContent = fixed
            modified = true
            report.repaired.unstructured_500 += count
          }
        }
      }
    }

    // --- react_object_render (always report-only) ---
    if (types.includes('react_object_render')) {
      const { issues } = scanReasonObjectRender(filePath, newContent)
      if (issues.length > 0) {
        report.findings.react_object_render.push({ file: rel, issues })
      }
    }

    // --- profile_admin_sentinel (always report-only) ---
    if (types.includes('profile_admin_sentinel')) {
      const { issues } = scanProfileAdminSentinel(filePath, newContent)
      if (issues.length > 0) {
        report.findings.profile_admin_sentinel.push({ file: rel, issues })
      }
    }

    // Write backup + apply changes
    if (modified) {
      try {
        const backupPath = await writeBackup(filePath, content)
        await fs.writeFile(filePath, newContent, 'utf8')
        const backupRel = path.relative(PROJECT_ROOT, backupPath)
        report.findings.repairs.push({
          file: rel,
          backup: backupRel,
          policy: ANYA_CODE_REPAIR_POLICY.scope,
          permissionRequired: ANYA_CODE_REPAIR_POLICY.permission_required,
          auditRequired: ANYA_CODE_REPAIR_POLICY.audit_required,
        })
      } catch (err) {
        report.errors.push({ file: rel, error: `Write failed: ${err.message}` })
      }
    }
  }

  // --- dockerfile_drift (project-level, runs once) ---
  if (types.includes('dockerfile_drift')) {
    try {
      const result = await scanDockerfileDrift()
      if (!result.ok && result.violations.length > 0) {
        report.findings.dockerfile_drift.push(...result.violations)
      }
    } catch (err) {
      report.errors.push({ scanner: 'dockerfile_drift', error: err.message })
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
        writePolicy: ANYA_CODE_REPAIR_POLICY.scope,
        permissionRequired: ANYA_CODE_REPAIR_POLICY.permission_required,
        auditRequired: ANYA_CODE_REPAIR_POLICY.audit_required,
        repairTypes: types,
        scannedFiles: report.scannedFiles,
        emptyCatchFindings: report.findings.empty_catch.length,
        consoleLogFindings: report.findings.console_log.length,
        profileBleedFindings: report.findings.profile_bleed.length,
        missingDbAwaitFindings: report.findings.missing_db_await.length,
        columnTypoFindings: report.findings.column_typo.length,
        unstructured500Findings: report.findings.unstructured_500.length,
        reactObjectRenderFindings: report.findings.react_object_render.length,
        dockerfileDriftFindings: report.findings.dockerfile_drift.length,
        profileAdminSentinelFindings: report.findings.profile_admin_sentinel.length,
        repairedEmptyCatch: report.repaired.empty_catch,
        repairedConsoleLog: report.repaired.console_log,
        repairedMissingDbAwait: report.repaired.missing_db_await,
        repairedColumnTypo: report.repaired.column_typo,
        repairedUnstructured500: report.repaired.unstructured_500,
      },
    })
  } catch {
    // Audit logging is best-effort — never block the repair report
  }

  return report
}

// Exposed for tests / tooling — the canonical list of repair types this
// service knows about. Keep `runAutoRepair`'s default in sync.
export const AUTO_REPAIR_TYPES = ALL_REPAIR_TYPES

// Internal helpers exported for unit tests. Tests should never invoke
// `runAutoRepair` against the live repo with `dryRun=false` because that
// would walk every file under backend/ and src/ and apply rewrites
// globally. Instead, test the pure scanner/applier pairs against in-memory
// strings — that's what these named exports are for.
export const __testHelpers = {
  scanEmptyCatch,
  scanConsoleLog,
  scanProfileBleed,
  scanMissingDbAwait,
  scanColumnTypos,
  scanUnstructured500,
  scanReasonObjectRender,
  scanProfileAdminSentinel,
  applyEmptyCatch,
  applyConsoleLog,
  applyMissingDbAwait,
  applyColumnTypos,
  applyUnstructured500,
}
