#!/usr/bin/env node
/**
 * check-runtime-imports.mjs
 *
 * Production-deploy regression guard.
 *
 * The Railway runtime image is built by Dockerfile and starts via
 * `node backend/start.js`. Anything `backend/**` imports — directly OR
 * transitively — must be present in the runtime image. We have been bitten
 * (more than once) by `backend/utils/*.js` re-exporting from `shared/**`
 * which then transitively imports `src/config/**`, while the Dockerfile only
 * copied `backend/`. The container crashes at boot with
 * `ERR_MODULE_NOT_FOUND`, healthcheck fails, and Railway silently keeps
 * serving the previous deployment — so the "fix" the user just shipped is
 * invisible in production for days at a time.
 *
 * This script statically walks the import graph rooted at `backend/start.js`
 * and asserts that every resolved file lives under one of the directories
 * the Dockerfile actually copies into the runtime image. If a backend import
 * resolves to a file outside that whitelist, we fail CI loudly with a
 * pointer to which Dockerfile COPY line is missing.
 *
 * Read-only. No side effects. Runs in seconds.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')

// Directories the Dockerfile actually COPYs into the runtime image.
// Keep this list in sync with `Dockerfile` — anything imported from outside
// these directories will fail at boot in production.
const RUNTIME_COPIED_DIRS = [
  'backend',
  'shared',
  'src/config',
  'seed',
  'dist',
  'node_modules',
]

const ENTRY_POINTS = [
  'backend/start.js',
  'backend/server.js',
]

const visited = new Set()
const violations = []

// ── Crawler OS cutover tracking ──────────────────────────────────────────
// Legacy crawler/matching modules that the Crawler OS replaces. They are still
// imported as a reversible fallback by the discovery/matching routes during the
// staged cutover. This is a MEASUREMENT (non-failing) so the teardown is
// trackable: when the legacy fallbacks are removed, this set goes empty and the
// `legacy-crawler-ban` guard can be flipped to hard-fail. Set
// FAIL_ON_LEGACY_CRAWLER=1 to enforce (used once the cutover teardown is done).
// The legacy grant-DISCOVERY crawl ENGINE — what the Crawler OS replaces and
// must NOT be reachable from the runtime. Scoped precisely to discovery-crawl
// modules. INTENTIONALLY EXCLUDED (these are NOT the old crawler):
//   - crawlerDispatcher / crawlerJobState / crawlerConcurrencyGuard / crawlerJobCreation:
//     the shared job runner — still processes document_ingest / avatar_lookup /
//     pipeline_automation jobs (discovery crawl is neutralized at the dispatch
//     choke point in dispatchCrawlerJob).
//   - matchEngine / opportunityMatcher: matchers used by Anya scout, validation
//     gates, and non-discovery routes. The OS is the single DISCOVERY match
//     authority (discovery routes are OS-first); these remain for other flows.
//   - config/matchThresholds, config/relevanceFloor, opportunityTrust, contentFilter,
//     relevanceFilterRules: shared config/relevance infra used by the OS-era
//     pipeline + the invariant enforcer.
const LEGACY_CRAWLER_PATTERNS = [
  /backend\/services\/comprehensiveCrawlerOptimized\.js$/,
  /backend\/services\/autoDiscoveryCrawlers\.js$/,
  /backend\/services\/scheduledAutoDiscovery\.js$/,
  /backend\/services\/anyaAutonomousCrawler\.js$/,
  /backend\/services\/grantsDotGovCrawler\.js$/,
  /backend\/services\/realFundingCrawler\.js$/,
  /backend\/services\/realLocationFundingCrawler\.js$/,
  /backend\/services\/localCrawler\.js$/,
  /backend\/services\/countyFundingCrawler\.js$/,
  // the crawlers/ discovery engine (shared leaf utils already relocated to services/shared/)
  /backend\/services\/crawlers\/(crawlerManager|domainCorpusCrawler|domainCrawlerEngine|domainCrawlerRegistry|domainCrawlers|ecfBenefitsCrawler|foundation990Crawler|itemFundingCrawler|nationalZipCrawler|stateWaiverBenefitsCrawler|studentBridgeFundingCrawler|strategyRegistry|queryPlanner|matchEngine|crawlerHelpers)\.js$/,
  /backend\/services\/crawlers\/domainEngines\//,
]
const legacyReached = new Set()

const IMPORT_RE = /(?:^|\s|;|\()\s*(?:import|export)\s+(?:[\s\S]*?\bfrom\s+)?['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function isInsideRuntimeCopy(absPath) {
  const rel = path.relative(repoRoot, absPath).replace(/\\/g, '/')
  if (rel.startsWith('..')) return false
  return RUNTIME_COPIED_DIRS.some(
    (dir) => rel === dir || rel.startsWith(`${dir}/`),
  )
}

function tryResolveFile(candidate) {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate
  }
  for (const ext of ['.js', '.mjs', '.cjs', '.json']) {
    const withExt = `${candidate}${ext}`
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) return withExt
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    for (const idx of ['index.js', 'index.mjs', 'index.cjs']) {
      const idxPath = path.join(candidate, idx)
      if (fs.existsSync(idxPath)) return idxPath
    }
  }
  return null
}

function resolveSpecifier(specifier, fromFile) {
  // Bare specifier (npm package or node: builtin) — node_modules is copied
  // wholesale into the runtime image, so we don't need to walk it.
  if (specifier.startsWith('node:')) return null
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null

  const baseDir = path.dirname(fromFile)
  const absolute = path.isAbsolute(specifier)
    ? specifier
    : path.resolve(baseDir, specifier)
  return tryResolveFile(absolute)
}

function readSourceSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function walk(filePath) {
  if (visited.has(filePath)) return
  visited.add(filePath)

  if (!isInsideRuntimeCopy(filePath)) {
    violations.push({
      file: filePath,
      reason:
        'imported by backend at runtime but lives outside Dockerfile COPY whitelist',
    })
    return
  }

  // Don't descend into node_modules — it's copied wholesale and walking it
  // would be both slow and unnecessary for this safety net.
  const rel = path.relative(repoRoot, filePath).replace(/\\/g, '/')
  if (rel.startsWith('node_modules/')) return

  // Track (don't fail) legacy crawler modules still reachable at runtime.
  if (LEGACY_CRAWLER_PATTERNS.some((re) => re.test(rel))) legacyReached.add(rel)

  const source = readSourceSafe(filePath)
  const specifiers = new Set()
  let match
  IMPORT_RE.lastIndex = 0
  while ((match = IMPORT_RE.exec(source)) !== null) {
    specifiers.add(match[1])
  }
  DYNAMIC_IMPORT_RE.lastIndex = 0
  while ((match = DYNAMIC_IMPORT_RE.exec(source)) !== null) {
    specifiers.add(match[1])
  }

  for (const specifier of specifiers) {
    const resolved = resolveSpecifier(specifier, filePath)
    if (!resolved) continue
    walk(resolved)
  }
}

for (const entry of ENTRY_POINTS) {
  const abs = path.resolve(repoRoot, entry)
  if (!fs.existsSync(abs)) {
    console.error(`[check-runtime-imports] entry point missing: ${entry}`)
    process.exit(2)
  }
  walk(abs)
}

if (violations.length > 0) {
  console.error('')
  console.error(
    '[check-runtime-imports] FAIL — backend imports escape the Dockerfile runtime image:',
  )
  for (const v of violations) {
    const rel = path.relative(repoRoot, v.file).replace(/\\/g, '/')
    console.error(`  - ${rel}`)
    console.error(`    ${v.reason}`)
  }
  console.error('')
  console.error(
    '[check-runtime-imports] Fix: add the file (or its parent directory) to the COPY list in Dockerfile,',
  )
  console.error(
    '[check-runtime-imports] OR move the dependency under backend/ / shared/ so it ships with the backend.',
  )
  console.error('')
  process.exit(1)
}

const totalFiles = visited.size
console.log(
  `[check-runtime-imports] ok — ${totalFiles} backend-reachable files all live inside the Dockerfile runtime image`,
)

// Crawler OS cutover progress (measurement; non-failing unless enforced).
if (legacyReached.size > 0) {
  console.log(
    `[legacy-crawler] ${legacyReached.size} legacy crawler module(s) still reachable from the backend runtime (Crawler OS cutover fallback):`,
  )
  for (const f of [...legacyReached].sort()) console.log(`  - ${f}`)
  if (process.env.FAIL_ON_LEGACY_CRAWLER === '1') {
    console.error('[legacy-crawler] FAIL_ON_LEGACY_CRAWLER=1 and legacy crawler modules are still reachable.')
    process.exit(1)
  }
} else {
  console.log('[legacy-crawler] ok — no legacy crawler modules reachable from the backend runtime')
}

// Silence unused-import warning under strict mode without changing the API.
void pathToFileURL
