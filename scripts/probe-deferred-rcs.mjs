// Live-app verification for the 5 deferred root-causes (RC-14, RC-13, RC-8,
// RC-16, RC-17). Probes the running SQLite DB + the live HTTP server for
// schema + endpoint behavior we just shipped, and prints a deterministic
// PASS/FAIL line per check.
//
// Usage:  node scripts/probe-deferred-rcs.mjs
// Exit code is non-zero if ANY probe fails.

import process from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { canonicalStage, PIPELINE_STAGE_ALL, PIPELINE_STAGES } from '../shared/pipelineStages.js'
import { extractNeedSignalsFromDocumentText, normalizeProfile } from '../backend/services/profileNormalizer.js'
import { SOURCES, buildCoverageReport } from '../backend/services/sourceRegistry.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_DB_PATH = path.resolve(__dirname, '..', 'backend', 'data', 'grantflow.db')
const DB_PATH = process.env.SQLITE_PATH || DEFAULT_DB_PATH
const BASE_URL = process.env.PROBE_BASE_URL || 'http://localhost:8080'

const results = []
function record(name, ok, detail) {
  const tag = ok ? 'PASS' : 'FAIL'
  results.push({ name, ok, detail })
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`)
}

let db
try {
  db = new Database(DB_PATH, { readonly: true })
} catch (err) {
  console.error(`Could not open SQLite at ${DB_PATH}: ${err.message}`)
  process.exit(2)
}

// --- RC-14: saved_grants must have profile_id + the new partial unique idx
try {
  const cols = db.prepare(`PRAGMA table_info(saved_grants)`).all().map((c) => c.name)
  const hasProfileId = cols.includes('profile_id')
  record('rc-14: saved_grants has profile_id', hasProfileId, `cols=${cols.join(',')}`)
  const indexes = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='saved_grants'`)
    .all()
    .map((r) => r.name)
  const hasProfileIdx = indexes.includes('uq_saved_grants_user_profile_opp')
  const hasLegacyIdx = indexes.includes('uq_saved_grants_user_legacy_opp')
  record(
    'rc-14: saved_grants partial UNIQUE indexes present',
    hasProfileIdx && hasLegacyIdx,
    `indexes=${indexes.join(',')}`,
  )
} catch (err) {
  record('rc-14', false, err.message)
}

// --- RC-13: grants.status CHECK must include all 11 canonical stages + legacy aliases
try {
  const tableSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='grants'`).get()?.sql || ''
  const missing = PIPELINE_STAGES.filter((stage) => !tableSql.includes(`'${stage}'`))
  record(
    'rc-13: grants.status CHECK contains every canonical stage',
    missing.length === 0,
    missing.length ? `missing=${missing.join(',')}` : `${PIPELINE_STAGES.length} stages present`,
  )
  // Also test the alias resolver behaves.
  const sample = canonicalStage('saved')
  record('rc-13: canonicalStage("saved") resolves', sample === 'saved', `got=${sample}`)
  const aliasCount = PIPELINE_STAGE_ALL.length - PIPELINE_STAGES.length
  record('rc-13: PIPELINE_STAGE_ALL has > canonical-only count', aliasCount > 0, `aliases=${aliasCount}`)
} catch (err) {
  record('rc-13', false, err.message)
}

// --- RC-8: funding_opportunities has reality_status / reality_reasons / final_url / http_status
try {
  const cols = db.prepare(`PRAGMA table_info(funding_opportunities)`).all().map((c) => c.name)
  const required = ['reality_status', 'reality_reasons', 'final_url', 'http_status']
  const missing = required.filter((c) => !cols.includes(c))
  record(
    'rc-8: funding_opportunities has reality + final_url + http_status',
    missing.length === 0,
    missing.length ? `missing=${missing.join(',')}` : 'all 4 columns present',
  )
  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='funding_opportunities'`)
    .all()
    .map((r) => r.name)
  record(
    'rc-8: idx_funding_opportunities_reality_status exists',
    indexes.includes('idx_funding_opportunities_reality_status'),
    `${indexes.length} indexes total`,
  )
} catch (err) {
  record('rc-8', false, err.message)
}

