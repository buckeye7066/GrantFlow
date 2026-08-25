// Portable local_path resolution — the 2026-08-06 sanitization regression.
//
// The "controlled beta" hardening pass replaced the real Windows username with
// `example_user` in qa/portfolio-registry.json and every qa/manifests/*.json.
// Correct for the repo (no real local username committed), fatal for the runner:
// those same files are where each app's cwd comes from, so every launch spawned
// with a nonexistent cwd and died as `spawn …cmd.exe ENOENT` — 13 of 14 apps
// startup_failed every night from 2026-08-07 to 2026-08-15.
//
// The permanent form: local_path is written PORTABLY (`~/<repo-dir>`), expanded
// at the two choke points every consumer passes through (loadRegistry +
// loadManifest), and a totality test refuses any machine-specific user path so
// the sanitizer and the runner can never fight over these files again.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  expandLocalPath,
  loadRegistry,
  loadManifest,
  loadRunnerConfig,
  formatRunnerVersion,
  RUNNER_SEMVER,
} from '../src/config.mjs'
import { launchWebApp } from '../src/launcher.mjs'

const QA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'qa')

test('runner SemVer has one authority and matches package.json', () => {
  const packageJson = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
  assert.equal(RUNNER_SEMVER, packageJson.version)
})

test('runner version is SemVer plus the verified build SHA and stays schema-bounded', () => {
  const fullSha = 'ABCDEF0123456789abcdef0123456789ABCDEF01'
  assert.equal(formatRunnerVersion(fullSha), `${RUNNER_SEMVER}+abcdef012345`)
  const cfg = loadRunnerConfig({ EVA_RUNNER_BUILD_SHA: fullSha })
  assert.equal(cfg.version, `${RUNNER_SEMVER}+abcdef012345`)
  assert.ok(cfg.version.length <= 32)
})

test('an absent, abbreviated, or malformed build SHA cannot claim runner provenance', () => {
  assert.equal(formatRunnerVersion(), RUNNER_SEMVER)
  assert.equal(formatRunnerVersion('abc123def456'), RUNNER_SEMVER)
  assert.equal(formatRunnerVersion('not-a-sha'), RUNNER_SEMVER)
})

test('expandLocalPath expands ~/ against the given home', () => {
  assert.equal(expandLocalPath('~/GrantFlow', 'C:\\Users\\someone'), join('C:\\Users\\someone', 'GrantFlow'))
  assert.equal(expandLocalPath('~', '/home/u'), '/home/u')
})

test('expandLocalPath leaves absolute and empty paths untouched', () => {
  assert.equal(expandLocalPath('G:/family-stewardship-navigator', 'C:\\Users\\x'), 'G:/family-stewardship-navigator')
  assert.equal(expandLocalPath('', 'C:\\Users\\x'), '')
  assert.equal(expandLocalPath(null, 'C:\\Users\\x'), null)
  // A mid-string tilde is not a home reference.
  assert.equal(expandLocalPath('C:/x/~y', 'C:\\Users\\x'), 'C:/x/~y')
})

