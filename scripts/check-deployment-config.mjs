import fs from 'node:fs'
import path from 'node:path'
import { validateWorkflowNodeRuntime } from './lib/workflow-node-runtime.mjs'

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
const mobileNodeRuntime = readText('.node-version-mobile').trim()
const nodeRuntimeVersion = '20.20.2'
const mobileNodeRuntimeVersion = '22.22.0'
const nodeEngineRange = '>=20.19.0 <21'

function checkWorkflowNodeRuntimePins() {
  const workflowsDir = path.join(root, '.github', 'workflows')
  let workflowNames = []
  try {
    workflowNames = fs.readdirSync(workflowsDir).filter((name) => /\.ya?ml$/i.test(name))
  } catch (error) {
    failures.push(`.github/workflows: could not enumerate workflows (${error?.message || error})`)
    return
  }

  for (const workflowName of workflowNames) {
    const relativePath = path.join('.github', 'workflows', workflowName)
    const source = readText(relativePath)
    const mobileRequirements = workflowName === 'android-build.yml'
      ? [
          { job: 'android', command: 'node scripts/release-gates.mjs', field: 'node-version-file', value: '.nvmrc' },
          { job: 'android', command: 'npx cap sync android', field: 'node-version-file', value: '.node-version-mobile' },
        ]
      : workflowName === 'ios-build.yml'
        ? [
            { job: 'ios', command: 'npm run build', field: 'node-version-file', value: '.nvmrc' },
            { job: 'ios', command: 'npx cap sync ios', field: 'node-version-file', value: '.node-version-mobile' },
          ]
        : []
    const allowedNodeVersionFiles = mobileRequirements.length
      ? ['.nvmrc', '.node-version-mobile']
      : ['.nvmrc']

    failures.push(...validateWorkflowNodeRuntime(source, {
      workflowPath: relativePath,
      allowedInlineVersions: [nodeRuntimeVersion],
      allowedNodeVersionFiles,
      requiredRuntimeBeforeCommands: mobileRequirements,
    }))
  }
}

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
  hasRewrite(vercel, '/welcome', '/welcome.html'),
  'the crawlable /welcome route must use its canonical acquisition document',
)
assert(
  hasRewrite(vercel, '/privacy', '/privacy.html'),
  'the crawlable /privacy route must use its distinct privacy document',
)
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
// Exact-token check, not a substring: `csp.includes('ingest.sentry.io')` would
// pass with the host in the wrong directive (or inside another host), and it
// reads to CodeQL as incomplete URL substring sanitization. Browser Sentry
// ingestion specifically needs the wildcard token in connect-src.
const connectSrcTokens = String(csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')) || '').split(/\s+/).slice(1)
assert(connectSrcTokens.includes('https://grantflow-production.up.railway.app'), 'CSP connect-src must carry the exact production Railway backend token')
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
for (const publicRoute of ['/welcome', '/privacy']) {
  const routeHeaderBlock = Array.isArray(vercel.headers)
    ? vercel.headers.find((entry) => entry?.source === publicRoute)
    : null
  assert(
    byKey(routeHeaderBlock?.headers).get('cache-control') === 'no-cache, no-store, must-revalidate',
    `${publicRoute} HTML must stay no-store so canonical metadata changes deploy immediately`,
  )
}

// The Docker runtime image contains only product/runtime files, not the
// build-only scripts directory, so `npm start` (or any npm lifecycle) is the
// wrong entry point there. Railway must invoke the same direct command declared
// by the Dockerfile CMD.
const railwayStart = String(railway?.deploy?.startCommand || '')
// The command may be prefixed by the image entrypoint, which only drops
// privileges and then `exec "$@"` (see docker-entrypoint.sh / #1345). What it
// must NOT do is route through an npm lifecycle.
assert(
  /(^|\s)node backend\/start\.js$/.test(railwayStart),
  'Railway must start the runtime directly (…node backend/start.js); the runtime image carries no build scripts for npm lifecycles',
)
assert(
  !/npm|yarn|pnpm/.test(railwayStart),
  'Railway startCommand must not invoke a package-manager lifecycle; the runtime image has no build scripts',
)
assert(
  railwayStart === 'node backend/start.js'
    || railwayStart === '/usr/local/bin/grantflow-entrypoint node backend/start.js',
  `Railway startCommand must be the direct runtime command, optionally via the image entrypoint; got ${railwayStart}`,
)
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

assert(pkg?.engines?.node === nodeEngineRange, `package.json must require the supported Node range ${nodeEngineRange}`)
assert(lock?.packages?.['']?.engines?.node === pkg?.engines?.node, 'package-lock root engine must match package.json')
assert(nvmrc === nodeRuntimeVersion, `.nvmrc must pin the verified Node runtime ${nodeRuntimeVersion}`)
assert(
  mobileNodeRuntime === mobileNodeRuntimeVersion,
  `.node-version-mobile must pin the verified Capacitor runtime ${mobileNodeRuntimeVersion}`,
)
checkWorkflowNodeRuntimePins()
// Escape every regex metacharacter, not just `.` (js/incomplete-sanitization)
// — nodeRuntimeVersion is a trusted local config value today, but a helper
// that escapes only one character is the wrong general habit to establish.
const escapedNodeRuntimeVersion = nodeRuntimeVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
assert(
  (dockerfile.match(new RegExp(`FROM node:${escapedNodeRuntimeVersion}\\-slim`, 'g')) || []).length === 2,
  `both Docker build and runtime stages must use Node ${nodeRuntimeVersion}`,
)

if (failures.length) {
  console.error('[deployment-config] FAIL')
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}

console.log('[deployment-config] OK')