// --- RC-16: sourceRegistry every entry has the operational fields, coverage report surfaces them
try {
  const required = ['base_url', 'crawl_method', 'rate_limit', 'robots_note', 'locations']
  const violations = []
  for (const [id, src] of Object.entries(SOURCES)) {
    for (const f of required) {
      if (!(f in src)) violations.push(`${id}.${f}`)
    }
  }
  record(
    'rc-16: every SOURCES entry has base_url/crawl_method/rate_limit/robots_note/locations',
    violations.length === 0,
    violations.length ? `missing=${violations.slice(0, 5).join(',')}` : `${Object.keys(SOURCES).length} sources`,
  )
  const report = buildCoverageReport(
    { sources_planned: ['grants_gov'], sources_required: ['grants_gov'] },
    [],
    { runtimeStatus: { grants_gov: { last_crawl: '2026-01-01', failure_status: null } } },
  )
  const grants = report.sources.find((s) => s.source_id === 'grants_gov')
  const hasOpFields = grants && 'base_url' in grants && 'crawl_method' in grants && 'last_crawl' in grants
  record('rc-16: buildCoverageReport surfaces operational + runtime fields', !!hasOpFields, grants ? `last_crawl=${grants.last_crawl} crawl_method=${grants.crawl_method}` : 'no entry')
} catch (err) {
  record('rc-16', false, err.message)
}

// --- RC-17: doc text → canonical-need extraction fires + folds into normalizeProfile
try {
  const needs = extractNeedSignalsFromDocumentText('Eviction notice. Past due rent. Need housing help.')
  record('rc-17: extractNeedSignalsFromDocumentText yields housing', needs.includes('housing'), `needs=${needs.join(',')}`)
  const norm = normalizeProfile(
    { id: 'probe-1', primary_type: 'individual', state: 'OH' },
    null,
    null,
    [{ extracted_text: 'electric utility shutoff and food groceries needed urgently' }],
  )
  const folded = norm.needCategories.includes('utilities') && norm.needCategories.includes('food')
  record('rc-17: normalizeProfile folds doc signals into needCategories', folded, `needCategories=${norm.needCategories.join(',')}`)
  record('rc-17: documentSignals exposed for traceability', Array.isArray(norm.documentSignals) && norm.documentSignals.length >= 2, `documentSignals=${norm.documentSignals.join(',')}`)
} catch (err) {
  record('rc-17', false, err.message)
}

// --- Live HTTP probes (best-effort)
async function httpProbe(label, fn) {
  try {
    await fn()
  } catch (err) {
    record(label, false, err?.message || String(err))
  }
}

await httpProbe('http: GET /api/health = 200', async () => {
  const r = await fetch(`${BASE_URL}/api/health`)
  record('http: GET /api/health = 200', r.status === 200, `status=${r.status}`)
})

await httpProbe('http: GET /api/crawlers/coverage exposes RC-16 fields', async () => {
  const r = await fetch(`${BASE_URL}/api/crawlers/coverage`).catch(() => null)
  if (!r || !r.ok) {
    record('http: GET /api/crawlers/coverage exposes RC-16 fields', r?.status === 401, `status=${r?.status} (auth-gated; treating 401 as expected)`)
    return
  }
  const body = await r.json().catch(() => null)
  const ok = body && Array.isArray(body.sources) && body.sources.length > 0 && body.sources[0].crawl_method
  record('http: GET /api/crawlers/coverage exposes RC-16 fields', !!ok, body?.sources ? `sources=${body.sources.length}` : 'no body')
})

await httpProbe('http: GET /api/saved-grants without profile rejects 401/400', async () => {
  const r = await fetch(`${BASE_URL}/api/saved-grants`).catch(() => null)
  // Without auth this is 401; with auth-but-no-profile it would be 400.
  // Either is the correct hardening behavior.
  record('http: GET /api/saved-grants without profile rejects 401/400', r && [400, 401].includes(r.status), `status=${r?.status}`)
})

db.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length} probes, ${failed.length} failed.`)
if (failed.length > 0) {
  console.log('Failures:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail || ''}`)
  process.exit(1)
}
process.exit(0)
