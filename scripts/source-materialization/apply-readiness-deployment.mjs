import fs from 'node:fs'

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, text) { fs.writeFileSync(file, text) }

function replaceOne(file, pattern, replacement, label) {
  const before = read(file)
  const matches = [...before.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))]
  if (matches.length !== 1) {
    throw new Error(`${label || file}: expected one match, found ${matches.length}`)
  }
  write(file, before.replace(pattern, replacement))
}

function insertBefore(file, marker, text, label) {
  const before = read(file)
  const first = before.indexOf(marker)
  if (first < 0 || before.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`${label || file}: marker missing or ambiguous`)
  }
  write(file, before.slice(0, first) + text + before.slice(first))
}

insertBefore(
  'backend/routes/health.js',
  'const __filename = fileURLToPath(import.meta.url)',
  `const MISSION_READINESS_CACHE_MS = Math.max(5_000, Number(process.env.MISSION_READINESS_CACHE_MS) || 30_000)
let missionReadinessCache = { at: 0, db: null, payload: null }

async function getMissionReadiness(db) {
  const now = Date.now()
  if (
    missionReadinessCache.db === db &&
    missionReadinessCache.payload &&
    now - missionReadinessCache.at < MISSION_READINESS_CACHE_MS
  ) return missionReadinessCache.payload

  const payload = await buildMissionHealth(db)
  missionReadinessCache = { at: now, db, payload }
  return payload
}

function publicFailure(code, timestampKey = 'timestamp') {
  return {
    ok: false,
    status: 'error',
    error_code: code,
    details_redacted: true,
    [timestampKey]: new Date().toISOString(),
  }
}

`,
  'health helpers',
)
replaceOne(
  'backend/routes/health.js',
  /    return res\.status\(500\)\.json\(\{\n      ok: false,\n      status: 'error',\n      summary: 'Failed to retrieve health information',[\s\S]*?\n    \}\)/,
  `    routeLogger.error('public health summary failed', { error: error?.message || String(error) })
    return res.status(500).json({
      ...publicFailure('health_summary_failed'),
      summary: 'Failed to retrieve health information',
    })`,
  'public health error redaction',
)
replaceOne(
  'backend/routes/health.js',
  /      schema_bootstrap_failed: schemaBootstrapFailed,\n      missing_tables: missingTables,\n      detail: locals\.schema_bootstrap_error \|\| dbStartupError \|\| null,/,
  `      schema_bootstrap_failed: schemaBootstrapFailed,
      missing_table_count: missingTables.length,
      details_redacted: true,`,
  'liveness redaction',
)
replaceOne(
  'backend/routes/health.js',
  /      reason: dbCheck\.reason,\n      error: dbCheck\.error \|\| null,/,
  `      reason: dbCheck.reason,
      details_redacted: true,`,
  'DB readiness redaction',
)
replaceOne(
  'backend/routes/health.js',
  /      reason: schema\.reason,\n      missing: schema\.missing \|\| null,\n      error: schema\.error \|\| null,/,
  `      reason: schema.reason,
      missing: schema.missing || null,
      details_redacted: true,`,
  'schema readiness redaction',
)
replaceOne(
  'backend/routes/health.js',
  /      uploads_configured: uploads\.configured \?\? null,\n      error: uploads\.error \|\| null,/,
  `      uploads_configured: uploads.configured ?? null,
      error_code: uploads.error || null,
      details_redacted: true,`,
  'uploads readiness redaction',
)
replaceOne(
  'backend/routes/health.js',
  /  const pipeline = getPipelineHealth\(\)\n\n  return res\.status\(200\)\.json\(\{/,
  `  const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
  const skipMissionGate =
    String(process.env.GRANTFLOW_SKIP_MISSION_GATE || '').toLowerCase() === 'true' ||
    String(process.env.NODE_ENV || '').toLowerCase() === 'test'

  if (isProduction && !skipMissionGate) {
    const mission = await getMissionReadiness(req.db)
    if (mission?.production_gate !== true) {
      return res.status(503).json({
        ok: false,
        status: 'not_ready',
        reason: 'mission_gate_failed',
        release_blockers: Array.isArray(mission?.release_blockers)
          ? mission.release_blockers.map((item) => item?.code).filter(Boolean)
          : ['mission_gate_unavailable'],
        details_redacted: true,
        timestamp: new Date().toISOString(),
      })
    }
  }

  const pipeline = getPipelineHealth()

  return res.status(200).json({`,
  'mission readiness gate',
)
replaceOne(
  'backend/routes/health.js',
  /    pipeline_status: pipeline\.overall,\n    timestamp:/,
  `    pipeline_status: pipeline.overall,
    mission_gate: isProduction && !skipMissionGate ? 'passed' : 'not_enforced',
    timestamp:`,
  'mission readiness signal',
)
replaceOne(
  'backend/routes/health.js',
  /    const payload = await buildMissionHealth\(req\.db\)\n    const code = payload\?\.ok === false \? 503 : 200/,
  `    const payload = await getMissionReadiness(req.db)
    const code = payload?.ok === false || payload?.production_gate === false ? 503 : 200`,
  'mission endpoint status',
)
replaceOne(
  'backend/routes/health.js',
  /    return res\.status\(500\)\.json\(\{\n      ok: false,\n      error: err\?\.message \?\? String\(err\),\n      generated_at: new Date\(\)\.toISOString\(\),\n    \}\)/,
  "    return res.status(500).json(publicFailure('mission_health_failed', 'generated_at'))",
  'mission public error redaction',
)

insertBefore(
  'backend/services/productionReadinessChecks.js',
  "const TRUE_VALUES = new Set",
  "import { twilioWebhookPosture } from './twilioWebhookSecurity.js'\n\n",
  'Twilio readiness import',
)
insertBefore(
  'backend/services/productionReadinessChecks.js',
  '/**\n * Aggregate all checks into a single readiness report.',
  `/**
 * Check 7: configured production SMS must authenticate inbound consent mutations.
 */
export function checkTwilioWebhookSecurity({ env = process.env } = {}) {
  const posture = twilioWebhookPosture(env)
  if (!posture.production || !posture.configured) {
    return {
      id: 'twilio_webhook_security',
      level: 'info',
      detail: posture.production ? 'Twilio SMS is not configured.' : 'NODE_ENV is not production.',
      ok: true,
    }
  }
  if (!posture.token_configured) {
    return {
      id: 'twilio_webhook_security',
      level: 'error',
      detail: 'Twilio SMS is configured in production but TWILIO_AUTH_TOKEN is missing.',
      ok: false,
    }
  }
  if (posture.validation_explicitly_disabled) {
    return {
      id: 'twilio_webhook_security',
      level: 'error',
      detail: 'TWILIO_VALIDATE_SIGNATURE=false is forbidden in production.',
      ok: false,
    }
  }
  return {
    id: 'twilio_webhook_security',
    level: 'info',
    detail: 'Twilio inbound webhook signatures are required in production.',
    ok: true,
  }
}

`,
  'Twilio readiness check',
)
replaceOne(
  'backend/services/productionReadinessChecks.js',
  /    checkMissionHealthAvailability\(missionHealth, \{ selfReference \}\),\n  \]/,
  `    checkMissionHealthAvailability(missionHealth, { selfReference }),
    checkTwilioWebhookSecurity({ env }),
  ]`,
  'Twilio readiness aggregation',
)

replaceOne(
  'scripts/check-deployment-config.mjs',
  /function hasRewrite\(vercel, source, destination\) \{[\s\S]*?\n\}/,
  `function findRewrite(vercel, source, destination) {
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
}`,
  'deployment helpers',
)
replaceOne(
  'scripts/check-deployment-config.mjs',
  /assert\(hasRewrite\(vercel, '\/grantflow\/api\/:path\*', railwayApi\),[^\n]*\nassert\(hasRewrite\(vercel, '\/api\/:path\*', railwayApi\),[^\n]*\nassert\(hasRewrite\(vercel, '\/grantflow\/uploads\/:path\*', railwayUploads\),[^\n]*\nassert\(hasRewrite\(vercel, '\/uploads\/:path\*', railwayUploads\),[^\n]*\n/,
  `const productionRewrites = [
  ['/grantflow/api/:path*', railwayApi],
  ['/api/:path*', railwayApi],
  ['/grantflow/uploads/:path*', railwayUploads],
  ['/uploads/:path*', railwayUploads],
]
for (const [source, destination] of productionRewrites) {
  const rewrite = findRewrite(vercel, source, destination)
  assert(Boolean(rewrite), \`vercel.json must proxy \${source} to the Railway production backend\`)
  assert(hasProductionHostGuard(rewrite), \`production rewrite \${source} must be host-gated\`)
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
`,
  'deployment rewrite assertions',
)
replaceOne(
  'scripts/check-deployment-config.mjs',
  /assert\(csp\.includes\('https:\/\/grantflow-production\.up\.railway\.app'\),[^\n]*\)/,
  `assert(csp.includes('https://grantflow-production.up.railway.app'), 'CSP must allow the production Railway backend')
// Exact-token check, not a substring: \`csp.includes('ingest.sentry.io')\` would
// pass with the host in the wrong directive (or inside another host), and it
// reads to CodeQL as incomplete URL substring sanitization. Browser Sentry
// ingestion specifically needs the wildcard token in connect-src.
const connectSrcTokens = String(csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')) || '').split(/\\s+/).slice(1)
assert(connectSrcTokens.includes('https://*.ingest.sentry.io'), 'CSP connect-src must carry the exact https://*.ingest.sentry.io token for browser Sentry ingestion')`,
  'CSP assertions',
)

replaceOne(
  'src/config/env.js',
  /  VITE_API_URL: z\.string\(\)\.optional\(\),/,
  `  VITE_API_URL: z.string().optional(),
  VITE_PREVIEW_API_URL: z.string().optional(),`,
  'preview env schema',
)
replaceOne(
  'src/config/env.js',
  /    VITE_API_URL: import\.meta\.env\.VITE_API_URL,/,
  `    VITE_API_URL: import.meta.env.VITE_API_URL,
    VITE_PREVIEW_API_URL: import.meta.env.VITE_PREVIEW_API_URL,`,
  'preview env read',
)
replaceOne(
  'src/config/env.js',
  /  const apiUrlRaw = String\(raw\.VITE_API_URL \|\| ''\)\.trim\(\)\n  let apiUrl = apiUrlRaw \? apiUrlRaw : ''/,
  `  const apiUrlRaw = String(raw.VITE_API_URL || '').trim()
  const previewApiUrl = String(raw.VITE_PREVIEW_API_URL || '').trim()
  let apiUrl = apiUrlRaw ? apiUrlRaw : ''

  if (
    typeof window !== 'undefined' &&
    /\\.vercel\\.app$/i.test(String(window.location.hostname || ''))
  ) {
    apiUrl = previewApiUrl
  }`,
  'preview API selection',
)

for (const file of ['.env.example', 'backend/.env.example', 'backend/env.example']) {
  if (!fs.existsSync(file)) continue
  const text = read(file)
  if (text.includes('VITE_PREVIEW_API_URL=')) continue
  const match = text.match(/^VITE_API_URL=.*$/m)
  if (match) {
    write(file, text.replace(
      match[0],
      `${match[0]}
# Staging API for Vercel previews and unsigned/debug mobile builds. Never use production here.
VITE_PREVIEW_API_URL=`,
    ))
  } else {
    write(file, `${text}
# Staging API for Vercel previews and unsigned/debug mobile builds.
VITE_PREVIEW_API_URL=
`)
  }
}

console.log('[global-hardening] readiness and deployment transformations applied')
