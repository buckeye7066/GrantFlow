import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { buildIsolatedTestEnv } from '../../scripts/test-environment.mjs'
import {
  buildStateSupplementalDirectories,
  STATE_DIRECTORIES,
} from '../../backend/services/crawlers/stateSupplementalDirectories.js'

test('hosted test runs cannot inherit production infrastructure, live providers, or agent schedules', () => {
  const isolated = buildIsolatedTestEnv({
    PATH: '/usr/bin',
    DATABASE_URL: 'postgres://production.invalid/grantflow',
    RAILWAY_PRIVATE_DOMAIN: 'railway.internal',
    VERCEL_ENV: 'preview',
    OPPORTUNITY_INSERT_VERIFY_URL: 'true',
    LINK_VERIFICATION_ENABLED: 'true',
    URL_VERIFICATION_ENABLED: 'true',
    TWILIO_AUTH_TOKEN: 'not-a-real-token',
    AMY_DAILY_TARGET: '50',
    AMY_ENABLED: 'true',
    YANA_ENABLED: 'true',
    LARRY_RUN_ON_SCHEDULE: 'true',
    HAMILTON_WEEKLY_DIGEST_DELIVERY: 'send',
    MICROSOFT_TENANT_ID: 'tenant',
    MICROSOFT_CLIENT_ID: 'client',
    MICROSOFT_CLIENT_SECRET: 'secret',
    JOHN_PRIMARY_MAILBOX: 'owner@example.invalid',
  })

  assert.equal(isolated.PATH, '/usr/bin')
  assert.equal(isolated.NODE_ENV, 'test')
  assert.equal(isolated.GRANTFLOW_TEST_RUNNER, '1')
  assert.equal(isolated.DISABLE_BACKGROUND_SERVICES, 'true')

  for (const key of [
    'DATABASE_URL',
    'RAILWAY_PRIVATE_DOMAIN',
    'VERCEL_ENV',
    'OPPORTUNITY_INSERT_VERIFY_URL',
    'LINK_VERIFICATION_ENABLED',
    'URL_VERIFICATION_ENABLED',
    'TWILIO_AUTH_TOKEN',
    'AMY_DAILY_TARGET',
    'AMY_ENABLED',
    'YANA_ENABLED',
    'LARRY_RUN_ON_SCHEDULE',
    'HAMILTON_WEEKLY_DIGEST_DELIVERY',
    'MICROSOFT_TENANT_ID',
    'MICROSOFT_CLIENT_ID',
    'MICROSOFT_CLIENT_SECRET',
    'JOHN_PRIMARY_MAILBOX',
  ]) {
    assert.equal(isolated[key], undefined, `${key} leaked into the isolated test environment`)
  }
})

test('all Vitest package entry points use the hosted-environment isolation wrapper', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))

  assert.match(pkg.scripts.unit, /run-unit-tests\.mjs/)
  assert.match(pkg.scripts.unit, /run-vitest-isolated\.mjs run/)
  assert.doesNotMatch(pkg.scripts.unit, /npm exec -- vitest/)
  assert.match(pkg.scripts['test:endpoints'], /run-vitest-isolated\.mjs run/)
})

test('Ohio offline supplement is one canonical official state directory, not a per-ZIP clone', () => {
  const firstZip = buildStateSupplementalDirectories({ state: 'oh', zip: '44089' })
  const secondZip = buildStateSupplementalDirectories({ state: 'OH', zip: '44101' })

  assert.equal(firstZip.length, 1)
  assert.equal(secondZip.length, 1)
  assert.equal(firstZip[0].source, 'state_supplemental_grants')
  assert.equal(firstZip[0].source_id, 'OH-education-workforce-grants')
  assert.equal(secondZip[0].source_id, firstZip[0].source_id)
  assert.equal(firstZip[0].state, 'OH')
  assert.match(firstZip[0].source_url, /^https:\/\/education\.ohio\.gov\//)
  assert.doesNotMatch(firstZip[0].source_id, /44089|44101/)
  assert.equal(STATE_DIRECTORIES.OH.length, 1)
})

test('unsupported states do not receive invented supplemental rows', () => {
  assert.deepEqual(buildStateSupplementalDirectories({ state: 'ZZ', zip: '00000' }), [])
  assert.deepEqual(buildStateSupplementalDirectories({ state: '', zip: '44089' }), [])
})
