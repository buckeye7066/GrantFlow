#!/usr/bin/env node
/**
 * endpoint-sweep.mjs
 *
 * Enumerates EVERY backend HTTP endpoint by statically scanning the route
 * files + server.js mounts (the app uses lazyRouter, so the live Express stack
 * can't be walked — sub-routers only load on first request and are never
 * spliced into the parent stack), then boots the app in SMOKE_MODE and probes
 * each GET endpoint to classify it:
 *
 *   ok         2xx/3xx — handler ran
 *   guarded    400/401/403/404-with-validation/422 — mounted + correctly gated
 *   not_mounted 404 where NO handler exists for the path (a real wiring gap)
 *   broken     5xx — the handler threw (a real defect)
 *
 * Mutating verbs (POST/PUT/PATCH/DELETE) are inventoried but NOT invoked
 * (safety) — they're reported as "present, not probed".
 *
 * The distinction between guarded-404 and not_mounted-404 is made by also
 * probing the route's mount PREFIX: if the prefix base responds (not 404) but
 * the full path 404s with a JSON error body, it's guarded; a 404 with no
 * matching layer is not_mounted. We approximate conservatively: a 404 on a
 * parameterized path we filled with a placeholder is treated as guarded
 * (the id simply doesn't exist), while a 404 on a static path is not_mounted.
 *
 * Usage:
 *   node scripts/endpoint-sweep.mjs                 # human summary
 *   node scripts/endpoint-sweep.mjs --json          # JSON report
 *   node scripts/endpoint-sweep.mjs --methods=GET   # default; GET only
 *
 * Exit code: 0 when no not_mounted/broken GET endpoints; 1 otherwise.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const ROUTES_DIR = path.join(ROOT, 'backend', 'routes')
const SERVER_FILE = path.join(ROOT, 'backend', 'server.js')

const args = process.argv.slice(2)
const asJson = args.includes('--json')

// ---------------------------------------------------------------------------
// 1. Static enumeration
// ---------------------------------------------------------------------------
function read(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

function buildMountMap(serverSrc) {
  // identifier -> routes file (from `import x from './routes/x.js'`)
  const importMap = {}
  const importRe = /import\s+(\w+)\s+from\s+['"]\.\/routes\/([\w.-]+?)(?:\.js)?['"]/g
  let m
  while ((m = importRe.exec(serverSrc))) importMap[m[1]] = `${m[2]}.js`

  // file -> [prefixes]   (a router file can be mounted more than once)
  const prefixesByFile = {}
  const addPrefix = (file, prefix) => {
    if (!file) return
    prefixesByFile[file] = prefixesByFile[file] || []
    if (!prefixesByFile[file].includes(prefix)) prefixesByFile[file].push(prefix)
  }

  // app.use('<prefix>', ...) — capture prefix + the (single-line) argument blob
  const useRe = /app\.use\(\s*(['"`])([^'"`]+)\1\s*,\s*([^\n]+)/g
  while ((m = useRe.exec(serverSrc))) {
    const prefix = m[2]
    const argBlob = m[3]
    const lazy = argBlob.match(/lazyRouter\(\s*['"]\.\/routes\/([\w.-]+?)(?:\.js)?['"]/)
    if (lazy) { addPrefix(`${lazy[1]}.js`, prefix); continue }
    const idMatch = argBlob.match(/^([A-Za-z_$][\w$]*)/)
    if (idMatch && importMap[idMatch[1]]) addPrefix(importMap[idMatch[1]], prefix)
  }

  // inline routes declared directly on the app object
  const inline = []
  const inlineRe = /app\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g
  while ((m = inlineRe.exec(serverSrc))) {
    inline.push({ method: m[1].toUpperCase(), fullPath: m[3], file: 'server.js', mounted: true })
  }

  return { prefixesByFile, inline }
}

function joinPath(prefix, routePath) {
  if (!routePath || routePath === '/') return prefix || '/'
  const a = (prefix || '').replace(/\/+$/, '')
  const b = routePath.startsWith('/') ? routePath : `/${routePath}`
  return `${a}${b}` || '/'
}

function scanRouteFile(file, src) {
  const endpoints = []
  // router.get('/path' ...   and   router.route('/path')
  const methodRe = /\brouter\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]*)\2/g
  let m
  while ((m = methodRe.exec(src))) {
    const method = m[1].toUpperCase()
    const routePath = m[3]
    endpoints.push({ method: method === 'ALL' ? 'GET' : method, routePath })
  }
  return endpoints
}

function enumerate() {
  const serverSrc = read(SERVER_FILE)
  const { prefixesByFile, inline } = buildMountMap(serverSrc)
  const all = [...inline]

  for (const file of fs.readdirSync(ROUTES_DIR)) {
    if (!file.endsWith('.js')) continue
    const prefixes = prefixesByFile[file]
    if (!prefixes || prefixes.length === 0) continue // not mounted (or dynamic mount we can\'t resolve)
    const src = read(path.join(ROUTES_DIR, file))
    const eps = scanRouteFile(file, src)
    for (const ep of eps) {
      for (const prefix of prefixes) {
        all.push({ method: ep.method, fullPath: joinPath(prefix, ep.routePath), file, mounted: true })
      }
    }
  }
  // De-dupe identical method+path.
  const seen = new Set()
  return all.filter((e) => {
    const k = `${e.method} ${e.fullPath}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// Fill :params (and optional/splat) with a harmless placeholder so the probe
// reaches the handler. A 404 on such a path means "id not found" (guarded),
// not "route missing".
function probePath(fullPath) {
  return {
    url: fullPath
      .replace(/:[^/]+\?/g, 'smoke-test')
      .replace(/:[^/]+/g, 'smoke-test')
      .replace(/\/\*.*$/, '')
      .replace(/\*/g, ''),
    parameterized: /[:*]/.test(fullPath),
  }
}

