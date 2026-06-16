import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

function stripAnsi(text) {
  return String(text || '').replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
}

async function waitForHttpOk(url, { timeoutMs = 30_000 } = {}) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const elapsed = Date.now() - start
    if (elapsed > timeoutMs) return false
    try {
      const requestTimeoutMs = Math.max(1, Math.min(1_000, timeoutMs - elapsed))
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      if (res.ok) return true
    } catch {}
    // eslint-disable-next-line no-await-in-loop
    await sleep(250)
  }
}

export async function stopProcess(proc) {
  if (!proc) return
  const waitForExit = () =>
    new Promise((resolve) => {
      if (proc.exitCode != null) {
        resolve()
        return
      }

      const done = () => {
        proc.off('exit', done)
        proc.off('close', done)
        resolve()
      }

      proc.once('exit', done)
      proc.once('close', done)
    })

  const exitWait = waitForExit()

  try {
    proc.kill('SIGTERM')
  } catch {}

  await Promise.race([exitWait, sleep(1_000)])

  if (proc.exitCode == null) {
    try {
      proc.kill('SIGKILL')
    } catch {}
    await Promise.race([exitWait, sleep(1_000)])
  }
}

export async function startBackend({ rootDir, envOverrides = {} }) {
  // IMPORTANT: always isolate the DB per test run to avoid SQLITE_BUSY.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-tests-'))
  const sqlitePath = path.join(tempDir, 'grantflow-test.db')

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    SMOKE_MODE: 'true',
    PORT: '0', // OS picks an ephemeral port
    DB_PROVIDER: 'sqlite',
    SQLITE_DB_PATH: sqlitePath,
    DB_AUTO_MIGRATE: 'true',
    AUTH_JWT_SECRET: 'test-secret',
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'test-admin-token',
    CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173',
    AUTH_FRONTEND_APP_BASE: process.env.VITE_APP_BASE || '/grantflow',
    // Deterministic tests: disable live crawls by default.
    LIVE_CRAWL_ENABLED: 'false',
    ...envOverrides,
  }

  const proc = spawn(process.execPath, ['backend/start.js'], {
    cwd: rootDir,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stdoutChunks = []
  const stderrChunks = []
  proc.stdout?.on('data', (buf) => stdoutChunks.push(String(buf)))
  proc.stderr?.on('data', (buf) => stderrChunks.push(String(buf)))

  let readyPort = null
  const detectReadyPort = () => {
    if (readyPort) return
    const combined = stripAnsi(stdoutChunks.join(''))
    const match = combined.match(/\[Server\]\s+Ready on port\s+(\d+)/)
    if (match) readyPort = Number(match[1])
  }
  proc.stdout?.on('data', detectReadyPort)
  detectReadyPort()

  const start = Date.now()
  const timeoutMs = 60_000
  // eslint-disable-next-line no-constant-condition
  while (true) {
    detectReadyPort()
    if (proc.exitCode != null) {
      throw new Error(
        `Backend exited before becoming healthy (exit=${proc.exitCode}).\n` +
          `--- stdout ---\n${stdoutChunks.join('') || '(empty)'}\n` +
          `--- stderr ---\n${stderrChunks.join('') || '(empty)'}\n`,
      )
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Backend did not become healthy within ${timeoutMs}ms.\n` +
          `--- stdout ---\n${stdoutChunks.join('') || '(empty)'}\n` +
          `--- stderr ---\n${stderrChunks.join('') || '(empty)'}\n`,
      )
    }
    if (readyPort) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await waitForHttpOk(`http://127.0.0.1:${readyPort}/api/health`, { timeoutMs: 2_000 })
      if (ok) {
        return { proc, tempDir, port: readyPort, adminToken: env.ADMIN_TOKEN }
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(250)
  }
}
