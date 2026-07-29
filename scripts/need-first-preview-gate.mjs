import { spawnSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function buildCleanRoomEnv() {
  // Deliberately allowlist only operating-system values needed to launch Node/npm.
  // Copying process.env and deleting a handful of names is not a clean room: Vercel
  // injects production-like feature flags, scheduler targets, auth secrets, and
  // service credentials into preview builds. Those changed test defaults for Amy,
  // Yana, Hamilton/Outlook, and auth even though the product code was correct.
  const passthrough = [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
    'NPM_CONFIG_CACHE',
    'npm_config_cache',
    'NODE_OPTIONS',
  ]
  const env = {}
  for (const key of passthrough) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }

  Object.assign(env, {
    NODE_ENV: 'test',
    CI: 'true',
    DB_PROVIDER: 'sqlite',
    DB_DIALECT: 'sqlite',
    DB_AUTO_MIGRATE: 'true',
    ALLOW_EPHEMERAL_SQLITE: 'true',
    ALLOW_EPHEMERAL_UPLOADS: 'true',
    DISABLE_BACKGROUND_SERVICES: 'true',
    SMOKE_MODE: 'true',
    URL_VERIFICATION_ENABLED: 'false',
    OPPORTUNITY_INSERT_VERIFY_URL: 'false',
    ANYA_AUTONOMOUS_ENABLED: 'false',
    ANYA_RUN_ON_STARTUP: 'false',
    ANYA_RUN_ON_SCHEDULE: 'false',
    NATIONAL_PROGRAMS_CRAWLER_ENABLED: 'false',
    STARTUP_SMOKE_CRAWL_ENABLED: 'false',
    HAMILTON_ALLOW_AUTOSUBMIT: 'false',
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

run([
  'exec', '--', 'node', '--test',
  'tests/unit/opportunityInserter.test.mjs',
  'tests/unit/geo-crawl-zip-44089-minimums.test.mjs',
], 'shared release regressions')

run(['exec', '--', 'node', 'scripts/need-first-build-self-test.mjs'], 'backend integration assertions')
run(['run', 'check:prepush'], 'pre-push quality suite')
run(['run', 'scan:secrets'], 'secret scan')
run(['audit', '--omit=dev', '--audit-level=high'], 'production dependency audit')
run(['run', 'release:gates'], 'complete clean-room release gates')
run(['run', 'build'], 'production Vite build', {
  ...cleanRoomEnv,
  NODE_ENV: 'production',
})

console.log('[need-first-preview-gate] PASS')
