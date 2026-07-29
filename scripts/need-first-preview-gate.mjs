import { spawnSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function buildCleanRoomEnv() {
  const env = { ...process.env }
  const exact = new Set([
    'DATABASE_URL',
    'DATABASE_PUBLIC_URL',
    'DATABASE_PRIVATE_URL',
    'POSTGRES_URL',
    'POSTGRES_PRISMA_URL',
    'POSTGRES_URL_NON_POOLING',
    'PGHOST',
    'PGHOST_UNPOOLED',
    'PGPORT',
    'PGUSER',
    'PGPASSWORD',
    'PGDATABASE',
    'DB_PROVIDER',
    'DB_DIALECT',
    'SQLITE_DB_PATH',
    'VITE_API_URL',
    'VITE_API_BASE_URL',
    'VITE_BACKEND_URL',
    'URL_VERIFICATION_ENABLED',
  ])
  const secretPrefixes = [
    'RAILWAY_',
    'TWILIO_',
    'RESEND_',
    'SMTP_',
    'OPENAI_',
    'ANTHROPIC_',
    'GOOGLE_',
    'BING_',
    'BRAVE_',
    'SERPAPI_',
    'SIMPLER_',
    'GRANTS_GOV_',
    'API_DATA_GOV_',
    'RUNTIME_SECRET_',
    'ENCRYPTION_',
  ]

  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    if (
      exact.has(key) ||
      upper.includes('SAM_GOV') ||
      secretPrefixes.some((prefix) => upper.startsWith(prefix))
    ) {
      delete env[key]
    }
  }

  Object.assign(env, {
    NODE_ENV: 'test',
    DB_PROVIDER: 'sqlite',
    DB_DIALECT: 'sqlite',
    DB_AUTO_MIGRATE: 'true',
    ALLOW_EPHEMERAL_SQLITE: 'true',
    ALLOW_EPHEMERAL_UPLOADS: 'true',
    DISABLE_BACKGROUND_SERVICES: 'true',
    SMOKE_MODE: 'true',
    URL_VERIFICATION_ENABLED: 'false',
    ANYA_AUTONOMOUS_ENABLED: 'false',
    ANYA_RUN_ON_STARTUP: 'false',
    ANYA_RUN_ON_SCHEDULE: 'false',
    NATIONAL_PROGRAMS_CRAWLER_ENABLED: 'false',
    STARTUP_SMOKE_CRAWL_ENABLED: 'false',
  })
  return env
}

const cleanRoomEnv = buildCleanRoomEnv()

function run(args, label, env = cleanRoomEnv) {
  console.log(`[need-first-preview-gate] ${label}`)
  const result = spawnSync(npm, args, {
    stdio: 'inherit',
    env,
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status}`)
  }
}

run([
  'exec', '--', 'vitest', 'run',
  'backend/tests/needFirstMatchPolicy.test.js',
  'backend/tests/needFirstPolicyEdgeCases.test.js',
  'backend/tests/needFirstProductionExamples.test.js',
  'backend/tests/persistedMatchTruth.test.js',
  'backend/tests/persistedNeedFirstEdgeCases.test.js',
  'backend/tests/remainingAuditCorrections.test.js',
  'backend/tests/fundingSourceCounts.test.js',
  '--reporter=verbose',
], 'focused Vitest regressions')

run(['exec', '--', 'node', 'scripts/need-first-build-self-test.mjs'], 'backend integration assertions')
run(['run', 'check:prepush'], 'pre-push quality suite')
run(['run', 'scan:secrets'], 'secret scan')
run(['audit', '--omit=dev', '--audit-level=high'], 'production dependency audit')
run(['run', 'release:gates'], 'complete clean-room release gates')
run(['run', 'build'], 'production Vite build', process.env)

console.log('[need-first-preview-gate] PASS')
