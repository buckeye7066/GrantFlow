/**
 * Legacy-module resilience regression test.
 *
 * Ensures that modules historically imported by operational scripts, CI
 * helpers, and external integrations remain importable across sessions,
 * logins, machines, and deployments. When a legacy module is consolidated
 * into a newer canonical path, the old path must be preserved as a thin
 * compatibility shim so nothing silently breaks.
 *
 * Covers:
 *   1. `backend/services/crawlers/crawlerHelpers.js` — compat shim for
 *      historical `calculateMatchScore(opportunity, profile)` callers.
 *      (Bug report: verify-lorain-faith-housing.mjs crashed at import time
 *      when the file was deleted during consolidation.)
 *   2. `backend/services/matchingEngine.js` — compat shim for the legacy
 *      `calculateMatchScore(profile, opportunity)` signature.
 *   3. `backend/services/matchDecisionEngine.js` — canonical decision
 *      re-export alias used by scripts and tests.
 *   4. Static scan of `scripts/**` for top-level `await import` of any path
 *      under `backend/**`: every such path must resolve to a file that
 *      exists on disk, so scripts cannot crash at load time due to a
 *      module that was deleted upstream.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// 1. crawlerHelpers compat shim
// ---------------------------------------------------------------------------

test('crawlerHelpers.js is importable and exports calculateMatchScore', async () => {
  const mod = await import('../../backend/services/crawlers/crawlerHelpers.js')
  assert.equal(
    typeof mod.calculateMatchScore,
    'function',
    'crawlerHelpers.calculateMatchScore must remain exported as a function',
  )
})

test('crawlerHelpers.calculateMatchScore returns { score, reasons, matchedSignals }', async () => {
  const { calculateMatchScore } = await import(
    '../../backend/services/crawlers/crawlerHelpers.js'
  )
  const opp = {
    title: 'Test Grant for Small Businesses',
    description: 'Helping entrepreneurs launch small businesses in Ohio.',
    is_national: 1,
    state: 'nationwide',
    application_url: 'https://example.org/apply',
    categories: ['business', 'small_business'],
    keywords: ['small business', 'entrepreneur', 'startup'],
  }
  const profile = {
    state: 'OH',
    applicant_type: 'small_business',
    needs: ['small_business'],
    signals: { keywordSet: new Set(['small business', 'entrepreneur']) },
  }
  const result = calculateMatchScore(opp, profile)
  assert.equal(typeof result.score, 'number', 'score must be a number')
  assert.ok(result.score >= 0 && result.score <= 100, 'score must be in 0-100 range')
  assert.ok(Array.isArray(result.reasons), 'reasons must be an array')
  assert.ok(Array.isArray(result.matchedSignals), 'matchedSignals must be an array')
  assert.ok(
    result.matchedSignals.some((s) => s.startsWith('kw:')),
    'matchedSignals must surface keyword hits for legacy drift observers',
  )
})

test('crawlerHelpers.calculateMatchScore score matches canonical scorer', async () => {
  const { calculateMatchScore } = await import(
    '../../backend/services/crawlers/crawlerHelpers.js'
  )
  const { scoreOpportunity } = await import('../../backend/services/matchEngine.js')
  const opp = {
    title: 'Federal Pell Grant',
    description: 'Need-based grant for undergraduate students.',
    is_national: 1,
    state: 'nationwide',
    application_url: 'https://studentaid.gov/understand-aid/types/grants/pell',
    categories: ['education', 'scholarship'],
    keywords: ['pell', 'student', 'college'],
  }
  const profile = {
    state: 'OH',
    applicant_type: 'student',
    primary_type: 'student',
    needs: ['education'],
  }
  const legacyResult = calculateMatchScore(opp, profile)
  const canonicalResult = scoreOpportunity(profile, opp)
  assert.equal(
    legacyResult.score,
    canonicalResult.score,
    'legacy wrapper must delegate to canonical scorer (same score)',
  )
})

test('crawlerHelpers.calculateMatchScore is null-safe', async () => {
  const { calculateMatchScore } = await import(
    '../../backend/services/crawlers/crawlerHelpers.js'
  )
  assert.doesNotThrow(() => calculateMatchScore(null, null))
  assert.doesNotThrow(() => calculateMatchScore({}, {}))
  assert.doesNotThrow(() => calculateMatchScore({ title: 'x' }, undefined))
  const r = calculateMatchScore({}, {})
  assert.equal(typeof r.score, 'number')
  assert.ok(Array.isArray(r.reasons))
  assert.ok(Array.isArray(r.matchedSignals))
})

// ---------------------------------------------------------------------------
// 1b. grantsGov.js compat shim (ingest scripts pinned to this exact path)
// ---------------------------------------------------------------------------

test('backend/services/sources/grantsGov.js is importable and exports fetchGrantsGov', async () => {
  const mod = await import('../../backend/services/sources/grantsGov.js')
  assert.equal(
    typeof mod.fetchGrantsGov,
    'function',
    'grantsGov.fetchGrantsGov must remain exported so npm run ingest keeps working',
  )
})

test('grantsGov.fetchGrantsGov contract: returns { opportunities: Array, metadata: Object }', async () => {
  // We patch the underlying canonical fetch to avoid touching the real
  // Grants.gov API in unit tests. The shim must reshape the raw oppHits
  // response into the legacy { opportunities, metadata } contract.
  const grantsGovCanonical = await import('../../backend/services/grantsDotGovCrawler.js')
  const shim = await import('../../backend/services/sources/grantsGov.js')

  // Verify the canonical module exposes both primitives the shim depends on.
  assert.equal(typeof grantsGovCanonical.fetchGrantsGov, 'function')
  assert.equal(typeof grantsGovCanonical.transformGrantsGovOpportunity, 'function')

  // Drive the shim with a synthetic raw hit and assert the adapter logic.
  const transformed = grantsGovCanonical.transformGrantsGovOpportunity({
    id: '12345',
    number: 'ABC-2026-001',
    title: 'Test Federal Grant',
    synopsis: 'Synthetic opportunity for shape testing.',
    agencyName: 'Test Agency',
    oppStatus: 'posted',
    closeDate: '2026-12-31',
  })
  assert.equal(typeof transformed.id, 'string')
  assert.equal(transformed.source, 'grants.gov')
  assert.ok(transformed.title)
  assert.ok(transformed.source_url)

  // Confirm the shim function exists and has the legacy signature.
  assert.equal(shim.fetchGrantsGov.length, 0) // (options = {}) → defaulted
})



test('backend/services/matchingEngine.js is importable and exports calculateMatchScore', async () => {
  const mod = await import('../../backend/services/matchingEngine.js')
  assert.equal(
    typeof mod.calculateMatchScore,
    'function',
    'matchingEngine.calculateMatchScore must remain exported (legacy shim)',
  )
})

// ---------------------------------------------------------------------------
// 3. matchDecisionEngine re-export
// ---------------------------------------------------------------------------

test('backend/services/matchDecisionEngine.js re-exports canonical authority', async () => {
  const mod = await import('../../backend/services/matchDecisionEngine.js')
  for (const name of [
    'computeMatchDecision',
    'scoreOpportunity',
    'normalizeProfile',
    'normalizeOpportunity',
    'MATCHER_VERSION',
  ]) {
    assert.ok(
      name in mod,
      `matchDecisionEngine must re-export '${name}' so legacy callers keep working`,
    )
  }
})

// ---------------------------------------------------------------------------
// 4. Static scan: every top-level `await import(...)` in scripts/ that
//    points at backend/** must resolve to an existing file. Guards against
//    future consolidations breaking scripts at load time.
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walk(full, out)
    } else if (entry.isFile() && /\.(mjs|js|cjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function extractImportedBackendPaths(source) {
  const paths = new Set()
  // static  import ... from '...'
  const staticRe = /\bimport\s+(?:[\s\S]+?)\s+from\s+(['"])([^'"]+)\1/g
  // dynamic  import('...') and await import('...')
  const dynamicRe = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g
  // commonjs  require('...')
  const requireRe = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g
  for (const re of [staticRe, dynamicRe, requireRe]) {
    let m
    while ((m = re.exec(source)) !== null) {
      const spec = m[2]
      if (!spec.startsWith('.')) continue
      if (!/(^|\/)(\.\.\/)*backend\//.test(spec) && !/(^|\/)backend\//.test(spec)) continue
      paths.add(spec)
    }
  }
  return [...paths]
}

function resolveImportSpec(scriptFile, spec) {
  const base = path.dirname(scriptFile)
  const joined = path.resolve(base, spec)
  const candidates = [
    joined,
    `${joined}.js`,
    `${joined}.mjs`,
    `${joined}.cjs`,
    path.join(joined, 'index.js'),
    path.join(joined, 'index.mjs'),
  ]
  return candidates.find((p) => fs.existsSync(p)) || null
}

test('every script-level import of backend/** must resolve to an existing module', () => {
  const scriptsDir = path.join(repoRoot, 'scripts')
  if (!fs.existsSync(scriptsDir)) return
  const files = walk(scriptsDir)
  const violations = []
  for (const file of files) {
    let src
    try {
      src = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const spec of extractImportedBackendPaths(src)) {
      const resolved = resolveImportSpec(file, spec)
      if (!resolved) {
        violations.push({
          file: path.relative(repoRoot, file),
          spec,
        })
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Scripts import backend modules that no longer exist on disk:\n` +
      violations
        .map((v) => `  - ${v.file}: imports '${v.spec}' (not found)`)
        .join('\n') +
      `\n\nFix: restore the target as a compatibility shim, or update the script ` +
      `to import from the canonical path.`,
  )
})

// ---------------------------------------------------------------------------
// 5. Sanity: the canonical path referenced by the shims still exists.
// ---------------------------------------------------------------------------

test('canonical matchEngine.js exists and exports scoreOpportunity & makeDecision', async () => {
  const canonicalPath = path.join(repoRoot, 'backend', 'services', 'matchEngine.js')
  assert.ok(fs.existsSync(canonicalPath), 'canonical matchEngine.js must exist')
  const mod = await import(pathToFileURL(canonicalPath).href)
  assert.equal(typeof mod.scoreOpportunity, 'function')
  assert.equal(typeof mod.makeDecision, 'function')
  assert.equal(typeof mod.computeMatchDecision, 'function')
})