test('loadRegistry expands every app local_path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eva-cfg-'))
  try {
    const p = join(dir, 'registry.json')
    writeFileSync(p, JSON.stringify({ apps: [{ app_id: 'a', local_path: '~/some-repo' }, { app_id: 'b', local_path: 'G:/kept' }] }))
    const reg = loadRegistry({ EVA_REGISTRY_PATH: p })
    assert.ok(!reg.apps[0].local_path.startsWith('~'), 'tilde path must be expanded')
    assert.ok(reg.apps[0].local_path.endsWith('some-repo'))
    assert.equal(reg.apps[1].local_path, 'G:/kept')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadManifest expands the bundled manifest local_path (it outranks the registry in the launcher)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eva-man-'))
  try {
    writeFileSync(join(dir, 'someapp.json'), JSON.stringify({ app_id: 'someapp', local_path: '~/someapp' }))
    const manifest = loadManifest(join(dir, 'does-not-exist'), 'someapp', { EVA_MANIFEST_DIR: dir })
    assert.ok(manifest, 'bundled manifest loads')
    assert.ok(!manifest.local_path.startsWith('~'), 'tilde path must be expanded')
    assert.ok(manifest.local_path.endsWith('someapp'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the versioned central manifest outranks a stale per-repo copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eva-man-priority-'))
  try {
    const repo = join(dir, 'repo')
    const bundle = join(dir, 'bundle')
    const qa = join(repo, 'qa')
    mkdirSync(qa, { recursive: true })
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(qa, 'user-journeys.json'), JSON.stringify({ app_id: 'app', readiness_probe: { port: 1111 } }))
    writeFileSync(join(bundle, 'app.json'), JSON.stringify({ app_id: 'app', readiness_probe: { port: 2222 } }))
    const manifest = loadManifest(repo, 'app', { EVA_MANIFEST_DIR: bundle })
    assert.equal(manifest.readiness_probe.port, 2222, 'one fleet-wide manifest fix must take effect immediately')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed canonical manifest fails closed and never executes the per-repo fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eva-man-invalid-'))
  try {
    const repo = join(dir, 'repo')
    const bundle = join(dir, 'bundle')
    const qa = join(repo, 'qa')
    mkdirSync(qa, { recursive: true })
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(qa, 'user-journeys.json'), JSON.stringify({ app_id: 'app', readiness_probe: { port: 1111 } }))
    writeFileSync(join(bundle, 'app.json'), '{ malformed')
    assert.throws(
      () => loadManifest(repo, 'app', { EVA_MANIFEST_DIR: bundle }),
      /canonical EVA manifest is invalid/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing or empty portfolio registry fails closed instead of uploading a successful zero-app run', () => {
  assert.throws(() => loadRegistry({}), /EVA_REGISTRY_PATH is required/)
  const dir = mkdtempSync(join(tmpdir(), 'eva-reg-invalid-'))
  try {
    const missing = join(dir, 'missing.json')
    assert.throws(() => loadRegistry({ EVA_REGISTRY_PATH: missing }), /does not exist/)
    const empty = join(dir, 'empty.json')
    writeFileSync(empty, JSON.stringify({ apps: [] }))
    assert.throws(() => loadRegistry({ EVA_REGISTRY_PATH: empty }), /non-empty array/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TOTALITY: no committed local_path may name a machine-specific user directory', () => {
  const manifestDir = join(QA_DIR, 'manifests')
  const files = [join(QA_DIR, 'portfolio-registry.json'), join(QA_DIR, 'user-journeys.json'), ...readdirSync(manifestDir).filter((f) => f.endsWith('.json')).map((f) => join(manifestDir, f))]
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const paths = [...text.matchAll(/"local_path"\s*:\s*"([^"]*)"/g)].map((m) => m[1])
    for (const p of paths) {
      assert.ok(!/example_user/i.test(p), `${file}: local_path still carries the sanitizer placeholder: ${p}`)
      assert.ok(!/^[A-Za-z]:[\\/]Users[\\/]/i.test(p), `${file}: local_path names a machine-specific user dir (use ~/<repo-dir>): ${p}`)
    }
  }
})

test('launcher NAMES a nonexistent local_path instead of dying as spawn ENOENT', async () => {
  const manifest = {
    app_id: 'ghost',
    local_path: join(tmpdir(), 'eva-definitely-does-not-exist-' + Date.now()),
    start_command: 'npm start',
    readiness_probe: { type: 'http', port: 65533, timeout_ms: 1000 },
  }
  const logs = []
  const launch = await launchWebApp({ app: { app_id: 'ghost' }, manifest, log: (m) => logs.push(m) })
  assert.equal(launch.launched, true)
  assert.equal(launch.ready, false)
  assert.match(launch.outputTail(), /local_path does not exist/i)
  assert.match(launch.outputTail(), /ghost|eva-definitely-does-not-exist/i)
})
