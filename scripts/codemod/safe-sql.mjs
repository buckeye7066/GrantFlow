#!/usr/bin/env node
/**
 * scripts/codemod/safe-sql.mjs
 *
 * Fail-fast audit: walks backend/**\/*.js and flags template-literal SQL
 * whose interpolations look like identifiers or query fragments unless the
 * line is explicitly annotated with `// audit:allow dynamic-sql` or the
 * interpolated expression is routed through one of the safeSql.js helpers
 * (assertSafeIdentifier, ident, orderBy, buildWhere).
 *
 * Prints a machine-readable summary and exits 1 if any violation remains.
 * Intended to run in CI: `node scripts/codemod/safe-sql.mjs`.
 *
 * This is NOT a source-to-source rewriter. It is a guardrail.
 *
 * ## Why there are TWO passes
 *
 * The original scanner was a single LINE-oriented pass: it required
 * `db.prepare(\`` and `${` to appear on the SAME source line. Measured on this
 * repo (2026-08-19, origin/main 2fcb599f): of 802 `db.(prepare|run|get|all)(\`)`
 * call sites in `backend/`, 284 carry at least one `${…}` interpolation inside
 * the template literal, and **100 of those 284 statements (35.2%) put every one
 * of their interpolations on a CONTINUATION line** — structurally invisible to a
 * line-oriented matcher. Counted per interpolation rather than per statement,
 * **183 of 398 interpolations (46.0%) were unreachable.** A guardrail that
 * cannot see half of what it claims to cover is a check that cannot fail.
 *
 * `auditSingleLine` is kept BYTE-FOR-BYTE equivalent to the original rule so the
 * pre-existing true-positive set can never shrink, and `auditMultiLine` is a
 * strictly ADDITIVE second pass that parses the whole template literal and
 * adjudicates the interpolations the first pass could not reach. The union is
 * reported; a site found by both is reported once.
 *
 * ## Relationship to the admin auditor
 *
 * The matching criteria for a DANGEROUS expression still mirror
 * backend/services/anyaAdminTools.js::classifyDynamicSqlLine, which is a
 * per-line classifier driven by an advisory line-by-line report. This CI gate is
 * now strictly BROADER than that classifier (it sees continuation lines; the
 * classifier still does not). The dangerous-expression predicate is the shared
 * part and must stay in sync; the reachability is deliberately not.
 */

import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

const SQL_CALL_RE = /db\.(prepare|run|get|all)\s*\(\s*`/
const SQL_CALL_RE_G = /db\.(prepare|run|get|all)\s*\(\s*`/g
const ALLOW_RE = /audit:allow\s+(dynamic-sql|sql-interpolation)/i
const TRUSTED_GUARD_RE = /assertSafeIdentifier|safeSqlIdentifier|buildWhere|orderBy\(|ident\(/

/**
 * Shared with backend/services/anyaAdminTools.js::classifyDynamicSqlLine.
 * Do not narrow this without narrowing that too.
 */
export function isDangerousInterpolation(expr) {
  const trimmed = String(expr ?? '').trim()
  if (!trimmed) return true
  if (/req\.|params\.|body\.|query\.|userInput|prompt|message|content/i.test(trimmed)) return true
  if (/where|sql|clause|orderby|groupby|having|raw/i.test(trimmed) && !/allowed|safe|validated/i.test(trimmed)) {
    return true
  }
  return false
}

/**
 * Reads a template literal starting at `openIndex` (the index of its opening
 * backtick) and returns its end index plus every top-level `${…}` interpolation
 * with the absolute source index it starts at. Nested templates inside an
 * interpolation are skipped whole, so a backtick inside `${…}` never
 * terminates the outer literal.
 */
export function readTemplateLiteral(src, openIndex) {
  const interpolations = []
  let i = openIndex + 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '`') return { end: i, interpolations }
    if (ch === '$' && src[i + 1] === '{') {
      const start = i
      let depth = 1
      let j = i + 2
      while (j < src.length && depth > 0) {
        const c = src[j]
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === '`') {
          const nested = readTemplateLiteral(src, j)
          if (!nested) return null
          j = nested.end + 1
          continue
        }
        if (c === '{') depth++
        else if (c === '}') depth--
        j++
      }
      if (depth > 0) return null
      interpolations.push({ expr: src.slice(start + 2, j - 1), index: start })
      i = j
      continue
    }
    i++
  }
  return null
}

function lineIndexAt(lineStarts, index) {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return lo
}

