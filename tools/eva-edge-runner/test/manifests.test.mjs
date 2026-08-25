// REGISTRY TOTALITY over every EVA manifest.
//
// The 2026-08-03 sermonsmith failure was not a bug in any one file: a manifest's
// `readiness_probe.port` is a GUESS about what the app will bind, and nothing
// re-asserted it. The app's local (gitignored) .env moved the API from 3001 to
// 3101 and the probe polled the old port every night for as long as it took
// someone to read the app's own stdout.
//
// The permanent form of the fix is a CHOKE POINT the whole fleet passes through:
// when a manifest PINS the port in launch_env, EVA decides the port instead of
// discovering it, and this test asserts the two can never drift apart again. It
// runs over all manifests, so a NEW app inherits the guard for free.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWaitState, gotoWithRetry } from '../src/adapters/web.mjs'
import { inferExecutableRequirements } from '../src/prereq.mjs'

const MANIFEST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'qa', 'manifests')

function loadManifests() {
  return readdirSync(MANIFEST_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, manifest: JSON.parse(readFileSync(join(MANIFEST_DIR, f), 'utf8')) }))
}

const manifests = loadManifests()
const portfolioRegistry = JSON.parse(readFileSync(join(MANIFEST_DIR, '..', 'portfolio-registry.json'), 'utf8'))

function manifestById(appId) {
  const entry = manifests.find(({ manifest }) => manifest.app_id === appId)
  assert.ok(entry, `missing manifest for ${appId}`)
  return entry.manifest
}

test('there are manifests to check (a totality test over an empty set proves nothing)', () => {
  assert.ok(manifests.length >= 15, `expected the full portfolio, found ${manifests.length}`)
})

test('scheduled and coverage journey ids always resolve to a declared journey', () => {
  for (const { file, manifest } of manifests) {
    const ids = new Set((manifest.journeys || []).map((journey) => journey.id))
    for (const listName of ['nightly_critical_journeys', 'weekly_full_journeys']) {
      for (const id of manifest[listName] || []) {
        assert.ok(ids.has(id), `${file}: ${listName} references missing journey ${id}`)
      }
    }
    for (const item of manifest.coverage || []) {
      for (const id of item.journeys || []) {
        assert.ok(ids.has(id), `${file}: coverage for ${item.feature} references missing journey ${id}`)
      }
    }
  }
})

test('registry and canonical manifests agree on repository identity for every app', () => {
  const byId = new Map((portfolioRegistry.apps || []).map((app) => [app.app_id, app]))
  for (const { file, manifest } of manifests) {
    const registered = byId.get(manifest.app_id)
    assert.ok(registered, `${file}: app is absent from portfolio registry`)
    assert.equal(registered.repo, manifest.repo, `${file}: registry repo would misattribute tested provenance`)
  }
})

test('offline/no-spend manifests never require a paid AI key that policy says must stay unset', () => {
  const paidKey = /^(?:ANTHROPIC|OPENAI|GEMINI|LLM)_API_KEY$/i
  const noSpendPolicy = /no (?:real )?(?:anthropic|openai|llm|ai).*spend|leave .*key.*unset|do not connect (?:a )?real .*key/i
  for (const { file, manifest } of manifests) {
    if (!(manifest.prohibited_actions || []).some((action) => noSpendPolicy.test(String(action)))) continue
    const conflicting = (manifest.required_env || []).filter((name) => paidKey.test(String(name)))
    assert.deepEqual(
      conflicting,
      [],
      `${file}: a key deliberately prohibited for offline journeys cannot also be required at boot`,
    )
  }
})

test('every required_env name has a canonical value, generator, or named env prerequisite', () => {
  for (const { file, manifest } of manifests) {
    const supplied = new Set([
      ...Object.keys(manifest.launch_env || manifest.env || {}),
      ...Object.keys(manifest.launch_env_generated || {}),
      ...(manifest.prerequisites || [])
        .filter((p) => p?.type === 'env')
        .flatMap((p) => (Array.isArray(p.env) ? p.env : [p.env]))
        .filter(Boolean),
    ])
    const unresolved = (manifest.required_env || []).filter((name) => !supplied.has(name))
    assert.deepEqual(
      unresolved,
      [],
      `${file}: required_env must be supplied safely or carry an explicit owner-remedy prerequisite`,
    )
  }
})

test('every runnable manifest resolves at least one executable runtime prerequisite', () => {
  for (const { file, manifest } of manifests) {
    if (!manifest.start_command || manifest.start_command === 'n/a') continue
    assert.ok(
      inferExecutableRequirements(manifest).length > 0,
      `${file}: start/journey commands must map to executable preflight checks`,
    )
  }
})

