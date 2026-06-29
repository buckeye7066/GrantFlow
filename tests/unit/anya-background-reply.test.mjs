import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import net from 'node:net'
import { join } from 'node:path'
import { promises as fsp } from 'node:fs'
import { spawn } from 'node:child_process'

// End-to-end coverage for the async/background Anya reply path:
//   POST /sessions/:id/messages { background:true } -> 202 + run_id (no blocking)
//   GET  /sessions/:id/runs/:runId                  -> run status until completed
// With no AI key in the test env, generateAssistantResponse falls back to the
// deterministic guided reply, so the run still completes and we can assert the
// full handshake (202 ack, run completion, persisted assistant message).

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
    server.on('error', reject)
  })
}

async function startBackend({ rootDir, sqlitePath }) {
  let stdoutBuf = ''
  let stderrBuf = ''
  const port = await reservePort()
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    SMOKE_MODE: 'true',
    PORT: String(port),
    DB_PROVIDER: 'sqlite',
    DB_DIALECT: 'sqlite',
    DATABASE_URL: '',
    DB_AUTO_MIGRATE: 'true',
    SQLITE_DB_PATH: sqlitePath,
    ADMIN_TOKEN: 'test-admin-token',
    CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173',
    AUTH_FRONTEND_APP_BASE: process.env.VITE_APP_BASE || '/grantflow',
    DISABLE_BACKGROUND_SERVICES: 'true',
    ANYA_AUTONOMOUS_ENABLED: 'false',
    ANYA_RUN_ON_STARTUP: 'false',
    ANYA_RUN_ON_SCHEDULE: 'false',
    NATIONAL_PROGRAMS_CRAWLER_ENABLED: 'false',
    STARTUP_SMOKE_CRAWL_ENABLED: 'false',
    // Force the deterministic fallback path quickly (no real provider configured).
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
  }

  const proc = spawn(process.execPath, ['backend/start.js'], {
    cwd: rootDir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
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
  while (Date.now() - start <= timeoutMs) {
    if (proc.exitCode != null) {
      throw new Error(`Backend exited before healthy (exit=${proc.exitCode}).\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { method: 'GET' })
      if (res.ok) return { proc, port, getLogs: () => ({ stdout: stdoutBuf, stderr: stderrBuf }) }
    } catch {
      // keep polling
    }
    await sleep(250)
  }
  try { proc.kill('SIGTERM') } catch {}
  throw new Error(`Backend did not become healthy within ${timeoutMs}ms.\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`)
}

async function safeRm(dir) {
  for (let i = 0; i < 8; i += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
        await sleep(150 * (i + 1))
        continue
      }
      throw error
    }
  }
  await fsp.rm(dir, { recursive: true, force: true })
}

test('Anya background reply: 202 ack, run completes, assistant message persisted', async () => {
  const rootDir = process.cwd()
  const tempDir = await fsp.mkdtemp(join(os.tmpdir(), 'grantflow-anya-bg-'))
  const sqlitePath = join(tempDir, 'grantflow-test.db')

  const { proc, getLogs, port } = await startBackend({ rootDir, sqlitePath })
  try {
    const headers = { 'content-type': 'application/json', 'x-admin-token': 'test-admin-token' }
    const base = `http://127.0.0.1:${port}/api/anya`

    const sessionRes = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'BG test' }),
    })
    assert.equal(sessionRes.ok, true, `create session failed: ${sessionRes.status}`)
    const session = await sessionRes.json()
    assert.ok(session?.id, 'expected session id')

    // Background send must NOT block on the reply — it returns 202 immediately.
    const sendRes = await fetch(`${base}/sessions/${session.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'What can you help me with?', background: true }),
    })
    assert.equal(sendRes.status, 202, 'expected 202 Accepted for background send')
    const sendBody = await sendRes.json()
    assert.equal(sendBody.pending, true, 'expected pending=true')
    assert.ok(sendBody.run_id, 'expected run_id')
    assert.equal(sendBody.messages?.[0]?.role, 'user', 'expected persisted user message echoed back')
    // The assistant reply is NOT in the ack — it comes later via the run.
    assert.ok(
      !sendBody.messages?.some((m) => m.role === 'assistant'),
      'background ack must not contain the assistant reply yet',
    )

    // Poll the run until it completes.
    let run = null
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const runRes = await fetch(`${base}/sessions/${session.id}/runs/${sendBody.run_id}`, { headers })
      assert.equal(runRes.ok, true, `run status fetch failed: ${runRes.status}`)
      const body = await runRes.json()
      run = body.run
      if (run?.status === 'completed' || run?.status === 'failed') break
      await sleep(500)
    }
    assert.ok(run, 'expected a run object')
    assert.equal(run.status, 'completed', `expected run to complete, got ${run?.status}`)
    assert.ok(run.assistant_message_id, 'expected assistant_message_id on the completed run')

    // The assistant reply must now be persisted in the thread.
    const msgRes = await fetch(`${base}/sessions/${session.id}/messages`, { headers })
    assert.equal(msgRes.ok, true, 'messages fetch failed')
    const { messages } = await msgRes.json()
    assert.ok(
      messages.some((m) => m.role === 'assistant' && String(m.content || '').trim().length > 0),
      'expected a non-empty assistant message after the background run completed',
    )
  } catch (error) {
    const logs = getLogs?.()
    throw new Error(`${error?.message || error}\n\nstdout:\n${logs?.stdout || ''}\n\nstderr:\n${logs?.stderr || ''}`)
  } finally {
    try { proc.kill('SIGTERM') } catch {}
    await sleep(300)
    await safeRm(tempDir)
  }
})
