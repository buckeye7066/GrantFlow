import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  checkPrerequisites,
  inferExecutableRequirements,
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

