// Guard tests for the EVA edge runner's startup-outcome class.
//
// The defect: manifests declared `required_env` and `prerequisites`-shaped
// notes, but the runner supplied NOTHING and checked NOTHING. Every app that
// refuses to boot without a value ("FATAL: set ADMIN_TOKEN") or without an
// external service (Docker) was reported as `startup_failed` with a CRITICAL,
// never-passing `app-startup` finding. Four apps sat that way for days
// (SermonSmith 5 runs, PromoPilot 4, Family Stewardship Navigator 5, all
// "last pass never") — an alarm an owner learns to scroll past.
//
// The rule these tests pin: an app that CANNOT run on this machine is BLOCKED
// with the missing prerequisite NAMED; an app that SHOULD run and did not stays
// a startup failure AND quotes the process's own output.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveLaunchEnv,
  checkPrerequisites,
  describeUnmet,
  loadAppEnvOverrides,
} from '../../tools/eva-edge-runner/src/prereq.mjs'
import { blockedAppResult, startupFailedAppResult } from '../../tools/eva-edge-runner/src/appOutcome.mjs'
import { createOutputRing, ensureDisposableRoot, splitConcurrentSegments } from '../../tools/eva-edge-runner/src/launcher.mjs'
import { expectedConsolePatterns, matchesAny } from '../../tools/eva-edge-runner/src/adapters/web.mjs'

const app = { app_id: 'demo', display_name: 'Demo', repo: 'owner/demo' }

test('the runner SUPPLIES a manifest launch_env — the reason PromoPilot could never boot', () => {
  const manifest = { app_id: 'demo', launch_env: { PROMO_ENABLED: 'false', PORT: '8090' } }
  const { env, sources } = resolveLaunchEnv({ app, manifest, env: { PATH: '/bin' } })
  assert.equal(env.PROMO_ENABLED, 'false')
  assert.equal(env.PORT, '8090')
  assert.equal(env.PATH, '/bin', 'the inherited environment is preserved')
  assert.equal(sources.PORT, 'manifest')
})

test('a declared secret is GENERATED per run and never a fixed literal', () => {
  const manifest = { app_id: 'demo', launch_env_generated: { ADMIN_TOKEN: 'token' } }
  const a = resolveLaunchEnv({ app, manifest, env: {} }).env.ADMIN_TOKEN
  const b = resolveLaunchEnv({ app, manifest, env: {} }).env.ADMIN_TOKEN
  assert.ok(a && a.length >= 16)
  assert.notEqual(a, b, 'a generated secret must differ every run')
})

test('an owner-supplied override beats both the manifest and a generator', () => {
  const manifest = { app_id: 'demo', launch_env: { X: 'from-manifest' }, launch_env_generated: { ADMIN_TOKEN: 'token' } }
  const env = { EVA_APP_ENV: JSON.stringify({ demo: { X: 'from-owner', ADMIN_TOKEN: 'owner-token' } }) }
  const { env: resolved, sources } = resolveLaunchEnv({ app, manifest, env })
  assert.equal(resolved.X, 'from-owner')
  assert.equal(resolved.ADMIN_TOKEN, 'owner-token', 'an owner value is never overwritten by a generated one')
  assert.equal(sources.ADMIN_TOKEN, 'owner')
})

test('overrides for OTHER apps never leak into this one', () => {
  const overrides = loadAppEnvOverrides({ EVA_APP_ENV: JSON.stringify({ other: { DATABASE_URL: 'postgres://x' } }) })
  const { env } = resolveLaunchEnv({ app, manifest: { app_id: 'demo' }, env: {}, overrides })
  assert.equal(env.DATABASE_URL, undefined)
})

test('malformed EVA_APP_ENV is treated as absent — it must never crash the run', () => {
  assert.deepEqual(loadAppEnvOverrides({ EVA_APP_ENV: 'not json' }), {})
})

