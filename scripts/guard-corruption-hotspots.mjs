import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = process.cwd()

const HOTSPOT_FILES = [
  'backend/routes/crawlerV2.js',
  'backend/routes/geoCrawl.js',
  'backend/routes/matching.js',
  'backend/routes/profiles.js',
  'backend/services/anyaAutonomousCrawler.js',
  // Core decision-engine files (Bug 17.1)
  'backend/services/matchEngine.js',
  'backend/services/relevanceFilter.js',
  'backend/services/opportunityMatcher.js',
  'backend/services/opportunityNormalizer.js',
]

function read(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')
}

function countMatches(text, regex) {
  return (text.match(regex) || []).length
}

function walkJsFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile() && full.endsWith('.js')) {
        out.push(full)
      }
    }
  }
  return out
}

function checkSyntax(absPath) {
  const result = spawnSync(process.execPath, ['--check', absPath], { encoding: 'utf8' })
  if (result.status === 0) return null
  return (result.stderr || result.stdout || `node --check failed for ${absPath}`).trim()
}

function main() {
  const failures = []

  // 1) Catch unresolved merge markers in backend JS sources.
  for (const absPath of walkJsFiles(path.join(REPO_ROOT, 'backend'))) {
    const rel = path.relative(REPO_ROOT, absPath).replace(/\\/g, '/')
    let text = ''
    try {
      text = fs.readFileSync(absPath, 'utf8')
    } catch (err) {
      failures.push(`${rel}: could not read file — ${err.message}`)
      continue
    }
    // Handle both LF and CRLF line endings (Bug 17.3)
    if (/(^|\n)<{7} |(^|\r?\n)={7}\r?$|(^|\n)>{7} /m.test(text)) {
      failures.push(`${rel}: unresolved merge marker pattern found`)
    }
  }

  // 2) Known historical duplicate-declaration regressions.
  const crawlerV2 = read('backend/routes/crawlerV2.js')
  const staleACount = countMatches(crawlerV2, /^\s*(?:const|let)\s+staleA\b/gm)
  const staleBCount = countMatches(crawlerV2, /^\s*(?:const|let)\s+staleB\b/gm)
  if (staleACount !== 1) failures.push(`backend/routes/crawlerV2.js: expected exactly 1 "const staleA", found ${staleACount}`)
  if (staleBCount !== 1) failures.push(`backend/routes/crawlerV2.js: expected exactly 1 "const staleB", found ${staleBCount}`)

  const autonomousCrawler = read('backend/services/anyaAutonomousCrawler.js')
  const actualLineCount = countMatches(autonomousCrawler, /^\s*(?:const|let)\s+actualLine\b/gm)
  if (actualLineCount > 1) {
    failures.push(`backend/services/anyaAutonomousCrawler.js: expected <= 1 "const actualLine", found ${actualLineCount}`)
  }

  // 3) Parse-check hotspot files (fast syntax tripwire).
  for (const rel of HOTSPOT_FILES) {
    const abs = path.join(REPO_ROOT, rel)
    if (!fs.existsSync(abs)) {
      failures.push(`${rel}: file not found`)
      continue
    }
    const syntaxError = checkSyntax(abs)
    if (syntaxError) failures.push(`${rel}: ${syntaxError}`)
  }

  if (failures.length > 0) {
    console.error('[guard:corruption-hotspots] failed')
    for (const failure of failures) {
      console.error(` - ${failure}`)
    }
    process.exitCode = 1
    return
  }

  console.log('[guard:corruption-hotspots] ok')
}

main()
