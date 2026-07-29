import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []

function readJson(relativePath) {
  const fullPath = path.join(root, relativePath)
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'))
  } catch (error) {
    failures.push(`${relativePath}: could not parse JSON (${error?.message || error})`)
    return {}
  }
}

function readText(relativePath) {
  const fullPath = path.join(root, relativePath)
  try {
    return fs.readFileSync(fullPath, 'utf8')
  } catch (error) {
    failures.push(`${relativePath}: could not read file (${error?.message || error})`)
    return ''
  }
}

function assert(condition, message) {
  if (!condition) failures.push(message)
}

function byKey(headers = []) {
  return new Map(headers.map((header) => [String(header.key || '').toLowerCase(), String(header.value || '')]))
}

function hasRewrite(vercel, source, destination) {
  return Array.isArray(vercel.rewrites) && vercel.rewrites.some((rewrite) => rewrite?.source === source && rewrite?.destination === destination)
}

const vercel = readJson('vercel.json')
const railway = readJson('railway.json')
const pkg = readJson('package.json')
const lock = readJson('package-lock.json')
const healthRoutes = readText('backend/routes/health.js')
const readinessTransform = readText('scripts/source-materialization/apply-readiness-deployment.mjs')

const railwayApi = 'https://grantflow-production.up.railway.app/api/:path*'
const railwayUploads = 'https://grantflow-production.up.railway.app/uploads/:path*'

assert(hasRewrite(vercel, '/grantflow/api/:path*', railwayApi), 'vercel.json must proxy /grantflow/api/* to the Railway API')
assert(hasRewrite(vercel, '/api/:path*', railwayApi), 'vercel.json must proxy /api/* to the Railway API')
assert(hasRewrite(vercel, '/grantflow/uploads/:path*', railwayUploads), 'vercel.json must proxy /grantflow/uploads/* to Railway uploads')
assert(hasRewrite(vercel, '/uploads/:path*', railwayUploads), 'vercel.json must proxy /uploads/* to Railway uploads')
assert(
  hasRewrite(vercel, '/grantflow/((?!assets/).*)', '/index.html'),
  'vercel.json must keep the /grantflow SPA fallback so deep links do not 404',
)
assert(
  hasRewrite(vercel, '/((?!assets/).*)', '/index.html'),
  'vercel.json must keep the root SPA fallback so deep links do not 404',
)

const globalHeaderBlock = Array.isArray(vercel.headers)
  ? vercel.headers.find((entry) => entry?.source === '/(.*)')
  : null
const globalHeaders = byKey(globalHeaderBlock?.headers)

assert(globalHeaders.get('strict-transport-security')?.includes('includeSubDomains'), 'Vercel must send HSTS with includeSubDomains')
assert(globalHeaders.get('x-content-type-options') === 'nosniff', 'Vercel must send X-Content-Type-Options: nosniff')
assert(globalHeaders.get('x-frame-options') === 'DENY', 'Vercel must send X-Frame-Options: DENY')
assert(globalHeaders.get('referrer-policy') === 'strict-origin-when-cross-origin', 'Vercel must send a strict Referrer-Policy')

const csp = globalHeaders.get('content-security-policy') || ''
assert(csp.includes("default-src 'self'"), 'CSP must default to self')
assert(csp.includes("object-src 'none'"), 'CSP must block plugin/object execution')
assert(csp.includes("frame-ancestors 'none'"), 'CSP must block clickjacking via frame-ancestors')
assert(csp.includes("connect-src 'self'"), 'CSP must allow same-origin API calls')
assert(csp.includes('https://grantflow-production.up.railway.app'), 'CSP must allow the explicit Railway API fallback used by preview/dev overrides')
assert(!/script-src[^;]*\*/.test(csp), 'CSP script-src must not use a wildcard')
assert(!/script-src[^;]*unsafe-eval/.test(csp), 'CSP script-src must not allow unsafe-eval')

const assetHeaderBlock = Array.isArray(vercel.headers)
  ? vercel.headers.find((entry) => entry?.source === '/assets/(.*)')
  : null
assert(
  byKey(assetHeaderBlock?.headers).get('cache-control') === 'public, max-age=31536000, immutable',
  'assets must keep immutable cache headers',
)

const indexHeaderBlock = Array.isArray(vercel.headers)
  ? vercel.headers.find((entry) => entry?.source === '/index.html')
  : null
assert(
  byKey(indexHeaderBlock?.headers).get('cache-control') === 'no-cache, no-store, must-revalidate',
  'index.html must stay no-store so deploy/promote rollouts are not masked by cache',
)

// Railway must promote a technically healthy container before the product-level
// mission gate can run against that exact build. Pointing the platform healthcheck
// at /readyz creates a deployment deadlock whenever production data needs repair:
// the old container stays live, so the new verifier and reconciliation code never
// gets a chance to correct the data. /healthz owns process/schema liveness; /readyz
// remains the separate, blocking release gate for DB, storage, secrets, and mission.
assert(railway?.deploy?.healthcheckPath === '/healthz', 'Railway healthcheckPath must use /healthz; mission readiness is verified separately on /readyz')
assert(healthRoutes.includes("router.get('/healthz'"), 'backend health routes must expose /healthz liveness')
assert(healthRoutes.includes("router.get('/readyz'"), 'backend health routes must expose /readyz release readiness')
assert(
  healthRoutes.includes("reason: 'mission_gate_failed'") || readinessTransform.includes("reason: 'mission_gate_failed'"),
  '/readyz must retain the production mission gate even though Railway promotion uses /healthz',
)
assert(Number(railway?.deploy?.healthcheckTimeout || 0) >= 120, 'Railway healthcheckTimeout must be long enough for cold boot/migrations')
assert(railway?.deploy?.restartPolicyType === 'ALWAYS', 'Railway restart policy must stay ALWAYS')
assert(Number(railway?.deploy?.restartPolicyMaxRetries || 0) >= 3, 'Railway restart retries must be configured')

assert(pkg?.engines?.node === '>=20 <25', 'package.json must declare the supported production Node range (>=20 <25)')
assert(lock?.packages?.['']?.engines?.node === pkg?.engines?.node, 'package-lock root engine must match package.json')

if (failures.length) {
  console.error('[deployment-config] FAIL')
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}

console.log('[deployment-config] OK')
