import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { repairFailingTests } from '../../backend/services/anyaTestRepair.js'

function runNode(args, { env } = {}) {
  const child = spawn(process.execPath, args, {
    cwd: path.resolve('.'),
    env: { ...process.env, ...(env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))

  return new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

test('security: diagnose-anya requires explicit admin token', async () => {
  const res = await runNode(['scripts/diagnose-anya.mjs'], {
    env: {
      ADMIN_TOKEN: '',
      ANYA_ADMIN_TOKEN: '',
    },
  })
  assert.notEqual(res.code, 0)
  assert.match(res.stderr + res.stdout, /Missing admin token/i)
})

test('security: auto-route generation is blocked in production', async () => {
  const prevNodeEnv = process.env.NODE_ENV
  const prevDeployEnv = process.env.DEPLOY_ENV
  const prevAllowRoute = process.env.ALLOW_AUTO_ROUTE_GENERATION
  process.env.NODE_ENV = 'production'
  process.env.DEPLOY_ENV = 'production'
  process.env.ALLOW_AUTO_ROUTE_GENERATION = 'true'

  try {
    const report = await repairFailingTests(
      [
        {
          test_name: 'prod route gen should not run',
          error: '404 not found',
          path: 'GET /api/profiles/auto_route_generated',
          method: 'GET',
        },
      ],
      { db: null, user: { role: 'admin', id: 'admin-test' } },
    )

    assert.equal(report.repaired.length, 0)
    assert.ok(report.unable_to_repair.length >= 1)
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
    if (prevDeployEnv === undefined) delete process.env.DEPLOY_ENV
    else process.env.DEPLOY_ENV = prevDeployEnv
    if (prevAllowRoute === undefined) delete process.env.ALLOW_AUTO_ROUTE_GENERATION
    else process.env.ALLOW_AUTO_ROUTE_GENERATION = prevAllowRoute
  }
})

test('quality gate: fails on empty catch / task markers', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-quality-gate-'))
  const bad = path.join(tmp, 'bad.js')
  writeFileSync(
    bad,
    `
async function demo() {
  try {
    await Promise.resolve()
  } catch (error) {}
  // TODO: fix this
  return Promise.resolve().then(() => 1)
}
`,
    'utf8',
  )

  const res = await runNode(['scripts/code-quality-gate.mjs', '--path', tmp, '--report'], {
    env: { NODE_ENV: 'test' },
  })
  assert.notEqual(res.code, 0)
  assert.match(res.stdout + res.stderr, /\[empty_catch\]|\[task_marker\]|\[unhandled_then\]/)
})
