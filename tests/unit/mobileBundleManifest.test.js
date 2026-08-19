// Runs the REAL scripts/build-mobile-bundle.mjs against a temporary project
// tree and verifies the published feed. The property under test is the one the
// device depends on: latest.json.sha256 must be the SHA-256 of the zip bytes
// exactly as served, because @capgo/capacitor-updater re-hashes the downloaded
// zip and refuses to install on a mismatch.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { requiresNativeUpdate } from '../../src/lib/mobileUpdater.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const script = path.join(repoRoot, 'scripts', 'build-mobile-bundle.mjs')
const require = createRequire(import.meta.url)

/** @type {string[]} */
const tempRoots = []

function makeProject({ version = '2.3.4', mobile } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-mobile-bundle-'))
  tempRoots.push(root)
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version, ...(mobile ? { mobile } : {}) }, null, 2),
  )
  const dist = path.join(root, 'dist')
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>fixture</title>')
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log("fixture")')
  return root
}

function runBuild(root, env = {}) {
  execFileSync(process.execPath, [script, root], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  })
  return JSON.parse(fs.readFileSync(path.join(root, 'dist', 'mobile', 'latest.json'), 'utf8'))
}

afterEach(() => {
  while (tempRoots.length) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true })
  }
})

describe('build-mobile-bundle manifest', () => {
  it('publishes a sha256 that is the real digest of the served zip bytes', () => {
    const root = makeProject({ version: '2.3.4' })
    const manifest = runBuild(root, { MOBILE_UPDATE_BASE_URL: 'https://axiombiolabs.org' })

    const zipPath = path.join(root, 'dist', 'mobile', 'bundle-2.3.4.zip')
    const expected = createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')

    expect(manifest.version).toBe('2.3.4')
    expect(manifest.url).toBe('https://axiombiolabs.org/mobile/bundle-2.3.4.zip')
    expect(manifest.sha256).toBe(expected)
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  // A digest that does not track the bytes is worse than none: it would make
  // every install fail closed at the device. Prove the two move together.
  it('produces a DIFFERENT sha256 when the bundle contents change', () => {
    const a = makeProject({ version: '2.3.4' })
    const first = runBuild(a)

    fs.writeFileSync(path.join(a, 'dist', 'assets', 'app.js'), 'console.log("changed")')
    const second = runBuild(a)

    expect(second.sha256).not.toBe(first.sha256)
    const zipPath = path.join(a, 'dist', 'mobile', 'bundle-2.3.4.zip')
    expect(second.sha256).toBe(createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex'))
  })

  it('publishes minNativeVersion from package.json and lets the env override it', () => {
    const root = makeProject({ version: '2.3.4', mobile: { minNativeVersion: '1.1' } })
    expect(runBuild(root).minNativeVersion).toBe('1.1')
    expect(runBuild(root, { MOBILE_MIN_NATIVE_VERSION: '9.9' }).minNativeVersion).toBe('9.9')
  })

  it('omits minNativeVersion entirely when none is declared', () => {
    const root = makeProject({ version: '2.3.4' })
    expect(runBuild(root, { MOBILE_MIN_NATIVE_VERSION: '' })).not.toHaveProperty('minNativeVersion')
  })

  // REGRESSION GUARD for a trap that nearly shipped: the declared native floor
  // must be written on the version line the SHIPPED app actually carries.
  // .github/workflows/android-build.yml sets ANDROID_VERSION_NAME=1.0.<run>, so
  // a floor of "1.1" compares GREATER than "1.0.47" and would tell every real
  // device "a new app version is required" — killing OTA outright.
  it('declares a native floor that does not block a CI-built app version', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'android-build.yml'),
      'utf8',
    )
    const match = workflow.match(/ANDROID_VERSION_NAME:\s*(\S+?)\$\{\{\s*github\.run_number/)
    expect(match, 'android-build.yml must set ANDROID_VERSION_NAME from run_number').toBeTruthy()
    const shippedPrefix = match[1] // e.g. "1.0."

    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    const floor = pkg.mobile?.minNativeVersion || ''
    if (!floor) return // no floor declared — nothing can be blocked

    // A representative range of real CI-shipped versions must all clear it.
    for (const run of [1, 47, 500, 9999]) {
      const shipped = `${shippedPrefix}${run}`
      expect(
        requiresNativeUpdate({ minNativeVersion: floor }, shipped),
        `minNativeVersion "${floor}" must not block CI-shipped app version "${shipped}" — ` +
          `write the floor on the ${shippedPrefix}<run> line instead`,
      ).toBe(false)
    }
  })

  it('never nests the feed directory inside its own bundle', () => {
    const root = makeProject({ version: '2.3.4' })
    runBuild(root)
    runBuild(root) // second pass: dist/mobile now exists from the first
    const zipPath = path.join(root, 'dist', 'mobile', 'bundle-2.3.4.zip')
    const AdmZip = require('adm-zip')
    const names = new AdmZip(zipPath).getEntries().map((e) => e.entryName)
    expect(names.some((n) => n.startsWith('mobile/'))).toBe(false)
    expect(names).toContain('index.html')
  })
})
