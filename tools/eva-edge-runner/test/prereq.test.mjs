import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  checkPrerequisites,
  inferExecutableRequirements,
  recoverDockerDesktop,
  resolveLaunchEnv,
  satisfiesNodeEngine,
} from '../src/prereq.mjs'

test('runtime executables are inferred globally from start and journey commands', () => {
  const requirements = inferExecutableRequirements({
    start_command: 'cd backend && uvicorn app.main:app --port 8000 & cd frontend && pnpm dev',
    journeys: [{ command: 'python' }],
  })
  const commands = new Set(requirements.map((r) => r.command))
  assert.deepEqual(commands, new Set(['uvicorn', 'pnpm', 'python', 'node']))
})

test('a missing inferred executable is blocked before launch and names its remedy', async () => {
  const checked = []
  const result = await checkPrerequisites({
    manifest: { app_id: 'demo', start_command: 'pnpm dev' },
    resolvedEnv: { PATH: '/fixture' },
    probes: {
      executable: async (spec) => {
        checked.push(spec.command)
        return spec.command === 'pnpm' ? { ok: false, detail: 'ENOENT' } : { ok: true, detail: 'ok' }
      },
    },
  })
  assert.deepEqual(checked, ['pnpm', 'node'])
  assert.equal(result.unmet.length, 1)
  assert.equal(result.unmet[0].id, 'executable-pnpm')
  assert.match(result.unmet[0].remedy, /install pnpm/i)
})

test('an opted-in Docker prerequisite recovers once, then verifies the daemon', async () => {
  let probes = 0
  let recoveries = 0
  const result = await checkPrerequisites({
    manifest: {
      app_id: 'compose-app',
      start_command: 'docker compose up --build',
      prerequisites: [{ id: 'docker', type: 'docker', auto_recover: 'docker-desktop' }],
    },
    probes: {
      docker: async () => ({ ok: ++probes >= 2, detail: probes >= 2 ? 'docker 28' : 'daemon unavailable' }),
      dockerRecovery: async () => { recoveries += 1; return { ok: true, detail: 'started' } },
      executable: async () => ({ ok: true, detail: 'ok' }),
      nodeVersion: '24.19.0',
    },
  })
  assert.equal(recoveries, 1)
  assert.equal(probes, 2, 'a successful recovery is never trusted without a fresh daemon probe')
  assert.deepEqual(result.unmet, [])
})

test('Docker Desktop recovery inherits only the global safe environment', () => {
  let options
  const result = recoverDockerDesktop({
    platform: 'win32',
    env: {
      PATH: 'C:\\tools',
      SystemRoot: 'C:\\Windows',
      EVA_RUNNER_SECRET: 'do-not-inherit',
      DATABASE_URL: 'postgresql://secret',
    },
    run: (_command, _args, receivedOptions) => {
      options = receivedOptions
      return { status: 0, stdout: 'Docker Desktop ready' }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(options.env.PATH, 'C:\\tools')
  assert.equal(options.env.SystemRoot, 'C:\\Windows')
  assert.equal(options.env.EVA_RUNNER_SECRET, undefined)
  assert.equal(options.env.DATABASE_URL, undefined)
})

test('Node engine ranges are enforced against the exact workspace contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eva-node-engine-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ engines: { node: '>=24' } }))
    const manifest = { app_id: 'genemap', local_path: root, start_command: 'pnpm dev' }
    const executable = async () => ({ ok: true, detail: 'ok' })
    const old = await checkPrerequisites({ manifest, probes: { executable, nodeVersion: '20.19.0' } })
    assert.ok(old.unmet.some((u) => u.id === 'node-engine' && /Node 20[.]19[.]0/.test(u.detail)))
    const current = await checkPrerequisites({ manifest, probes: { executable, nodeVersion: '24.1.0' } })
    assert.deepEqual(current.unmet, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('common npm Node engine expressions are evaluated without a runtime dependency', () => {
  assert.equal(satisfiesNodeEngine('24.1.0', '>=24'), true)
  assert.equal(satisfiesNodeEngine('20.19.0', '^20.0.0 || >=22.12.0'), true)
  assert.equal(satisfiesNodeEngine('21.0.0', '^20.0.0 || >=22.12.0'), false)
  assert.equal(satisfiesNodeEngine('22.12.0', '^20.0.0 || >=22.12.0'), true)
})

test('resolved launch secrets are identified for payload-wide exact redaction', () => {
  const result = resolveLaunchEnv({
    app: { app_id: 'demo' },
    manifest: {
      app_id: 'demo',
      launch_env: { PORT: '4000', DATABASE_URL: 'postgresql://eva:secret@127.0.0.1/db' },
      launch_env_generated: { JWT_SECRET: 'secret' },
    },
    env: {},
    generate: () => 'generated-opaque-secret',
  })
  assert.ok(result.sensitiveValues.includes('postgresql://eva:secret@127.0.0.1/db'))
  assert.ok(result.sensitiveValues.includes('generated-opaque-secret'))
  assert.equal(result.sensitiveValues.includes('4000'), false)
})