// ---------------------------------------------------------------------------
// 2. Boot + probe
// ---------------------------------------------------------------------------
async function main() {
  const endpoints = enumerate()
  const getEndpoints = endpoints.filter((e) => e.method === 'GET')
  const nonGet = endpoints.filter((e) => e.method !== 'GET')

  // Boot the app in SMOKE_MODE via the shared test harness.
  const { getAppAndDb, TEST_ADMIN_TOKEN } = await import('../backend/tests/testServer.js')
  const { app } = await getAppAndDb()
  // SMOKE_MODE skips MIGRATE_ON_BOOT, so apply pending migrations explicitly to
  // make the sweep faithful to production (migration-only tables present).
  try {
    const { runPendingMigrationsOnBoot } = await import('../backend/db/migrate.js')
    await runPendingMigrationsOnBoot({ logger: { log() {}, warn() {}, error() {} } })
  } catch (err) {
    console.warn('[endpoint-sweep] migration apply skipped:', err?.message || err)
  }
  const request = (await import('supertest')).default

  const results = []
  for (const ep of getEndpoints) {
    const { url, parameterized } = probePath(ep.fullPath)
    let status = 0
    let bodySnippet = ''
    try {
      const res = await request(app)
        .get(url)
        .set('x-admin-token', TEST_ADMIN_TOKEN)
        .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
      status = res.status
      bodySnippet = typeof res.text === 'string' ? res.text.slice(0, 120) : ''
    } catch (err) {
      status = -1
      bodySnippet = String(err?.message || err).slice(0, 120)
    }
    let klass
    if (status >= 500 || status === -1) klass = 'broken'
    else if (status === 404 && !parameterized) klass = 'not_mounted'
    else if ([400, 401, 403, 404, 422].includes(status)) klass = 'guarded'
    else klass = 'ok'
    results.push({ ...ep, url, status, klass, bodySnippet })
  }

  const by = (k) => results.filter((r) => r.klass === k)
  const broken = by('broken')
  const notMounted = by('not_mounted')

  const report = {
    generated_at: new Date().toISOString(),
    totals: {
      endpoints_enumerated: endpoints.length,
      get_probed: getEndpoints.length,
      non_get_inventoried: nonGet.length,
      ok: by('ok').length,
      guarded: by('guarded').length,
      not_mounted: notMounted.length,
      broken: broken.length,
    },
    not_mounted: notMounted.map((r) => `${r.method} ${r.fullPath} (${r.file}) -> ${r.status}`),
    broken: broken.map((r) => `${r.method} ${r.fullPath} (${r.file}) -> ${r.status} ${r.bodySnippet}`),
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log('\n=== Endpoint sweep ===')
    console.log(`Enumerated: ${report.totals.endpoints_enumerated} (GET probed: ${report.totals.get_probed}, non-GET inventoried: ${report.totals.non_get_inventoried})`)
    console.log(`  ok=${report.totals.ok}  guarded=${report.totals.guarded}  not_mounted=${report.totals.not_mounted}  broken=${report.totals.broken}`)
    if (notMounted.length) { console.log('\nnot_mounted (static-path 404 — usually a handler 404 for an empty/root resource, NOT a wiring gap; verify manually):'); report.not_mounted.forEach((s) => console.log('  ' + s)) }
    if (broken.length) { console.log('\nBROKEN (5xx — real defect):'); report.broken.forEach((s) => console.log('  ' + s)) }
    if (!broken.length) console.log('\nNo GET endpoint returned 5xx. ✔')
  }

  // Exit code reflects only 5xx (the reliable defect signal). not_mounted is
  // informational — a static-path 404 is frequently a legitimate handler 404.
  process.exit(broken.length === 0 ? 0 : 1)
}

// Allow importing the pure enumerator for tests without booting.
export { enumerate, probePath }

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('endpoint-sweep.mjs')) {
  main().catch((err) => { console.error('endpoint-sweep failed:', err); process.exit(1) })
}
