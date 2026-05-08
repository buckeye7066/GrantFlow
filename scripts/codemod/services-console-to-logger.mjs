#!/usr/bin/env node
/**
 * Targeted codemod: migrate `console.log/info/debug(...)` calls inside
 * backend/services/** to the project's structured logger
 * (backend/utils/logger.js). `console.warn` and `console.error` are kept
 * (they are ALSO carried by the logger but the existing eslint allowlist
 * lets them stand; converting them is out of scope for this readiness pass).
 *
 * Why this exists:
 *   The repository's `lint:strict` script runs eslint with
 *   `--max-warnings 0`. backend/services/** had 352 `no-console` warnings
 *   left over from an in-progress logger migration documented at
 *   eslint.config.js#L66-L73. Each call site is a mechanical 1:1 replace
 *   — the logger preserves `console.log`'s signature for debug/info while
 *   adding namespace prefix, log-level gating, and the in-memory ring
 *   buffer that powers admin.health.logs.
 *
 * What it does NOT touch:
 *   - backend/services/sharedLoggers.js / backend/utils/logger.js (core
 *     infrastructure — would create import cycles).
 *   - Files that already import `createLogger` and have `const log = ...`.
 *   - Files outside backend/services/.
 *   - console.warn / console.error (kept by the eslint allowlist).
 *
 * Idempotent: re-running on a migrated file is a no-op.
 *
 * Usage:
 *   node scripts/codemod/services-console-to-logger.mjs           # report
 *   node scripts/codemod/services-console-to-logger.mjs --apply   # write
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, relative, dirname, basename, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const SERVICES_ROOT = join(REPO_ROOT, 'backend', 'services')
const LOGGER_ABS_PATH = join(REPO_ROOT, 'backend', 'utils', 'logger.js')

const APPLY = process.argv.includes('--apply')
const VERBOSE = process.argv.includes('--verbose')

// Files we must never rewrite (would create cycles or otherwise break).
const SKIP_FILES = new Set([
  // Add absolute paths here if any service ever owns its own logger.
])

function walk(dir) {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(full))
    else if (ent.isFile() && /\.(js|mjs|cjs)$/.test(ent.name)) out.push(full)
  }
  return out
}

function loggerImportPath(fileAbsPath) {
  const fromDir = dirname(fileAbsPath)
  let rel = relative(fromDir, LOGGER_ABS_PATH).split(sep).join('/')
  if (!rel.startsWith('.')) rel = './' + rel
  return rel
}

function namespaceFor(fileAbsPath) {
  const base = basename(fileAbsPath, extname(fileAbsPath))
  return base.replace(/[^A-Za-z0-9_-]/g, '') || 'service'
}

function alreadyHasLoggerImport(src) {
  return /from\s+['"][^'"]*utils\/logger(?:\.js)?['"]/m.test(src)
}

function alreadyHasLogConst(src) {
  return /\b(?:const|let|var)\s+log\s*=\s*createLogger\s*\(/m.test(src)
}

function findInsertionPointAfterImports(src) {
  // Find the line after the last top-level static `import ... from ...;` or
  // `const x = require(...)`. Keep the same ordering style as the file.
  const lines = src.split(/\r?\n/)
  let lastImportIdx = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(import\s.+from\s+['"][^'"]+['"];?\s*|import\s+['"][^'"]+['"];?\s*)$/.test(line)) {
      lastImportIdx = i
    } else if (/^\s*(const|let|var)\s+\w+\s*=\s*require\(['"][^'"]+['"]\)/.test(line)) {
      lastImportIdx = i
    }
  }
  return lastImportIdx + 1
}

function rewriteFile(absPath) {
  if (SKIP_FILES.has(absPath)) return { skipped: 'skip-list' }
  const src = readFileSync(absPath, 'utf8')

  // No work needed if the file has no console.log/info/debug call.
  if (!/console\.(log|info|debug)\s*\(/.test(src)) {
    return { skipped: 'no-targets' }
  }

  let next = src
  const ns = namespaceFor(absPath)
  const importPath = loggerImportPath(absPath)

  // 1) Add the logger import if missing.
  if (!alreadyHasLoggerImport(next)) {
    const insertAt = findInsertionPointAfterImports(next)
    const lines = next.split(/\r?\n/)
    lines.splice(insertAt, 0, `import { createLogger } from '${importPath}'`)
    next = lines.join('\n')
  }

  // 2) Add the `const log = createLogger('<ns>')` if missing.
  if (!alreadyHasLogConst(next)) {
    const insertAt = findInsertionPointAfterImports(next)
    const lines = next.split(/\r?\n/)
    // Make sure the createLogger import is now treated as the last import for
    // the const placement: re-find the insertion point.
    let lastImportIdx = -1
    for (let i = 0; i < lines.length; i += 1) {
      if (/from\s+['"][^'"]*utils\/logger(?:\.js)?['"]/m.test(lines[i])) lastImportIdx = i
      else if (/^\s*(import\s.+from\s+['"][^'"]+['"];?\s*|import\s+['"][^'"]+['"];?\s*)$/.test(lines[i])) {
        if (i > lastImportIdx) lastImportIdx = i
      }
    }
    const placeAt = (lastImportIdx >= 0 ? lastImportIdx + 1 : insertAt)
    lines.splice(placeAt, 0, `const log = createLogger('${ns}')`)
    next = lines.join('\n')
  }

  // 3) Mechanical replacement of console.{log,info,debug} call sites.
  let replaced = 0
  next = next.replace(/console\.(log|info|debug)\s*\(/g, (_m, level) => {
    replaced += 1
    return level === 'debug' ? 'log.debug(' : 'log.info('
  })

  if (next === src) return { skipped: 'unchanged' }
  if (APPLY) writeFileSync(absPath, next, 'utf8')
  return { changed: true, replaced }
}

function main() {
  const files = walk(SERVICES_ROOT).filter((f) => /\.(js|mjs|cjs)$/.test(f))
  let touched = 0
  let totalReplaced = 0
  const skips = { 'no-targets': 0, 'unchanged': 0, 'skip-list': 0 }
  for (const f of files) {
    const res = rewriteFile(f)
    if (res?.changed) {
      touched += 1
      totalReplaced += res.replaced
      if (VERBOSE) console.log(`changed ${relative(REPO_ROOT, f)} (${res.replaced})`)
    } else if (res?.skipped) {
      skips[res.skipped] = (skips[res.skipped] || 0) + 1
    }
  }
  console.log(
    JSON.stringify(
      {
        applied: APPLY,
        files_scanned: files.length,
        files_changed: touched,
        console_calls_replaced: totalReplaced,
        skipped: skips,
      },
      null,
      2,
    ),
  )
}

main()
