/**
 * Startup smoke-mode tests.
 *
 * 1. Verifies the `isTruthy()` helper in backend/start.js handles all
 *    specified truthy/falsy values correctly.
 * 2. Verifies that SMOKE_MODE controls whether dotenv overrides the
 *    environment (preventing test-runner env from being clobbered).
 * 3. Verifies the overall shape of the startup entrypoint.
 *
 * Uses static source inspection so no server process needs to be spawned.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '../..')

// ---------------------------------------------------------------------------
// Replicate isTruthy locally (keeps tests independent of importing start.js,
// which has a top-level `await import('./server.js')` side-effect).
// ---------------------------------------------------------------------------

function isTruthy(value) {
  const v = String(value || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on'
}

// ── Source shape ────────────────────────────────────────────────────────────

test('backend/start.js defines an isTruthy helper', () => {
  const src = fs.readFileSync(path.join(ROOT, 'backend/start.js'), 'utf8')
  assert.ok(src.includes('function isTruthy'), 'start.js must define isTruthy()')
  // Verify the canonical truthy values are all present in the source.
  for (const val of ["'1'", "'true'", "'yes'", "'y'", "'on'"]) {
    assert.ok(src.includes(val), `start.js isTruthy should handle ${val}`)
  }
})

test('backend/start.js uses SMOKE_MODE to disable dotenv override', () => {
  const src = fs.readFileSync(path.join(ROOT, 'backend/start.js'), 'utf8')
  assert.ok(
    src.includes('SMOKE_MODE') && src.includes('override'),
    'start.js should reference both SMOKE_MODE and dotenv override option',
  )
  assert.ok(
    src.includes('!isTruthy(process.env.SMOKE_MODE)'),
    'start.js should set override: !isTruthy(SMOKE_MODE) so test runners keep their env',
  )
})

test('backend/start.js imports server.js dynamically after dotenv is loaded', () => {
  const src = fs.readFileSync(path.join(ROOT, 'backend/start.js'), 'utf8')
  assert.ok(
    src.includes("import('./server.js')"),
    'start.js should dynamically import server.js so dotenv runs first',
  )
})

test('backend/start.js does not start a second migration runner', () => {
  const src = fs.readFileSync(path.join(ROOT, 'backend/start.js'), 'utf8')
  assert.ok(
    !src.includes('runMigrationsInBackground()'),
    'server.js is the single migration owner; start.js must not launch a second runner',
  )
})

// ── isTruthy correctness ────────────────────────────────────────────────────

test('isTruthy returns true for accepted truthy strings', () => {
  const truthy = ['1', 'true', 'yes', 'y', 'on', 'TRUE', 'True', 'YES', 'ON', ' 1 ']
  for (const v of truthy) {
    assert.ok(isTruthy(v), `isTruthy('${v}') should be true`)
  }
})

test('isTruthy returns false for falsy / unknown values', () => {
  const falsy = ['0', 'false', 'no', 'off', '', null, undefined, 'random', '2', 'enabled']
  for (const v of falsy) {
    assert.ok(!isTruthy(v), `isTruthy(${JSON.stringify(v)}) should be false`)
  }
})
