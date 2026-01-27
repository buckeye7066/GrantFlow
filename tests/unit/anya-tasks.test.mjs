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
  // Prefer connect-probing over bind-probing.
  // On Windows, some listeners can allow a second bind probe to succeed (SO_REUSEADDR),
  // but connect() will still succeed if a service is already bound and accepting.
  return await new Promise((resolve) => {
    const socket = net.connect({ port, host })
    socket.once('connect', () => {
      try { socket.destroy() } catch {}
      resolve(false)
    })
    socket.once('error', (err) => {
      try { socket.destroy() } catch {}
      if (err?.code === 'ECONNREFUSED') return resolve(true)
      // Conservative default: treat unknown errors as "in use" so we pick another port.
      resolve(false)
    })
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

async function assertOk(res, label) {
  if (res.ok) return
  let body = ''
  try {
    body = await res.text()
  } catch {}
  throw new Error(`${label} failed: status=${res.status} body=${body}`)
}

async function startBackend({ rootDir, port, sqlitePath }) {
  let stdoutBuf = ''
  let stderrBuf = ''
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    SMOKE_MODE: 'true',
    PORT: String(port),
    // Force sqlite for unit tests even if the parent env has DATABASE_URL set.
    DB_PROVIDER: 'sqlite',
    DB_DIALECT: 'sqlite',
    DATABASE_URL: '',
    DB_AUTO_MIGRATE: 'true',
    SQLITE_DB_PATH: sqlitePath,
    // Make tests deterministic even if host env has ADMIN_TOKEN set.
    ADMIN_TOKEN: 'test-admin-token',
    CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173',
    AUTH_FRONTEND_APP_BASE: process.env.VITE_APP_BASE || '/grantflow',
    // Avoid any surprise background work during unit tests.
    ANYA_AUTONOMOUS_ENABLED: 'false',
    NATIONAL_PROGRAMS_CRAWLER_ENABLED: 'false',
  }

  // IMPORTANT: Use backend/start.js so dotenv is loaded consistently before server boot.
  // Running server.js directly can miss env initialization and cause flaky health readiness.
  const proc = spawn(process.execPath, ['backend/start.js'], {
    cwd: rootDir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let spawnError = null
  proc.once('error', (err) => {
    spawnError = err
  })

  proc.stdout?.on('data', (chunk) => {
    stdoutBuf += String(chunk ?? '')
    if (stdoutBuf.length > 20_000) stdoutBuf = stdoutBuf.slice(-20_000)
  })
  proc.stderr?.on('data', (chunk) => {
    stderrBuf += String(chunk ?? '')
    if (stderrBuf.length > 20_000) stderrBuf = stderrBuf.slice(-20_000)
  })

  const start = Date.now()
  const timeoutMs = 60_000
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (spawnError) {
      const stdout = stdoutBuf
      const stderr = stderrBuf
      throw new Error(
        `Backend failed to spawn for Anya tests.\n` +
          `--- error ---\n${spawnError?.message || String(spawnError)}\n` +
          `--- stdout ---\n${stdout || '(empty)'}\n` +
          `--- stderr ---\n${stderr || '(empty)'}\n`,
      )
    }

    if (proc.exitCode != null) {
      const stdout = stdoutBuf
      const stderr = stderrBuf
      throw new Error(
        `Backend exited before becoming healthy (exit=${proc.exitCode}).\n` +
          `--- stdout ---\n${stdout || '(empty)'}\n` +
          `--- stderr ---\n${stderr || '(empty)'}\n`,
      )
    }

    if (Date.now() - start > timeoutMs) break

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { method: 'GET' })
      if (res.ok) break
    } catch {
      // keep polling
    }

    // eslint-disable-next-line no-await-in-loop
    await sleep(250)
  }

  if (Date.now() - start > timeoutMs) {
    try { proc.kill('SIGTERM') } catch {}
    throw new Error(
      `Backend did not become healthy for Anya tests within ${timeoutMs}ms.\n` +
        `--- stdout ---\n${stdoutBuf || '(empty)'}\n` +
        `--- stderr ---\n${stderrBuf || '(empty)'}\n`,
    )
  }

  return {
    proc,
    getLogs: () => ({ stdout: stdoutBuf, stderr: stderrBuf }),
  }
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

  const { proc, getLogs } = await startBackend({ rootDir, port, sqlitePath })
  try {
    const headers = {
      'content-type': 'application/json',
      'x-admin-token': 'test-admin-token',
    }

    const createSessionRes = await fetch(`http://127.0.0.1:${port}/api/anya/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Test session' }),
    })
    if (!createSessionRes.ok) {
      const text = await createSessionRes.text().catch(() => '')
      const logs = getLogs?.()
      throw new Error(
        `Expected /api/anya/sessions to succeed, got ${createSessionRes.status} ${createSessionRes.statusText}: ${text}\n\nstdout:\n${logs?.stdout || ''}\n\nstderr:\n${logs?.stderr || ''}`,
      )
    }
    const session = await createSessionRes.json()
    assert.ok(session?.id, 'expected created session id')

    const createTaskRes = await fetch(`http://127.0.0.1:${port}/api/anya/sessions/${session.id}/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Test task', status: 'open' }),
    })
    await assertOk(createTaskRes, 'create task')
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
    await assertOk(updateTaskRes, 'update task')
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

