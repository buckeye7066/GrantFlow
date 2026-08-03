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

test('an explicitly declared wait state still wins, and a real element still needs to be VISIBLE', () => {
  assert.equal(resolveWaitState({ selector: 'body' }), 'attached')
  assert.equal(resolveWaitState({ selector: 'body', state: 'visible' }), 'visible', 'an explicit state is honored')
  assert.equal(resolveWaitState({ selector: 'input[type=email]' }), 'visible', 'the fix lowers no bar for real elements')
  assert.equal(resolveWaitState({ selector: '#root' }), 'visible', 'an app mount point is a real element, not the document')
})