test('a manifest with NO prerequisites is never blocked (unchanged manifests keep their behavior)', async () => {
  const res = await checkPrerequisites({ manifest: { app_id: 'demo' }, resolvedEnv: {} })
  assert.deepEqual(res.unmet, [])
  assert.equal(res.checked, 0)
})

test('a missing required env is UNMET and names the variable — the SermonSmith DATABASE_URL case', async () => {
  const manifest = {
    app_id: 'sermonsmith',
    prerequisites: [{ id: 'db', type: 'env', env: 'DATABASE_URL', name: 'DATABASE_URL for a disposable Postgres', remedy: 'set EVA_APP_ENV' }],
  }
  const res = await checkPrerequisites({ manifest, resolvedEnv: { DATABASE_URL: '   ' } })
  assert.equal(res.unmet.length, 1)
  assert.match(res.unmet[0].detail, /DATABASE_URL/)
  const supplied = await checkPrerequisites({ manifest, resolvedEnv: { DATABASE_URL: 'postgres://u@h/db' } })
  assert.deepEqual(supplied.unmet, [], 'once supplied, the app is no longer blocked')
})

test('a stopped Docker daemon is UNMET and carries the daemon’s own reason', async () => {
  const manifest = { app_id: 'fsn', prerequisites: [{ id: 'docker', type: 'docker', name: 'Docker daemon', remedy: 'start Docker Desktop' }] }
  const down = await checkPrerequisites({ manifest, probes: { docker: () => ({ ok: false, detail: 'daemon is not running' }) } })
  assert.equal(down.unmet.length, 1)
  assert.equal(down.unmet[0].detail, 'daemon is not running')
  const up = await checkPrerequisites({ manifest, probes: { docker: () => ({ ok: true, detail: 'docker 27' }) } })
  assert.deepEqual(up.unmet, [])
})

test('an unreachable TCP dependency is UNMET; a reachable one is met', async () => {
  const manifest = { app_id: 'x', prerequisites: [{ id: 'pg', type: 'tcp', host: '127.0.0.1', port: 5432, name: 'local Postgres' }] }
  const down = await checkPrerequisites({ manifest, probes: { tcp: async () => ({ ok: false, detail: 'ECONNREFUSED' }) } })
  assert.equal(down.unmet.length, 1)
  const up = await checkPrerequisites({ manifest, probes: { tcp: async () => ({ ok: true, detail: 'ok' }) } })
  assert.deepEqual(up.unmet, [])
})

test('an UNKNOWN prerequisite type is unmet — an unverifiable claim is not a met prerequisite', async () => {
  const manifest = { app_id: 'x', prerequisites: [{ id: 'magic', type: 'wishful-thinking', name: 'Magic' }] }
  const res = await checkPrerequisites({ manifest, resolvedEnv: {} })
  assert.equal(res.unmet.length, 1)
  assert.match(res.unmet[0].detail, /unsupported prerequisite type/)
})

test('describeUnmet names the thing AND the remedy, and clips a noisy probe detail', () => {
  const text = describeUnmet([{ name: 'Docker daemon', detail: 'x'.repeat(500), remedy: 'start Docker Desktop' }], { maxDetail: 20 })
  assert.match(text, /Docker daemon/)
  assert.match(text, /start Docker Desktop/)
  assert.ok(text.length < 200, 'the remedy must not be buried behind 500 chars of daemon noise')
})

test('a BLOCKED app is app_status=blocked with a named prerequisite and a NON-failing startup journey', () => {
  const res = blockedAppResult({
    app,
    manifest: { start_command: 'docker compose up' },
    unmet: [{ name: 'Docker daemon', detail: 'daemon not running', remedy: 'start Docker Desktop' }],
    durationMs: 5,
  })
  assert.equal(res.app_status, 'blocked')
  assert.match(res.blocker_reason, /Docker daemon/)
  assert.match(res.blocker_reason, /start Docker Desktop/)
  assert.equal(res.journeys.length, 1)
  assert.equal(
    res.journeys[0].status,
    'blocked',
    'a missing prerequisite must NOT mint a critical failed finding every night',
  )
  assert.equal(res.journeys[0].severity, undefined)
})

