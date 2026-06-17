/**
 * migrate-on-boot-default.test.mjs
 *
 * Regression for: Agent Control Center reporting
 *   "Agent robert failed: relation \"robert_runs\" does not exist"
 * because the operator hadn't set MIGRATE_ON_BOOT=1 in production. Several
 * agent-telemetry migrations (sam_runs / robert_* / john_* / hamilton_* /
 * agent_activity_events / agent_daily_rollups / agent_control_*) ship in the
 * repo but were never applied because the boot hook was opt-in.
 *
 * Mission rule: zero results / "feature dead because of unprovisioned table"
 * is a failure state, not an acceptable outcome.
 *
 * Boot policy:
 *   - DEFAULT: ON. Pending migrations apply on every backend boot.
 *   - Opt out by setting MIGRATE_ON_BOOT to 0 / false / no / off
 *     (case-insensitive). Anything else (including unset) is ON.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// Re-implements the policy in backend/server.js so we can unit-test it
// without booting the full server. Keep this in sync with server.js.
function shouldMigrateOnBoot(envValue, { smokeMode = false } = {}) {
  const raw = String(envValue ?? '').trim()
  const explicitlyOptedOut = /^(0|false|no|off)$/i.test(raw)
  const explicitlyOptedIn = /^(1|true|yes|on)$/i.test(raw)
  return explicitlyOptedIn || (!explicitlyOptedOut && !smokeMode)
}

test('boot migration default is ON for production (env unset, not smoke)', () => {
  assert.equal(shouldMigrateOnBoot(undefined), true)
  assert.equal(shouldMigrateOnBoot(null), true)
  assert.equal(shouldMigrateOnBoot(''), true)
  assert.equal(shouldMigrateOnBoot('   '), true)
})

test('boot migration honors explicit opt-in values', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(shouldMigrateOnBoot(value), true, `${value} should opt in`)
    // Even in smoke mode, an explicit opt-in wins.
    assert.equal(
      shouldMigrateOnBoot(value, { smokeMode: true }),
      true,
      `${value} should opt in even in smoke mode`,
    )
  }
})

test('boot migration honors explicit opt-out values (case-insensitive)', () => {
  for (const value of ['0', 'false', 'False', 'FALSE', 'no', 'NO', 'off', 'OFF']) {
    assert.equal(
      shouldMigrateOnBoot(value),
      false,
      `${JSON.stringify(value)} should opt out`,
    )
  }
})

test('smoke mode opts out by default (preserves test fixture isolation)', () => {
  assert.equal(shouldMigrateOnBoot(undefined, { smokeMode: true }), false)
  assert.equal(shouldMigrateOnBoot('', { smokeMode: true }), false)
})

test('unrecognized values default to ON (fail-open, not fail-closed)', () => {
  // The whole point of changing the default is that operators no longer have
  // to know to flip a flag. Garbage in env still gets migrations.
  assert.equal(shouldMigrateOnBoot('maybe'), true)
  assert.equal(shouldMigrateOnBoot('1.0'), true)
  assert.equal(shouldMigrateOnBoot('enabled'), true)
})
