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

function findRewrite(vercel, source, destination) {
  return Array.isArray(vercel.rewrites)
    ? vercel.rewrites.find((rewrite) => rewrite?.source === source && rewrite?.destination === destination)
    : null
}

function hasRewrite(vercel, source, destination) {
  return Boolean(findRewrite(vercel, source, destination))
}

function hasProductionHostGuard(rewrite) {
  return Array.isArray(rewrite?.has) && rewrite.has.some(
    (condition) => condition?.type === 'host' && /axiombiolabs/i.test(String(condition?.value || '')),
  )
}

const vercel = readJson('vercel.json')
const railway = readJson('railway.json')
const pkg = readJson('package.json')
const lock = readJson('package-lock.json')
const dockerfile = readText('Dockerfile')
const dockerignore = readText('.dockerignore')
const envGenerator = readText('scripts/generate-env-examples.mjs')
const healthRoutes = readText('backend/routes/health.js')
const nvmrc = readText('.nvmrc').trim()

const railwayApi = 'https://grantflow-production.up.railway.app/api/:path*'
const railwayUploads = 'https://grantflow-production.up.railway.app/uploads/:path*'

const productionRewrites = [
  ['/grantflow/api/:path*', railwayApi],
  ['/api/:path*', railwayApi],
  ['/grantflow/uploads/:path*', railwayUploads],
  ['/uploads/:path*', railwayUploads],
]
for (const [source, destination] of productionRewrites) {
  const rewrite = findRewrite(vercel, source, destination)
  assert(Boolean(rewrite), `vercel.json must proxy ${source} to the Railway production backend`)
  assert(hasProductionHostGuard(rewrite), `production rewrite ${source} must be host-gated`)
}
assert(
  hasRewrite(vercel, '/grantflow/api/:path*', '/api/preview-backend-disabled'),
  'prefixed preview API calls must fail closed',
)
assert(
  hasRewrite(vercel, '/api/:path((?!preview-backend-disabled$).*)', '/api/preview-backend-disabled'),
  'root preview API calls must fail closed',
)
assert(vercel.installCommand === 'npm ci --include=dev --include=optional', 'Vercel must use npm ci')
assert(
  hasRewrite(vercel, '/grantflow/((?!assets/).*)', '/index.html'),
  'vercel.json must keep the /grantflow SPA fallback so deep links do not 404',
)
assert(
  hasRewrite(vercel, '/((?!assets/).*)', '/index.html'),
  'vercel.json must keep the root SPA fallback so deep links do not 404',
)
assert(
  Array.isArray(vercel.redirects) && vercel.redirects.some((redirect) =>
    redirect?.source === '/grantflow/welcome' &&
    redirect?.destination === '/welcome' &&
    redirect?.permanent === true
  ),
  'legacy /grantflow/welcome must permanently redirect to the canonical public /welcome route',
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
assert(csp.includes('https://grantflow-production.up.railway.app'), 'CSP must allow the production Railway backend')
// Exact-token check, not a substring: `csp.includes('ingest.sentry.io')` would
// pass with the host in the wrong directive (or inside another host), and it
// reads to CodeQL as incomplete URL substring sanitization. Browser Sentry
// ingestion specifically needs the wildcard token in connect-src.
const connectSrcTokens = String(csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')) || '').split(/\s+/).slice(1)
assert(connectSrcTokens.includes('https://*.ingest.sentry.io'), 'CSP connect-src must carry the exact https://*.ingest.sentry.io token for browser Sentry ingestion')
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

// The Docker runtime image contains only product/runtime files, not the
// build-only scripts directory, so `npm start` (or any npm lifecycle) is the
// wrong entry point there. Railway must invoke the same direct command declared
// by the Dockerfile CMD.
assert(railway?.deploy?.startCommand === 'node backend/start.js', 'Railway must start the runtime directly; the runtime image carries no build scripts for npm lifecycles')
assert(dockerfile.includes('CMD ["node", "backend/start.js"]'), 'Dockerfile CMD must start backend/start.js directly')

const dependencyInstallIndex = dockerfile.indexOf('npm ci --include=dev --include=optional --legacy-peer-deps')
assert(dependencyInstallIndex >= 0, 'Docker builder must use the locked dependency install command')

// Docker omits .git; the env generator must have a deterministic filesystem
// fallback rather than unconditionally running git, and its scan reads scripts/
// and test fixtures, so the build context must retain them even though the
// final runtime stage never copies them.
assert(!/^scripts\/?$/m.test(dockerignore), '.dockerignore must not remove scripts/ from the builder context')
assert(!/^tests\/?$/m.test(dockerignore), '.dockerignore must not remove test fixtures from the builder context')
assert(!/^\*\.test\.\*$/m.test(dockerignore), '.dockerignore must not blanket-remove backend test fixtures from the builder context')
assert(envGenerator.includes('enumerateFilesystemSources'), 'env-example generator must support source archives and Docker contexts without .git')
assert(envGenerator.includes('forceFilesystem'), 'env-example generator no-git fallback must be directly regression-testable')

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
  healthRoutes.includes("reason: 'mission_gate_failed'"),
  '/readyz must retain the production mission gate even though Railway promotion uses /healthz',
)
assert(Number(railway?.deploy?.healthcheckTimeout || 0) >= 120, 'Railway healthcheckTimeout must be long enough for cold boot/migrations')
assert(railway?.deploy?.restartPolicyType === 'ALWAYS', 'Railway restart policy must stay ALWAYS')
assert(Number(railway?.deploy?.restartPolicyMaxRetries || 0) >= 3, 'Railway restart retries must be configured')

assert(pkg?.engines?.node === '20.x', 'package.json must pin the production runtime to Node 20.x')
assert(lock?.packages?.['']?.engines?.node === pkg?.engines?.node, 'package-lock root engine must match package.json')
assert(nvmrc === '20', '.nvmrc must remain pinned to Node 20')
assert((dockerfile.match(/FROM node:20-slim/g) || []).length === 2, 'both Docker build and runtime stages must use Node 20')

if (failures.length) {
  console.error('[deployment-config] FAIL')
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}

console.log('[deployment-config] OK')