test('a STARTUP FAILURE stays critical AND quotes the process output and the probe URL that actually failed', () => {
  const res = startupFailedAppResult({
    app,
    manifest: { start_command: 'npm run dev:api & npm run dev', base_url: 'http://localhost:5173' },
    launch: {
      failedProbeUrl: 'http://localhost:3001/healthz',
      exitInfos: [{ code: 1 }, { code: 1 }],
      outputTail: () => 'PrismaClientConstructorValidationError: Invalid value undefined for datasource "db"',
    },
    baseUrl: 'http://localhost:5173',
    durationMs: 100,
  })
  assert.equal(res.app_status, 'startup_failed')
  assert.equal(res.journeys[0].status, 'failed')
  assert.equal(res.journeys[0].severity, 'critical')
  assert.match(res.blocker_reason, /localhost:3001\/healthz/, 'the reason names the URL that actually failed, not base_url')
  assert.match(res.blocker_reason, /PrismaClient/, 'the reason quotes the process\u2019s own error')
  assert.match(res.journeys[0].error_signature, /PrismaClient/)
})

test('a startup failure with NO output admits it has no evidence rather than claiming high confidence', () => {
  const res = startupFailedAppResult({
    app,
    manifest: { start_command: 'npm start' },
    launch: { outputTail: () => '', exitInfos: [null] },
  })
  assert.ok(res.journeys[0].diagnostic_confidence < 0.9)
  assert.ok(res.journeys[0].missing_evidence, 'a diagnosis with no output must name its missing evidence')
})

test('the output ring is bounded and returns the TAIL (where a fatal error lands)', () => {
  const ring = createOutputRing(200)
  ring.push('x'.repeat(5000))
  ring.push('\nFATAL: set ADMIN_TOKEN\n')
  assert.match(ring.tail(), /FATAL: set ADMIN_TOKEN/)
  assert.ok(ring.tail().length <= 400)
})

test('the disposable data root is created inside the app repo, and an escaping root is refused', () => {
  const made = []
  const mkdir = (p) => made.push(p)
  assert.ok(ensureDisposableRoot('C:/apps/demo', '.eva-tmp/demo', mkdir))
  assert.equal(ensureDisposableRoot('C:/apps/demo', '../../etc', mkdir), null)
  // Both absolute FORMS are refused on every host — `isAbsolute` alone is
  // platform-dependent and calls "C:/Windows" relative on POSIX.
  assert.equal(ensureDisposableRoot('C:/apps/demo', 'C:/Windows', mkdir), null)
  assert.equal(ensureDisposableRoot('C:/apps/demo', '\\\\server\\share', mkdir), null)
  assert.equal(ensureDisposableRoot('C:/apps/demo', '/etc/passwd', mkdir), null)
  assert.equal(made.length, 1, 'only the safe relative root was created')
})

test('a POSIX "a & b" start_command still means RUN BOTH (regression guard)', () => {
  assert.deepEqual(splitConcurrentSegments('npm run dev:api & npm run dev'), ['npm run dev:api', 'npm run dev'])
  assert.deepEqual(splitConcurrentSegments('cd server && npm start'), ['cd server && npm start'])
})

test('a journey may declare a BY-DESIGN console error as expected, and nothing else is silenced', () => {
  const journey = { expected_console_errors: ['401 (unauthorized)'] }
  const patterns = expectedConsolePatterns(journey)
  assert.equal(matchesAny('Failed to load resource: the server responded with a status of 401 (Unauthorized)', patterns), true)
  assert.equal(matchesAny('TypeError: undefined is not a function', patterns), false, 'a real console error is never silenced')
  assert.equal(matchesAny('500 (Internal Server Error)', patterns), false)
})

test('a journey that declares NOTHING silences NOTHING (default stays strict)', () => {
  assert.deepEqual(expectedConsolePatterns({}), [])
  assert.equal(matchesAny('anything at all', expectedConsolePatterns({})), false)
})
