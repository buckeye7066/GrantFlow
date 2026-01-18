import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import { promises as fsp } from 'node:fs'
import { spawn } from 'node:child_process'

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function isPortAvailable(port, host = '127.0.0.1') {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

async function pickPort({ start = 18150, count = 30 } = {}) {
  for (let i = 0; i < count; i += 1) {
    const port = start + i
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) return port
  }
  throw new Error('No available port found for Anya tests')
}

async function waitForHttpOk(url, { timeoutMs = 45_000 } = {}) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeoutMs) return false
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) return true
    } catch {}
    // eslint-disable-next-line no-await-in-loop
    await sleep(250)
  }
}

async function startBackend({ rootDir, port, sqlitePath }) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    SMOKE_MODE: 'true',
    PORT: String(port),
    DB_AUTO_MIGRATE: 'true',
    SQLITE_DB_PATH: sqlitePath,
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'dev-admin-token',
    CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173',
    AUTH_FRONTEND_APP_BASE: process.env.VITE_APP_BASE || '/grantflow',
    // Avoid any surprise background work during unit tests.
    ANYA_AUTONOMOUS_ENABLED: 'false',
    NATIONAL_PROGRAMS_CRAWLER_ENABLED: 'false',
  }

  const proc = spawn(process.execPath, ['backend/server.js'], {
    cwd: rootDir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  proc.stdout?.on('data', () => {})
  proc.stderr?.on('data', () => {})

  const ok = await waitForHttpOk(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 45_000 })
  if (!ok) {
    try {
      proc.kill('SIGTERM')
    } catch {}
    throw new Error('Backend did not become healthy for Anya tests')
  }

  return proc
}

async function waitForExit(proc, { timeoutMs = 10_000 } = {}) {
  if (!proc || proc.killed) return
  await new Promise((resolve) => {
    const done = () => resolve()
    const timer = setTimeout(done, timeoutMs)
    proc.once('exit', () => {
      clearTimeout(timer)
      done()
    })
    proc.once('error', () => {
      clearTimeout(timer)
      done()
    })
  })
}

async function safeRm(dir, { retries = 8 } = {}) {
  for (let i = 0; i < retries; i += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      const code = error?.code
      if (code === 'EBUSY' || code === 'EPERM') {
        // eslint-disable-next-line no-await-in-loop
        await sleep(150 * (i + 1))
        continue
      }
      throw error
    }
  }
  // last attempt
  await fsp.rm(dir, { recursive: true, force: true })
}

test('Anya sessions + tasks: create and update task', async () => {
  const rootDir = process.cwd()
  const port = await pickPort()
  const tempDir = await fsp.mkdtemp(join(os.tmpdir(), 'grantflow-anya-'))
  const sqlitePath = join(tempDir, 'grantflow-test.db')

  const proc = await startBackend({ rootDir, port, sqlitePath })
  try {
    const headers = {
      'content-type': 'application/json',
      'x-admin-token': 'dev-admin-token',
    }

    const createSessionRes = await fetch(`http://127.0.0.1:${port}/api/anya/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Test session' }),
    })
    assert.equal(createSessionRes.ok, true)
    const session = await createSessionRes.json()
    assert.ok(session?.id, 'expected created session id')

    const createTaskRes = await fetch(`http://127.0.0.1:${port}/api/anya/sessions/${session.id}/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Test task', status: 'open' }),
    })
    assert.equal(createTaskRes.ok, true)
    const createTaskBody = await createTaskRes.json()
    assert.ok(createTaskBody?.task?.id, 'expected created task id')
    assert.equal(createTaskBody.task.status, 'open')

    const updateTaskRes = await fetch(
      `http://127.0.0.1:${port}/api/anya/sessions/${session.id}/tasks/${createTaskBody.task.id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: 'completed' }),
      },
    )
    assert.equal(updateTaskRes.ok, true)
    const updateTaskBody = await updateTaskRes.json()
    assert.equal(updateTaskBody?.task?.status, 'completed')
  } finally {
    try {
      proc.kill('SIGTERM')
    } catch {}
    await waitForExit(proc, { timeoutMs: 10_000 })
    if (proc.exitCode === null) {
      try {
        proc.kill('SIGKILL')
      } catch {}
      await waitForExit(proc, { timeoutMs: 5_000 })
    }
    await safeRm(tempDir)
  }
})