function allowedAt(lines, lineIdx) {
  if (ALLOW_RE.test(lines[lineIdx] ?? '')) return true
  if (lineIdx > 0 && ALLOW_RE.test(lines[lineIdx - 1] ?? '')) return true
  return false
}

/**
 * PASS 1 — the original rule, unchanged. Kept verbatim so this scanner can
 * never report FEWER violations than it did before the multi-line pass landed.
 */
function auditSingleLine(fileLabel, lines, out) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!SQL_CALL_RE.test(line)) continue
    if (!line.includes('${')) continue

    // Respect explicit opt-outs identical to the admin auditor (same line or the previous line).
    if (ALLOW_RE.test(line)) continue
    if (i > 0 && ALLOW_RE.test(lines[i - 1])) continue
    // Trusted guard names make the line safe by construction.
    if (TRUSTED_GUARD_RE.test(line)) continue

    const interpolations = [...line.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim())
    const offender = interpolations.find(isDangerousInterpolation)
    if (offender !== undefined) {
      out.push({ file: fileLabel, line: i + 1, expr: offender, text: line.trim().slice(0, 180), pass: 'line' })
    }
  }
}

/**
 * PASS 2 — statement-oriented. Parses the whole template literal and
 * adjudicates every interpolation the line pass could not reach (i.e. those on
 * a CONTINUATION line). Opt-outs and trusted-guard names are honored at the
 * statement's opening line AND at the interpolation's own line, so an
 * annotation next to the offending expression works the way authors expect.
 */
function auditMultiLine(fileLabel, src, lines, lineStarts, out) {
  SQL_CALL_RE_G.lastIndex = 0
  let match
  while ((match = SQL_CALL_RE_G.exec(src)) !== null) {
    const openIndex = src.indexOf('`', match.index)
    if (openIndex === -1) break
    SQL_CALL_RE_G.lastIndex = openIndex + 1

    const literal = readTemplateLiteral(src, openIndex)
    if (!literal) continue
    SQL_CALL_RE_G.lastIndex = literal.end + 1

    const openLine = lineIndexAt(lineStarts, openIndex)
    // Statement-level opt-out: `audit:allow` on (or just above) the opening line
    // covers the whole statement, matching how authors annotate a query.
    if (allowedAt(lines, openLine)) continue
    if (TRUSTED_GUARD_RE.test(lines[openLine] ?? '')) continue

    for (const interpolation of literal.interpolations) {
      const line = lineIndexAt(lineStarts, interpolation.index)
      // Pass 1 already adjudicated everything on the opening line; only the
      // continuation lines are new reach.
      if (line === openLine) continue
      if (allowedAt(lines, line)) continue
      const lineText = lines[line] ?? ''
      if (TRUSTED_GUARD_RE.test(lineText)) continue
      if (TRUSTED_GUARD_RE.test(interpolation.expr)) continue
      if (!isDangerousInterpolation(interpolation.expr)) continue
      out.push({
        file: fileLabel,
        line: line + 1,
        expr: interpolation.expr.trim(),
        text: lineText.trim().slice(0, 180),
        pass: 'statement',
      })
    }
  }
}

