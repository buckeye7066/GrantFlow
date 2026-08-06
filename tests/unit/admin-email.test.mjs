import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import { isAdminEmail, ADMIN_EMAILS } from '../../backend/config/constants.js'

function runIsolated(source, overrides = {}) {
  const env = { ...process.env, ...overrides }
  for (const key of ['ADMIN_EMAIL', 'ADMIN_EMAILS', 'AGENT_CONTROL_ADMIN_EMAIL', 'HAMILTON_ADMIN_EMAIL', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_DEPLOYMENT_ID']) {
    if (overrides[key] === undefined) delete env[key]
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
}

test('isAdminEmail: local default is explicitly non-production', () => {
  assert.ok(ADMIN_EMAILS.includes('admin@grantflow.local'))
  assert.equal(isAdminEmail('admin@grantflow.local'), true)
  assert.equal(isAdminEmail('  ADMIN@grantflow.local  '), true)
})

test('deployed constants fail closed when ADMIN_EMAIL is absent', () => {
  const value = runIsolated(
    `const m = await import('./backend/config/constants.js'); console.log(JSON.stringify({ email: m.ADMIN_EMAIL, emails: m.ADMIN_EMAILS, attacker: m.isAdminEmail('attacker@example.com') }))`,
    { NODE_ENV: 'production' },
  )
  assert.deepEqual(value, { email: '', emails: [], attacker: false })
})

test('deployed constants honor only explicitly configured admin addresses', () => {
  const value = runIsolated(
    `const m = await import('./backend/config/constants.js'); console.log(JSON.stringify({ email: m.ADMIN_EMAIL, emails: m.ADMIN_EMAILS, primary: m.isAdminEmail('OPS@axiombiolabs.org'), secondary: m.isAdminEmail('SECOND@axiombiolabs.org'), other: m.isAdminEmail('other@example.com') }))`,
    {
      NODE_ENV: 'production',
      ADMIN_EMAIL: 'ops@axiombiolabs.org',
      ADMIN_EMAILS: 'second@axiombiolabs.org',
    },
  )
  assert.deepEqual(value, {
    email: 'ops@axiombiolabs.org',
    emails: ['ops@axiombiolabs.org', 'second@axiombiolabs.org'],
    primary: true,
    secondary: true,
    other: false,
  })
})

test('production environment validation requires a configured admin email', () => {
  const common = {
    NODE_ENV: 'production',
    AUTH_JWT_SECRET: 'a'.repeat(64),
    PORT: '8080',
  }
  const missing = runIsolated(
    `const { loadEnv } = await import('./backend/config/env.js'); const r = loadEnv({ mode: 'production' }); console.log(JSON.stringify({ ok: r.ok, issues: r.issues }))`,
    common,
  )
  assert.equal(missing.ok, false)
  assert.match(missing.issues.join(' '), /ADMIN_EMAIL/)

  const configured = runIsolated(
    `const { loadEnv } = await import('./backend/config/env.js'); const r = loadEnv({ mode: 'production' }); console.log(JSON.stringify({ ok: r.ok, admin: r.env?.ADMIN_EMAIL }))`,
    { ...common, ADMIN_EMAIL: 'ops@axiombiolabs.org' },
  )
  assert.deepEqual(configured, { ok: true, admin: 'ops@axiombiolabs.org' })
})

test('mixed-case padded production mode cannot bypass deployed validation', () => {
  const result = runIsolated(
    `const { loadEnv } = await import('./backend/config/env.js'); const r = loadEnv({ mode: ' Production ' }); console.log(JSON.stringify({ ok: r.ok, issues: r.issues }))`,
    {
      NODE_ENV: ' Production ',
      AUTH_JWT_SECRET: 'a'.repeat(64),
      PORT: '8080',
    },
  )
  assert.equal(result.ok, false)
  assert.match(result.issues.join(' '), /ADMIN_EMAIL/)
})

test('deployed privileged email settings reject source-safe fixture domains', () => {
  const common = {
    NODE_ENV: 'production',
    AUTH_JWT_SECRET: 'a'.repeat(64),
    PORT: '8080',
    ADMIN_EMAIL: 'ops@axiombiolabs.org',
  }
  for (const [name, value] of [
    ['ADMIN_EMAIL', 'admin@grantflow.local'],
    ['ADMIN_EMAILS', 'secondary@example.com'],
    ['AGENT_CONTROL_ADMIN_EMAIL', 'operator@example.test'],
    ['HAMILTON_ADMIN_EMAIL', 'hamilton@example.invalid'],
  ]) {
    const result = runIsolated(
      `const { loadEnv } = await import('./backend/config/env.js'); const r = loadEnv({ mode: 'production' }); console.log(JSON.stringify({ ok: r.ok, issues: r.issues }))`,
      { ...common, [name]: value },
    )
    assert.equal(result.ok, false, name)
    assert.match(result.issues.join(' '), new RegExp(name), name)
  }
})