test('repaired portfolio manifests preserve their current repository contracts', () => {
  const publisher = manifestById('app-store-publisher')
  assert.equal(publisher.launch_env?.PORT, '4000')
  assert.equal(publisher.launch_env?.PUBLISHER_HOST, '127.0.0.1')
  assert.equal(publisher.base_url, 'http://127.0.0.1:4000')
  for (const name of [
    'DOTENV_CONFIG_PATH',
    'PUBLISHER_VAULT_PATH',
    'PUBLISHER_UPLOAD_DIR',
    'PUBLISHER_LEDGER_PATH',
    'PUBLISHER_STATE_PATH',
    'PUBLISHER_FLAGS_PATH',
  ]) {
    assert.match(
      publisher.launch_env?.[name] || '',
      /^\.eva-tmp\/app-store-publisher\//,
      `${name} must stay under the disposable data root`,
    )
  }

  const castle = manifestById('family-castle-clash')
  const castleIdentity = castle.journeys.find((journey) => journey.id === 'app-identifies-itself')
  const castleRegister = castle.journeys.find((journey) => journey.id === 'register-offline-account')
  assert.ok(castleIdentity.steps.some((step) => step.selector === "img[alt='Family Castle Clash']"))
  assert.ok(castleRegister.steps.some((step) => step.selector === '#player-name'))
  assert.ok(castleRegister.steps.some((step) => step.selector === '#player-pin'))
  assert.ok(castleRegister.steps.some((step) => step.selector === "button:has-text('Create household admin')"))
  assert.equal(castleRegister.assert[0]?.value, 'Welcome back, eva-fixture')
  assert.deepEqual(castleIdentity.candidate_files, ['client/src/App.jsx', 'client/src/screens/Login.jsx', 'server/index.js'])
  assert.deepEqual(castleRegister.candidate_files, ['client/src/screens/Login.jsx', 'client/src/screens/Home.jsx', 'server/auth.js'])
  assert.doesNotMatch(JSON.stringify(castle.journeys), /Your name|Create Account|Signed in as/)

  const math = manifestById('mind-over-math')
  const mathBackend = String(math.start_command).split(/\s+&\s+/)[0]
  assert.equal(mathBackend, 'cd backend && npm start', 'the monitored backend must not use node --watch')
  assert.ok(
    math.prerequisites?.some((p) => p.type === 'tcp' && p.host === '127.0.0.1' && Number(p.port) === 5432),
    'Mind Over Math must block on an unavailable local Postgres instead of entering a restart loop',
  )

  const mice = manifestById('are-we-mice-or-are-we-men')
  assert.ok(
    mice.prerequisites?.some((p) => p.type === 'tcp' && p.host === '127.0.0.1' && Number(p.port) === 5432),
    'Are We Mice must block before its database-initializing backend enters a startup/restart failure',
  )

  const livehealth = manifestById('livehealth')
  assert.equal(livehealth.start_command, 'cd server && npm start & npx vite --host 127.0.0.1 --port 5273 --strictPort')
  assert.equal(livehealth.readiness_probe?.type, 'http')
  assert.equal(livehealth.readiness_probe?.path, '/healthz')
  assert.equal(livehealth.readiness_probe?.port, 3210)
  assert.equal(livehealth.readiness_probe?.timeout_ms, 60000)
  assert.ok(livehealth.readiness_probe?.warm_paths?.includes('/@vite/client'))
  assert.equal(livehealth.base_url, 'http://127.0.0.1:5273')
  assert.equal(livehealth.launch_env?.VITE_API_URL, 'http://127.0.0.1:3210')
  assert.equal(livehealth.launch_env?.CORS_ORIGIN, 'http://127.0.0.1:5273')

  const factory = manifestById('factory-deck')
  assert.equal(factory.repo, 'buckeye7066/local-ai-factory')
  assert.deepEqual(factory.nightly_critical_journeys, ['app-identifies-itself'])
  assert.deepEqual(factory.weekly_full_journeys, ['app-identifies-itself'])
  assert.equal(factory.journeys.some((journey) => journey.id === 'demo-mode-visible'), false)
  assert.equal(factory.coverage.some((item) => (item.journeys || []).includes('demo-mode-visible')), false)

  const geneMap = manifestById('genemap-discovery')
  assert.equal(geneMap.node_engine, '>=24', 'the runner must enforce GeneMap current package Node engine before launch')
  assert.deepEqual(geneMap.journeys.find((journey) => journey.id === 'app-identifies-itself')?.candidate_files, ['apps/web/pages/Login.jsx'])
  assert.deepEqual(geneMap.journeys.find((journey) => journey.id === 'reach-register')?.candidate_files, ['apps/web/pages/Login.jsx'])
  assert.deepEqual(geneMap.journeys.find((journey) => journey.id === 'public-privacy-policy')?.candidate_files, ['apps/web/pages/PrivacyPolicy.jsx'])
})