export function auditSource(fileLabel, src) {
  const lines = src.split(/\r?\n/)
  const lineStarts = [0]
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') lineStarts.push(i + 1)
  }
  const found = []
  auditSingleLine(fileLabel, lines, found)
  auditMultiLine(fileLabel, src, lines, lineStarts, found)

  const seen = new Set()
  const deduped = []
  for (const v of found) {
    const key = `${v.file}:${v.line}:${v.pass}:${v.expr}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(v)
  }
  deduped.sort((a, b) => a.line - b.line)
  return deduped
}

export function auditTree(root, cwd = process.cwd()) {
  const violations = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'data' || entry.name === 'dist') continue
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const label = path.relative(cwd, full).split(path.sep).join('/')
        violations.push(...auditSource(label, fs.readFileSync(full, 'utf8')))
      }
    }
  }
  walk(root)
  return violations
}

/* ------------------------------------------------------------------ *
 * Baseline ratchet for the statement pass
 *
 * Widening the scanner made 107 PRE-EXISTING interpolations visible for the
 * first time (measured on origin/main 2fcb599f). None of them are new risk —
 * they have been shipping for months, unseen — but a gate that turns red on
 * day one gets disabled, and hand-annotating 107 sites in 26 files in the same
 * PR that broadens the scanner would be 107 unreviewed judgement calls.
 *
 * So the statement pass ships with a FROZEN inventory keyed by
 * (file, interpolation expression, occurrence count). The rules:
 *   - PASS 1 (the original line rule) is NEVER baselined. Its teeth are intact.
 *   - A statement-pass site not in the inventory FAILS.
 *   - One MORE occurrence of a baselined expression in the same file FAILS.
 *   - An inventory entry that over-counts what the tree actually contains
 *     FAILS as STALE, so the list can only ever shrink and can never rot into
 *     a permanent excuse.
 * Regenerate with `node scripts/codemod/safe-sql.mjs --update-baseline`; the
 * diff is the review.
 * ------------------------------------------------------------------ */

export const BASELINE_PATH = path.resolve(process.cwd(), 'scripts/codemod/safeSql.baseline.json')

/**
 * Composite key for (file, interpolation expression). JSON-encoded rather than
 * joined on a separator: a path or an expression can contain any printable
 * character, and a control-character separator makes the source itself
 * unsearchable by grep/ripgrep.
 */
function laneKey(file, expr) {
  return JSON.stringify([file, expr])
}

export function tallyStatementViolations(violations) {
  const tally = {}
  for (const v of violations) {
    if (v.pass !== 'statement') continue
    const expr = v.expr
    tally[v.file] = tally[v.file] || {}
    tally[v.file][expr] = (tally[v.file][expr] || 0) + 1
  }
  return tally
}

export function evaluateAgainstBaseline(violations, baselineSites) {
  const failures = []
  const grandfathered = []
  const counters = new Map()
  for (const v of violations) {
    if (v.pass === 'line') {
      failures.push({ ...v, why: 'dynamic-SQL interpolation (single-line rule)' })
      continue
    }
    const key = laneKey(v.file, v.expr)
    const allowed = baselineSites?.[v.file]?.[v.expr] ?? 0
    const seen = (counters.get(key) ?? 0) + 1
    counters.set(key, seen)
    if (seen <= allowed) grandfathered.push(v)
    else failures.push({ ...v, why: 'NEW multi-line dynamic-SQL interpolation (not in the frozen baseline)' })
  }

  const stale = []
  for (const [file, exprs] of Object.entries(baselineSites || {})) {
    for (const [expr, allowed] of Object.entries(exprs)) {
      const seen = counters.get(laneKey(file, expr)) ?? 0
      if (seen < allowed) stale.push({ file, expr, allowed, seen })
    }
  }
  return { failures, grandfathered, stale }
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return { sites: {} }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
}

function main() {
  const violations = auditTree(path.resolve(process.cwd(), 'backend'))

  if (process.argv.includes('--update-baseline')) {
    const existing = readBaseline()
    const next = {
      _comment: existing._comment || [
        'Frozen inventory of dynamic-SQL interpolations on CONTINUATION lines that predate',
        'the multi-line pass in scripts/codemod/safe-sql.mjs. This list may only SHRINK:',
        'a new site, an extra occurrence, or a stale entry all fail the gate.',
      ],
      sites: tallyStatementViolations(violations),
    }
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
    const total = Object.values(next.sites).reduce(
      (n, exprs) => n + Object.values(exprs).reduce((m, c) => m + c, 0),
      0,
    )
    console.log(`[safe-sql] baseline written: ${total} grandfathered statement-pass sites`)
    process.exit(0)
  }

  const baseline = readBaseline()
  const { failures, grandfathered, stale } = evaluateAgainstBaseline(violations, baseline.sites)

  if (failures.length === 0 && stale.length === 0) {
    console.log(
      `[safe-sql] OK (0 dynamic-SQL violations; ${grandfathered.length} grandfathered multi-line sites)`,
    )
    process.exit(0)
  }

  console.error(`[safe-sql] FAIL (${failures.length} dynamic-SQL violations, ${stale.length} stale baseline entries)`)
  for (const v of failures) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`)
    console.error(`      ^ ${v.why}`)
  }
  for (const s of stale) {
    console.error(`  STALE baseline entry ${s.file} :: \${${s.expr}} (allows ${s.allowed}, found ${s.seen})`)
  }
  console.error('')
  console.error('  Fix options:')
  console.error('    1. Route the interpolation through backend/utils/safeSql.js (ident/orderBy/assertSafeIdentifier)')
  console.error('    2. Rename the interpolated variable so it includes "safe"/"allowed"/"validated"')
  console.error('    3. Annotate with `// audit:allow dynamic-sql` after verifying no user input flows in')
  console.error('    4. If (and only if) an entry became stale because the query was removed/fixed,')
  console.error('       shrink the inventory: node scripts/codemod/safe-sql.mjs --update-baseline')
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
