import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import express from 'express'
import { authenticateWorker, createOwnerAiBroker } from '../../backend/services/ownerAi/ownerAiBroker.js'
import { runWithOwnerAiScope, getOwnerAiScope } from '../../backend/services/ownerAi/ownerAiScope.js'
import { attachRequestContext } from '../../backend/middleware/requestContext.js'
import { ownerAiWorkerRouter, ownerAiStatusRouter } from '../../backend/routes/ownerAi.js'
import { runChild, probeProvider } from '../../tools/owner-ai/officialCli.mjs'
import { bridgeConfig } from '../../tools/owner-ai/bridge.mjs'

test('dedicated worker credential only, strong minimum, and HTTPS origin only', () => {
  const env = { OWNER_AI_BRIDGE_TOKEN: 'a'.repeat(48) }
  assert.equal(authenticateWorker('Bearer ' + env.OWNER_AI_BRIDGE_TOKEN, env), true)
  for (const token of ['', 'Bearer admin', 'Basic ' + env.OWNER_AI_BRIDGE_TOKEN]) assert.equal(authenticateWorker(token, env), false)
  assert.equal(authenticateWorker('Bearer short', { OWNER_AI_BRIDGE_TOKEN: 'short' }), false)
  for (const url of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/?secret=x']) assert.throws(() => bridgeConfig({ ...env, GRANTFLOW_OWNER_AI_URL: url }))
  assert.equal(bridgeConfig({ ...env, GRANTFLOW_OWNER_AI_URL: 'https://example.test' }).url.hostname, 'example.test')
})

test('HTTP worker authentication, body bounds, no admin privileges and owner status', async () => {
  process.env.OWNER_AI_BRIDGE_TOKEN = 'a'.repeat(48)
  process.env.AGENT_CONTROL_ADMIN_EMAIL = 'owner@example.test'
  const app = express()
  app.use('/worker', ownerAiWorkerRouter)
  app.use((req, res, next) => { req.ctx = { identityResolved: true, isAdmin: true, userId: 'real', email: 'other@example.test' }; next() })
  app.use('/status', ownerAiStatusRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    assert.equal((await fetch(base + '/worker/poll', { method: 'POST' })).status, 401)
    const headers = { authorization: 'Bearer ' + process.env.OWNER_AI_BRIDGE_TOKEN, 'content-type': 'application/json' }
    assert.equal((await fetch(base + '/worker/poll', { method: 'POST', headers, body: '{}' })).status, 200)
    assert.equal((await fetch(base + '/worker/result', { method: 'POST', headers, body: '{"id":"stale"}' })).status, 409)
    assert.equal((await fetch(base + '/worker/poll', { method: 'POST', headers, body: JSON.stringify({ huge: 'x'.repeat(400000) }) })).status, 400)
    assert.equal((await fetch(base + '/status/status', { headers })).status, 403)
  } finally { await new Promise(resolve => server.close(resolve)); delete process.env.OWNER_AI_BRIDGE_TOKEN }
})

test('expired heartbeat refuses synchronously and cancellation reaches worker heartbeat', async () => {
  let time = 100
  const b = createOwnerAiBroker({ env: { OWNER_AI_BRIDGE_ENABLED: 'true', OWNER_AI_BRIDGE_TOKEN: 'x'.repeat(48) }, now: () => time })
  const heartbeat = { providers: { claude: 'ready' } }
  b.poll(heartbeat)
  process.env.AGENT_CONTROL_ADMIN_EMAIL = 'owner@example.test'
  const req = { ctx: { identityResolved: true, isAdmin: true, userId: 'real', email: 'owner@example.test' }, res: new EventEmitter() }
  await runWithOwnerAiScope(req, async () => {
    const input = { prompt: 'secret', format: 'text', maxTokens: 100, timeoutMs: 100 }
    time += 16000
    assert.equal(b.trySubscription(input), null)
    b.poll(heartbeat)
    const p = b.trySubscription(input)
    const { job } = b.poll(heartbeat)
    assert.equal(b.poll({ ...heartbeat, active: job }).active, true)
    req.res.emit('finish')
    assert.equal(await p, null)
    assert.equal(b.poll({ ...heartbeat, active: job }).active, false)
  })
})

function fakeSpawn(callback, calls) {
  return (exe, args, options) => {
    calls.push({ exe, args, options })
    const child = new EventEmitter()
    child.pid = 43210
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => child.emit('close', 1)
    queueMicrotask(() => callback(child))
    return child
  }
}
test('fake child receives injection text only through stdin and rejects quota exit', async () => {
  const calls = []
  const input = '$(whoami); & calc.exe --api-key secret'
  const spawnImpl = fakeSpawn(child => {
    assert.equal(child.stdin.read().toString(), input)
    child.stdout.write('quota exceeded')
    child.emit('close', 1)
  }, calls)
  assert.equal(await runChild('claude.exe', ['--print'], { input, env: {}, spawnImpl }), null)
  assert.equal(calls[0].options.shell, false)
  assert.deepEqual(calls[0].args, ['--print'])
})
test('fake child output bound and abort terminate exactly owned PID tree', async () => {
  for (const overflow of [true, false]) {
    const calls = []
    const controller = new AbortController()
    let child
    const spawnImpl = (exe, args, options) => {
      calls.push({ exe, args, options })
      if (exe.endsWith('taskkill.exe')) { queueMicrotask(() => child.emit('close', 1)); return new EventEmitter() }
      child = new EventEmitter(); child.pid = 43210
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      queueMicrotask(() => overflow ? child.stdout.write(Buffer.alloc(524289)) : controller.abort())
      return child
    }
    assert.equal(await runChild('claude.exe', [], { env: {}, signal: controller.signal, spawnImpl, platform: 'win32' }), null)
    assert.deepEqual(calls[1].args, ['/PID', '43210', '/T', '/F'])
    assert.equal(calls[1].options.shell, false)
  }
})
test('probe rejects absent safety capability and API/unknown auth at fake process boundary', async () => {
  const env = { LOCALAPPDATA: 'C:/Local' }
  const help = '--safe-mode --tools --strict-mcp-config --setting-sources --permission-prompts'
  assert.equal(await probeProvider('claude', { env, run: async () => 'old CLI' }), 'unavailable')
  for (const auth of [{ loggedIn: false }, { loggedIn: true, authMethod: 'api_key' }, { loggedIn: true, authMethod: 'claude.ai', subscriptionType: null, apiKeySource: 'managed' }]) {
    const run = async (exe, args) => args.includes('--help') ? help : JSON.stringify(auth)
    assert.equal(await probeProvider('claude', { env, run }), 'auth_required')
  }
})

test('real request context hydrates authority from DB before entering owner scope', async () => {
  process.env.AGENT_CONTROL_ADMIN_EMAIL = 'owner@example.test'
  for (const email of ['owner@example.test', 'other@example.test']) {
    const req = { user: { userId: 'real', email: 'owner@example.test', role: 'admin' }, res: new EventEmitter(),
      db: { dialect: 'sqlite', prepare(sql) {
        return { get: () => sql.includes('FROM users WHERE id') ? { is_admin: 1, primary_email: email } : null, all: () => [], run: () => ({ changes: 0 }) }
      } } }
    let called = false
    await attachRequestContext()(req, req.res, () => {
      called = true
      assert.equal(req.ctx.email, email)
      assert.equal(Boolean(getOwnerAiScope()), email === 'owner@example.test')
    })
    assert.equal(called, true)
    req.res.emit('finish')
  }
})

test('ended owner responses cannot start work after asynchronous identity resolution', async () => {
  process.env.AGENT_CONTROL_ADMIN_EMAIL = 'owner@example.test'
  for (const flag of ['destroyed', 'writableEnded']) {
    const res = new EventEmitter(); res[flag] = true
    const req = { ctx: { identityResolved: true, isAdmin: true, userId: 'real', email: 'owner@example.test' }, res }
    let called = false
    await runWithOwnerAiScope(req, () => { called = true })
    assert.equal(called, false)
  }
})
test('impossible one-token subscription requests never queue', async () => {
  process.env.AGENT_CONTROL_ADMIN_EMAIL = 'owner@example.test'
  const b = createOwnerAiBroker({ env: { OWNER_AI_BRIDGE_ENABLED: 'true', OWNER_AI_BRIDGE_TOKEN: 'x'.repeat(48) } })
  b.poll({ providers: { codex: 'ready' } })
  const req = { ctx: { identityResolved: true, isAdmin: true, userId: 'real', email: 'owner@example.test' }, res: new EventEmitter() }
  await runWithOwnerAiScope(req, () => assert.equal(b.trySubscription({ prompt: 'fixed', format: 'text', maxTokens: 1, timeoutMs: 5 }), null))
})
test('unsuccessful Windows tree kill falls back to terminating its owned child', async () => {
  const controller = new AbortController(); let killed = false; let child
  const spawnImpl = (exe) => {
    if (exe.endsWith('taskkill.exe')) { const killer = new EventEmitter(); queueMicrotask(() => killer.emit('close', 1)); return killer }
    child = new EventEmitter(); child.pid = 43210
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = () => { killed = true; child.emit('close', 1) }
    queueMicrotask(() => controller.abort())
    return child
  }
  const result = runChild('codex.exe', [], { env: {}, signal: controller.signal, spawnImpl, platform: 'win32' })
  await new Promise(resolve => setTimeout(resolve, 5))
  if (!killed) child.emit('close', 1)
  await result
  assert.equal(killed, true)
})

test('installer validates runtime before requesting or storing a secret', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../tools/owner-ai/manage.ps1', import.meta.url), 'utf8')
  const install = source.slice(source.indexOf("'Install' {"), source.indexOf("'Start' {"))
  assert.ok(install.indexOf('Get-Command node.exe') >= 0)
  assert.ok(install.indexOf('Get-Command node.exe') < install.indexOf('Read-Host'))
  assert.ok(install.indexOf('Test-Path -LiteralPath $bridgeScript') < install.indexOf('Read-Host'))
})
