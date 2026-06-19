/**
 * migrate-on-boot-default.test.mjs
 *
 * Locks down the boot policy implemented in
 * backend/startup/bootPolicy.js. This test used to re-implement the
 * policy inline (with a "keep this in sync with server.js" comment
 * that historically drifted). Now it imports the canonical module so
 * a future drift is impossible.
 *
 * Regressions guarded:
 *   - Agent Control Center reporting "relation 'robert_runs' does
 *     not exist" because MIGRATE_ON_BOOT was opt-in.
 *   - Smoke tests writing migrations into the dev DB because
 *     SMOKE_MODE detection was per-call-site.
 *   - PORT=0 inferred smoke mode dropping background services
 *     unintentionally on Replit-style ephemeral boots.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseBoolFlag,
  isExplicitOptIn,
  isExplicitOptOut,
  isSmokeMode,
  shouldMigrateOnBoot,
  shouldAutoApplySchema,
  disableBackgroundServices,
  buildBootPolicy,
} from '../../backend/startup/bootPolicy.js'

// ----- parseBoolFlag --------------------------------------------------------

test('parseBoolFlag recognises the canonical truthy tokens (case-insensitive)', () => {
  for (const v of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON']) {
    assert.equal(parseBoolFlag(v, false), true, `${JSON.stringify(v)} should be truthy`)
  }
})

test('parseBoolFlag recognises the canonical falsy tokens (case-insensitive)', () => {
  for (const v of ['0', 'false', 'False', 'FALSE', 'no', 'NO', 'off', 'OFF']) {
    assert.equal(parseBoolFlag(v, true), false, `${JSON.stringify(v)} should be falsy`)
  }
})

test('parseBoolFlag returns the default for unset / blank / unknown values', () => {
  for (const v of [undefined, null, '', '   ', 'maybe', '1.0']) {
    assert.equal(parseBoolFlag(v, true), true, `${JSON.stringify(v)} → default true`)
    assert.equal(parseBoolFlag(v, false), false, `${JSON.stringify(v)} → default false`)
  }
})

test('isExplicitOptIn / isExplicitOptOut detect only the canonical tokens', () => {
  assert.equal(isExplicitOptIn('1'), true)
  assert.equal(isExplicitOptIn('true'), true)
  assert.equal(isExplicitOptIn('maybe'), false)
  assert.equal(isExplicitOptIn(undefined), false)

  assert.equal(isExplicitOptOut('0'), true)
  assert.equal(isExplicitOptOut('false'), true)
  assert.equal(isExplicitOptOut('maybe'), false)
})

// ----- shouldMigrateOnBoot --------------------------------------------------

test('boot migration default is ON for production (env unset, not smoke)', () => {
  const env = { NODE_ENV: 'production' }
  assert.equal(shouldMigrateOnBoot(env), true)
})

test('boot migration default is ON for empty / blank values', () => {
  for (const value of [undefined, null, '', '   ']) {
    const env = { MIGRATE_ON_BOOT: value, NODE_ENV: 'production' }
    assert.equal(shouldMigrateOnBoot(env), true)
  }
})

test('boot migration honors explicit opt-in even in smoke mode', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
    const env = { MIGRATE_ON_BOOT: value, SMOKE_MODE: 'true' }
    assert.equal(shouldMigrateOnBoot(env), true,
      `${value} should opt in even in smoke mode`)
  }
})

test('boot migration honors explicit opt-out values (case-insensitive)', () => {
  for (const value of ['0', 'false', 'False', 'FALSE', 'no', 'NO', 'off', 'OFF']) {
    const env = { MIGRATE_ON_BOOT: value }
    assert.equal(shouldMigrateOnBoot(env), false, `${JSON.stringify(value)} should opt out`)
  }
})

test('smoke mode opts out by default (preserves test fixture isolation)', () => {
  assert.equal(shouldMigrateOnBoot({ SMOKE_MODE: 'true' }), false)
  assert.equal(shouldMigrateOnBoot({ SMOKE_MODE: '1' }), false)
})

test('unrecognized MIGRATE_ON_BOOT values fail-open to ON (operator-friendly default)', () => {
  for (const value of ['maybe', '1.0', 'enabled', 'YES_PLEASE']) {
    const env = { MIGRATE_ON_BOOT: value }
    // Tokens that don't match opt-in OR opt-out fall through to the
    // smoke-mode-aware default. Without smoke mode, that is ON.
    assert.equal(shouldMigrateOnBoot(env), true,
      `unknown ${JSON.stringify(value)} should default ON`)
  }
})

// ----- isSmokeMode ----------------------------------------------------------

test('isSmokeMode honors explicit SMOKE_MODE=1', () => {
  assert.equal(isSmokeMode({ SMOKE_MODE: '1' }), true)
  assert.equal(isSmokeMode({ SMOKE_MODE: 'true' }), true)
  assert.equal(isSmokeMode({ SMOKE_MODE: 'yes' }), true)
})

test('isSmokeMode infers smoke from PORT=0 + DB_AUTO_MIGRATE=true + non-prod', () => {
  // The exact pattern many unit tests use: PORT=0 (kernel-allocated)
  // + DB_AUTO_MIGRATE=true (fast schema) + NODE_ENV not 'production'.
  assert.equal(
    isSmokeMode({ DB_AUTO_MIGRATE: 'true', NODE_ENV: 'test' }, 0),
    true,
  )
  assert.equal(
    isSmokeMode({ DB_AUTO_MIGRATE: 'true' }, '0'),
    true,
  )
})

test('isSmokeMode does NOT infer smoke in production (extra safety)', () => {
  // Even with PORT=0 + DB_AUTO_MIGRATE=true, production must never
  // be silently misclassified as smoke.
  assert.equal(
    isSmokeMode({ DB_AUTO_MIGRATE: 'true', NODE_ENV: 'production' }, 0),
    false,
  )
})

test('isSmokeMode is false when PORT is non-zero (Replit-style ephemeral boots)', () => {
  // PORT=8080 is the canonical real boot. We must NOT collapse to
  // smoke just because DB_AUTO_MIGRATE happens to be set.
  assert.equal(
    isSmokeMode({ DB_AUTO_MIGRATE: 'true', NODE_ENV: 'test' }, 8080),
    false,
  )
})

// ----- shouldAutoApplySchema -----------------------------------------------

test('shouldAutoApplySchema is ON for sqlite + non-production by default', () => {
  assert.equal(shouldAutoApplySchema({ NODE_ENV: 'development' }, 'sqlite'), true)
  assert.equal(shouldAutoApplySchema({ NODE_ENV: 'test' }, 'sqlite'), true)
  assert.equal(shouldAutoApplySchema({}, 'sqlite'), true)
})

test('shouldAutoApplySchema is OFF for sqlite + production by default', () => {
  assert.equal(shouldAutoApplySchema({ NODE_ENV: 'production' }, 'sqlite'), false)
})

test('shouldAutoApplySchema is OFF for postgres unless DB_AUTO_MIGRATE explicitly true', () => {
  assert.equal(shouldAutoApplySchema({}, 'postgres'), false)
  assert.equal(shouldAutoApplySchema({ DB_AUTO_MIGRATE: 'true' }, 'postgres'), true)
})

test('shouldAutoApplySchema honors explicit DB_AUTO_MIGRATE=true on production', () => {
  assert.equal(
    shouldAutoApplySchema({ DB_AUTO_MIGRATE: 'true', NODE_ENV: 'production' }, 'postgres'),
    true,
  )
})

// ----- disableBackgroundServices -------------------------------------------

test('disableBackgroundServices is true in smoke mode regardless of DISABLE_BACKGROUND_SERVICES', () => {
  assert.equal(disableBackgroundServices({ SMOKE_MODE: 'true' }), true)
  assert.equal(
    disableBackgroundServices({ SMOKE_MODE: 'true', DISABLE_BACKGROUND_SERVICES: 'false' }),
    true,
  )
})

test('disableBackgroundServices honors explicit DISABLE_BACKGROUND_SERVICES=true in non-smoke', () => {
  assert.equal(
    disableBackgroundServices({ DISABLE_BACKGROUND_SERVICES: 'true', NODE_ENV: 'production' }),
    true,
  )
})

test('disableBackgroundServices is false by default in production', () => {
  assert.equal(disableBackgroundServices({ NODE_ENV: 'production' }), false)
})

// ----- buildBootPolicy snapshot --------------------------------------------

test('buildBootPolicy returns an immutable snapshot capturing every decision', () => {
  const policy = buildBootPolicy(
    { MIGRATE_ON_BOOT: '1', SMOKE_MODE: 'true', DB_AUTO_MIGRATE: 'true', NODE_ENV: 'test' },
    { port: 0, dialect: 'sqlite' },
  )
  assert.equal(policy.smoke_mode, true)
  // explicit MIGRATE_ON_BOOT=1 wins over smoke mode
  assert.equal(policy.migrate_on_boot, true)
  assert.equal(policy.auto_apply_schema, true)
  // smoke mode disables background services
  assert.equal(policy.background_services_disabled, true)
  // Object is frozen so callers can't mutate the recorded decision.
  assert.throws(() => { policy.smoke_mode = false }, TypeError)
  // Raw env capture present for log lines / debug.
  assert.equal(policy.raw.SMOKE_MODE, 'true')
  assert.equal(policy.raw.MIGRATE_ON_BOOT, '1')
  assert.equal(policy.raw.dialect, 'sqlite')
})

test('buildBootPolicy: production-default boot with no env vars set', () => {
  const policy = buildBootPolicy({ NODE_ENV: 'production' }, { port: 8080, dialect: 'postgres' })
  // No MIGRATE_ON_BOOT, no SMOKE_MODE → migrate ON (the fix from the
  // 'robert_runs does not exist' regression).
  assert.equal(policy.smoke_mode, false)
  assert.equal(policy.migrate_on_boot, true)
  // Postgres + no DB_AUTO_MIGRATE → no schema.sql apply on boot.
  assert.equal(policy.auto_apply_schema, false)
  assert.equal(policy.background_services_disabled, false)
})
