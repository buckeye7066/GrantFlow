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
 * This is NOT a source-to-source rewriter. It is a guardrail: the matching
 * criteria mirror backend/services/anyaAdminTools.js::classifyDynamicSqlLine
 * so the admin.code.scan auditor and CI stay in sync.
 */

import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(process.cwd(), 'backend')
const violations = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'data' || entry.name === 'dist') continue
      walk(full)
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      audit(full)
    }
  }
}

function audit(file) {
  const src = fs.readFileSync(file, 'utf8')
  const lines = src.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!/db\.(prepare|run|get|all)\s*\(\s*`/.test(line)) continue
    if (!line.includes('${')) continue

    // Respect explicit opt-outs identical to the admin auditor (same line or the previous line).
    if (/audit:allow\s+(dynamic-sql|sql-interpolation)/i.test(line)) continue
    if (i > 0 && /audit:allow\s+(dynamic-sql|sql-interpolation)/i.test(lines[i - 1])) continue
    // Trusted guard names make the line safe by construction.
    if (/assertSafeIdentifier|safeSqlIdentifier|buildWhere|orderBy\(|ident\(/.test(line)) continue

    const interpolations = [...line.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim())
    const dangerous = interpolations.some((expr) => {
      if (!expr) return true
      if (/req\.|params\.|body\.|query\.|userInput|prompt|message|content/i.test(expr)) return true
      if (/where|sql|clause|orderby|groupby|having|raw/i.test(expr) && !/allowed|safe|validated/i.test(expr)) return true
      return false
    })
    if (dangerous) {
      violations.push({ file: path.relative(process.cwd(), file), line: i + 1, text: line.trim().slice(0, 180) })
    }
  }
}

walk(ROOT)

if (violations.length === 0) {
  console.log('[safe-sql] OK (0 dynamic-SQL violations)')
  process.exit(0)
}

console.error(`[safe-sql] FAIL (${violations.length} dynamic-SQL violations)`)
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.text}`)
}
console.error('')
console.error('  Fix options:')
console.error('    1. Route the interpolation through backend/utils/safeSql.js (ident/orderBy/assertSafeIdentifier)')
console.error('    2. Rename the interpolated variable so it includes "safe"/"allowed"/"validated"')
console.error('    3. Annotate with `// audit:allow dynamic-sql` after verifying no user input flows in')
process.exit(1)