for (const { file, manifest } of manifests) {
  test(`${file}: a pinned launch_env PORT and the readiness probe agree`, () => {
    const pinned = manifest.launch_env?.PORT ?? manifest.env?.PORT
    if ((manifest.required_env || []).includes('PORT')) {
      assert.notEqual(
        pinned,
        undefined,
        'required_env.PORT must be supplied by the manifest; sanitized host env is not a portable port contract',
      )
    }
    if (pinned === undefined) return // not pinned: the probe is the only claim, nothing to contradict
    assert.equal(
      Number(pinned),
      Number(manifest.readiness_probe?.port),
      'launch_env.PORT is what the app will bind; readiness_probe.port must poll that same port',
    )
  })

  test(`${file}: every port EVA declares is on its own allowlist`, () => {
    const allowed = new Set((manifest.allowlist?.ports || []).map(Number))
    if (!allowed.size) return
    const declared = []
    if (manifest.readiness_probe?.port) declared.push(Number(manifest.readiness_probe.port))
    if (manifest.base_url) {
      try {
        const p = Number(new URL(manifest.base_url).port)
        if (p) declared.push(p)
      } catch {
        /* a base_url with no port (80/443) declares nothing here */
      }
    }
    for (const p of declared) {
      assert.ok(allowed.has(p), `port ${p} is declared but not in allowlist.ports [${[...allowed].join(', ')}]`)
    }
  })

  test(`${file}: a journey's first wait never asserts the DOCUMENT is "visible"`, () => {
    // `waitForSelector('body')` means "the page exists". Playwright's default
    // state is `visible`, which for a not-yet-painted body is false — the
    // "24 x locator resolved to hidden <body>" class that kept CRISPR Compass
    // red for 7 nights and also hit SermonSmith. The adapter resolves the
    // document root to `attached`; this asserts every manifest gets that.
    for (const journey of manifest.journeys || []) {
      for (const step of journey.steps || []) {
        if (step.action !== 'waitForSelector') continue
        const sel = String(step.selector || '').trim().toLowerCase()
        if (!['body', 'html', ':root'].includes(sel)) continue
        assert.equal(
          resolveWaitState(step),
          'attached',
          `${journey.id}: waiting for the document root must not require a painted box`,
        )
      }
    }
  })
}

// THE PER-REPO MANIFEST IS THE ONE THE RUNNER ACTUALLY READS (2026-08-04).
// loadManifest (src/config.mjs) PREFERS <local_path>/qa/user-journeys.json over
// the qa/manifests bundle — so grantflow's 2026-08-01 readiness fix (#1087:
// probe the backend's own 8080, 120s timeout) landed in a file the runner
// never consulted, while the per-repo copy kept `port_env` (a field the runner
// has never understood) + 60s. Readiness silently degraded to
// GET http://localhost:5173/api/health@60s and grantflow reported
// startup_failed on 2026-08-01 and 2026-08-04 (recorded blocker: that exact
// URL, duration 67.9s) whenever a cold `dev:full` took >60s. Two files that
// both claim to be the manifest must not be allowed to drift.
test('grantflow per-repo qa/user-journeys.json agrees with the bundle manifest and uses fields the runner understands', () => {
  const perRepo = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'qa', 'user-journeys.json'), 'utf8'),
  )
  const bundle = manifests.find((m) => m.file === 'grantflow.json')?.manifest
  assert.ok(bundle, 'the grantflow bundle manifest exists')
  const probe = perRepo.readiness_probe || {}
  assert.equal(probe.port_env, undefined, '`port_env` is not a field the runner reads — declare `port`')
  assert.equal(Number(probe.port), Number(bundle.readiness_probe?.port), 'probe port must match the bundle')
  assert.equal(probe.path, bundle.readiness_probe?.path, 'probe path must match the bundle')
  assert.equal(
    Number(probe.timeout_ms),
    Number(bundle.readiness_probe?.timeout_ms),
    'probe timeout must match the bundle',
  )
  // The declared probe port must be on the app's own allowlist (same rule the
  // bundle loop above enforces).
  const allowed = new Set((perRepo.allowlist?.ports || []).map(Number))
  if (allowed.size && probe.port) {
    assert.ok(allowed.has(Number(probe.port)), `probe port ${probe.port} missing from allowlist.ports`)
  }
})

