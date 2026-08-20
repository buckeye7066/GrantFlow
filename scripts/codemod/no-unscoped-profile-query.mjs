#!/usr/bin/env node
/**
 * scripts/codemod/no-unscoped-profile-query.mjs
 *
 * Shift-left companion to backend/db/scopedQuery.js. Walks backend/routes/*.js
 * and flags `db.prepare(\`... FROM <scoped-table> ...\`)` (and .query()) calls
 * that do not contain a profile_id predicate literally in the SQL.
 *
 * The runtime guard in backend/db/scopedQuery.js is the authoritative contract;
 * this check exists so offending code is caught in CI before it lands.
 *
 * Usage: npm run profile-scope:check
 * Exit 0 = clean; 1 = violations.
 */

import fs from 'fs'
import path from 'path'

const SCOPED_TABLES = new Set([
  'grants',
  'opportunities',
  'saved_grants',
  'applications',
  'application_steps',
  'application_events',
  'documents',
  'matches',
  'decisions',
  'profile_needs',
  'profile_sections',
  'profile_section_answers',
  'organizations',
  'anya_sessions',
  'anya_brain_memory',
  'anya_tool_usage',
  'anya_tool_registry_snapshot',
])

const ROOTS = [path.resolve(process.cwd(), 'backend', 'routes')]
const allowFile = (f) => /\.js$/.test(f)

const violations = []

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (e.isFile() && allowFile(e.name)) audit(full)
  }
}

function audit(file) {
  const src = fs.readFileSync(file, 'utf8')
  const rel = path.relative(process.cwd(), file)
  // Extract every backtick SQL passed to db.prepare / pool.query / db.query
  const sqlRe = /\b(?:db|pool|client|this\.db|req\.db)\.(?:prepare|query|raw)\s*\(\s*`([\s\S]*?)`/g
  let m
  while ((m = sqlRe.exec(src)) !== null) {
    const sql = m[1]
    const upper = sql.toUpperCase()
    // Ignore DDL/pragmas/transaction control.
    if (/^\s*(CREATE|ALTER|DROP|PRAGMA|BEGIN|COMMIT|ROLLBACK|EXPLAIN|VACUUM|ATTACH|DETACH)\b/.test(upper)) continue
    const lineNo = src.slice(0, m.index).split('\n').length
    const lineText = src.split('\n')[lineNo - 1] || ''
    if (/audit:allow\s+unscoped-profile-query/i.test(lineText)) continue
    if (lineNo >= 2 && /audit:allow\s+unscoped-profile-query/i.test(src.split('\n')[lineNo - 2] || '')) continue

    const tableRe = /\b(FROM|JOIN|INTO|UPDATE)\s+(?:ONLY\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/g
    const hit = []
    let tm
    while ((tm = tableRe.exec(upper)) !== null) {
      const tbl = tm[2].toLowerCase()
      if (SCOPED_TABLES.has(tbl)) hit.push(tbl)
    }
    if (hit.length === 0) continue
    const hasPred =
      /\bPROFILE_ID\s*=\s*(\?|\$\d+|:[A-Z_][A-Z0-9_]*|@[A-Z_][A-Z0-9_]*)/.test(upper) ||
      /\.\s*PROFILE_ID\s*=\s*(\?|\$\d+|:[A-Z_][A-Z0-9_]*|@[A-Z_][A-Z0-9_]*)/.test(upper) ||
      /\bPROFILE_ID\s+IN\s*\(/.test(upper) ||
      (upper.startsWith('INSERT') && /\bINSERT\s+INTO\s+[A-Z_][A-Z0-9_]*\s*\([^)]*\bPROFILE_ID\b/.test(upper)) ||
      /\bWHERE\s+1\s*=\s*0\b/.test(upper)
    if (hasPred) continue
    violations.push({ file: rel, line: lineNo, tables: [...new Set(hit)], snippet: sql.slice(0, 140).replace(/\s+/g, ' ').trim() })
  }
}

for (const root of ROOTS) if (fs.existsSync(root)) walk(root)

if (violations.length === 0) {
  console.log('[profile-scope] OK (0 unscoped queries on profile-scoped tables in backend/routes)')
  process.exit(0)
}

console.error(`[profile-scope] FAIL (${violations.length} unscoped queries)`)
for (const v of violations.slice(0, 200)) {
  console.error(`  ${v.file}:${v.line}  [${v.tables.join(',')}]  ${v.snippet}`)
}
if (violations.length > 200) console.error(`  ... and ${violations.length - 200} more`)
console.error('')
console.error('  Remediation:')
console.error("    1. Add `AND profile_id = ?` (or $N) to the SQL")
console.error("    2. Or annotate with `// audit:allow unscoped-profile-query` after verification")
console.error('    3. Runtime guard (backend/db/scopedQuery.js) will also catch this at request time')
// This gate IS reached by CI — `scripts/release-gates.mjs` runs
// `profile-scope:check`, and `.github/workflows/ci.yml` runs `npm run
// release:gates` on every PR and every push to main. But it printed
// "[profile-scope] FAIL (N unscoped queries)" and then exited 0 unless
// PROFILE_SCOPE_CI_STRICT=1, and that variable is set in NO workflow, NO
// script and NO Dockerfile — it appears only commented out in .env.example and
// in docs. So the cross-tenant scoping gate emitted a log line that reads like
// enforcement while returning green, which is strictly worse than having no
// gate: a reviewer scanning for red sees none.
//
// Verified before removing the hatch: `node
// scripts/codemod/no-unscoped-profile-query.mjs` on origin/main f670ef24 prints
// "OK (0 unscoped queries...)" and exits 0. The rollout the hatch was written
// for is over, so the report-only mode is removed outright rather than being
// re-hidden behind a different flag.
//
// The escape valve for a genuine false positive is unchanged and per-site:
// annotate the line with `// audit:allow unscoped-profile-query`.
process.exit(1)
