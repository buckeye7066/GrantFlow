#!/usr/bin/env node
/**
 * Codemod: replace console.log/info/debug with a namespaced logger in
 * backend/routes/**.
 *
 * Strategy per file:
 *   1. If no import of createLogger, inject it after the last top-level import.
 *   2. Ensure a module-scope `const routeLogger = createLogger('route:<basename>')`
 *   3. Rewrite:
 *        console.log(x, ...)   -> routeLogger.info(x, ...)
 *        console.info(x, ...)  -> routeLogger.info(x, ...)
 *        console.debug(x, ...) -> routeLogger.debug(x, ...)
 *      (console.warn / console.error are left alone — they pass the
 *       `no-console` eslint allow-list and usually represent real errors.)
 */

/* eslint-disable no-console */
import fs from 'node:fs'
import path from 'node:path'

const ROUTES_DIR = path.resolve(process.cwd(), 'backend', 'routes')

function listJs(dir, acc = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) listJs(full, acc)
    else if (e.isFile() && e.name.endsWith('.js')) acc.push(full)
  }
  return acc
}

function resolveLoggerImport(fromFile) {
  const loggerAbs = path.resolve(process.cwd(), 'backend', 'utils', 'logger.js')
  let rel = path.relative(path.dirname(fromFile), loggerAbs).replace(/\\/g, '/')
  if (!rel.startsWith('.')) rel = './' + rel
  return rel
}

function transform(filePath) {
  const src = fs.readFileSync(filePath, 'utf8')
  const basename = path.basename(filePath, '.js')
  let out = src
  let changed = 0

  // 1. Add logger import if missing.
  // Matches either a single-line import ending in quoted specifier, or the
  // closing line of a multi-line import (`} from '...'`). We pick the LAST
  // such line and insert the injection right after it so we never split a
  // multi-line import apart.
  const hasLoggerImport = /from ['"][./\\]+utils\/logger\.js['"]/.test(out) ||
    /from ['"][./\\]+utils\/logger['"]/.test(out)
  const hasRouteLogger = /\brouteLogger\b/.test(out)
  const importEndRx = /^(?:import\s.+?from\s+['"][^'"]+['"];?|\}\s*from\s+['"][^'"]+['"];?)\s*$/gm
  function findLastImportEnd(text) {
    let lastEnd = 0
    let m
    while ((m = importEndRx.exec(text)) !== null) lastEnd = importEndRx.lastIndex
    return lastEnd
  }

  if (!hasLoggerImport) {
    const rel = resolveLoggerImport(filePath)
    const lastEnd = findLastImportEnd(out)
    const injection = `\nimport { createLogger } from '${rel}'\nconst routeLogger = createLogger('route:${basename}')\n`
    if (lastEnd > 0) {
      out = out.slice(0, lastEnd) + injection + out.slice(lastEnd)
    } else {
      out = injection + out
    }
    changed++
  } else if (!hasRouteLogger) {
    const lastEnd = findLastImportEnd(out)
    const injection = `\nconst routeLogger = createLogger('route:${basename}')\n`
    out = out.slice(0, lastEnd) + injection + out.slice(lastEnd)
    changed++
  }

  // 2. Rewrite console.log/info/debug → routeLogger.info/debug
  const rewrites = [
    [/\bconsole\.log\(/g, 'routeLogger.info('],
    [/\bconsole\.info\(/g, 'routeLogger.info('],
    [/\bconsole\.debug\(/g, 'routeLogger.debug('],
  ]
  for (const [rx, replacement] of rewrites) {
    out = out.replace(rx, (m) => {
      changed++
      return replacement
    })
  }

  if (changed > 0 && out !== src) {
    fs.writeFileSync(filePath, out, 'utf8')
    console.log(`[codemod] ${path.relative(process.cwd(), filePath)} — ${changed} edits`)
  }
  return changed
}

function main() {
  const files = listJs(ROUTES_DIR)
  let total = 0
  for (const f of files) total += transform(f)
  console.log(`[codemod] done. total edits: ${total}`)
}

main()