test('an explicitly declared wait state still wins, and a real element still needs to be VISIBLE', () => {
  assert.equal(resolveWaitState({ selector: 'body' }), 'attached')
  assert.equal(resolveWaitState({ selector: 'body', state: 'visible' }), 'visible', 'an explicit state is honored')
  assert.equal(resolveWaitState({ selector: 'input[type=email]' }), 'visible', 'the fix lowers no bar for real elements')
  assert.equal(resolveWaitState({ selector: '#root' }), 'visible', 'an app mount point is a real element, not the document')
})

test('transient first-navigation failures are retried before becoming app findings', async () => {
  let calls = 0
  const page = {
    async goto() {
      calls += 1
      if (calls < 3) throw new Error('page.goto: Timeout 30000ms exceeded')
      return { ok: true }
    },
    async evaluate() { throw new Error('no committed document') },
    async waitForTimeout() {},
  }
  const result = await gotoWithRetry(page, 'http://localhost:5173/Login', { timeout: 10, attempts: 3, delayMs: 0 })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls, 3)
})

test('a committed usable document survives a late DOMContentLoaded timeout', async () => {
  let calls = 0
  const page = {
    async goto() { calls += 1; throw new Error('page.goto: Timeout 30000ms exceeded') },
    async evaluate() { return 'interactive' },
    url() { return 'http://localhost:5173/' },
    async waitForTimeout() {},
  }
  const result = await gotoWithRetry(page, 'http://localhost:5173/', { timeout: 10, attempts: 3, delayMs: 0 })
  assert.equal(result, null)
  assert.equal(calls, 1, 'semantic journey assertions, not a redundant navigation, now decide success')
})

test('about:blank or a prior route never masquerades as the requested committed document', async () => {
  for (const current of ['about:blank', 'http://localhost:5173/previous']) {
    let calls = 0
    const page = {
      async goto() {
        calls += 1
        if (calls === 1) throw new Error('page.goto: Timeout 30000ms exceeded')
        return { ok: true }
      },
      async evaluate() { return 'complete' },
      url() { return current },
      async waitForTimeout() {},
    }
    const result = await gotoWithRetry(page, 'http://localhost:5173/target', { timeout: 10, attempts: 2, delayMs: 0 })
    assert.deepEqual(result, { ok: true })
    assert.equal(calls, 2, `${current} must not suppress the retry`)
  }
})

// DOCKER-PUBLISHED PORT TOTALITY (2026-08-15). Docker Desktop publishes a
// compose stack's container ports through com.docker.backend for as long as the
// daemon runs, and the launcher's PROTECTED_PORT_HOLDERS rule (correctly)
// refuses to kill it — so any OTHER app pinning one of those ports can NEVER
// bind it on a machine where Docker is up. This is not hypothetical: are-we-mice
// and mind-over-math both pinned 3001 (family-stewardship-navigator's published
// server port) and failed EVERY nightly run with "PORT HELD BY A PROTECTED
// PROCESS", and factory-deck sat on the published 5180 as a latent copy of the
// same defect (masked only by its credits block). The docker-owned set is
// DERIVED from the registry itself — every `allowlist.ports` entry of a
// manifest declaring a docker-type prerequisite — so a new compose app extends
// the guard automatically and a new claimant reds CI instead of the fleet.
test('no manifest claims a port a docker-prerequisite app publishes machine-wide', () => {
  const dockerApps = manifests.filter(({ manifest }) =>
    (manifest.prerequisites || []).some((p) => p?.type === 'docker'),
  )
  assert.ok(dockerApps.length > 0, 'the guard must have a docker app to derive from (FSN)')
  const published = new Map() // port -> docker app file
  for (const { file, manifest } of dockerApps) {
    for (const port of manifest.allowlist?.ports || []) published.set(Number(port), file)
  }
  for (const { file, manifest } of manifests) {
    if (dockerApps.some((d) => d.file === file)) continue
    const declared = new Set(
      [
        manifest.readiness_probe?.port,
        ...(manifest.allowlist?.ports || []),
        Number(manifest.launch_env?.PORT),
        (() => { try { return Number(new URL(manifest.base_url).port) } catch { return NaN } })(),
      ].map(Number).filter((p) => Number.isFinite(p) && p > 0),
    )
    for (const port of declared) {
      assert.ok(
        !published.has(port),
        `${file}: declares port ${port}, which ${published.get(port)} publishes through Docker (com.docker.backend) — the app can never bind it while Docker runs; pick an unclaimed port`,
      )
    }
  }
})
