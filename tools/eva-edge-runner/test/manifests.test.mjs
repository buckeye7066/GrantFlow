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
import { resolveWaitState } from '../src/adapters/web.mjs'

const MANIFEST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'qa', 'manifests')

function loadManifests() {
  return readdirSync(MANIFEST_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, manifest: JSON.parse(readFileSync(join(MANIFEST_DIR, f), 'utf8')) }))
}

const manifests = loadManifests()

test('there are manifests to check (a totality test over an empty set proves nothing)', () => {
  assert.ok(manifests.length >= 15, `expected the full portfolio, found ${manifests.length}`)
})

for (const { file, manifest } of manifests) {
  test(`${file}: a pinned launch_env PORT and the readiness probe agree`, () => {
    const pinned = manifest.launch_env?.PORT ?? manifest.env?.PORT
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
