import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
    server.on('error', reject)
  })
}

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-anya-test-'))
  const dbPath = path.join(tmp, 'test.db')
  let child = null
  let stdout = ''
  let stderr = ''

  const ready = (async () => {
    const port = await reservePort()
    child = spawn(process.execPath, ['backend/server.js'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        DB_PROVIDER: 'sqlite',
        SQLITE_DB_PATH: dbPath,
        DB_AUTO_MIGRATE: 'true',
        AUTH_JWT_SECRET: 'test-secret',
        SMOKE_MODE: 'true',
        DISABLE_BACKGROUND_SERVICES: 'true',
        ANYA_AUTONOMOUS_ENABLED: 'false',
        ANYA_RUN_ON_STARTUP: 'false',
        ANYA_RUN_ON_SCHEDULE: 'false',
        NATIONAL_PROGRAMS_CRAWLER_ENABLED: 'false',
        STARTUP_SMOKE_CRAWL_ENABLED: 'false',
        // Provide a configured admin token so non-admin /api/anya/status yields a deterministic 403.
        ADMIN_TOKEN: 'test-admin-token',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`server exited before ready (code=${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`)
        if (res.ok) return { port }
      } catch {
        // retry
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    try { child.kill('SIGTERM') } catch {}
    throw new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  })()

  async function stop() {
    if (!child) return
    if (child.killed) return
    try { child.kill('SIGTERM') } catch {}
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
    if (!child.killed && child.exitCode === null) {
      try { child.kill('SIGKILL') } catch {}
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }

  return { ready, stop, dbPath }
}

async function fetchJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function loginEmailOtp({ port, email }) {
  const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  assert.equal(start.status, 202)
  assert.equal(typeof start.json?.previewCode, 'string')
  assert.equal(typeof start.json?.verification_token, 'string')

  const verify = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/verify`, {
    method: 'POST',
    body: JSON.stringify({
      email,
      code: start.json.previewCode,
      verification_token: start.json.verification_token,
    }),
  })
  assert.equal(verify.status, 200)
  assert.ok(verify.json?.accessToken)
  return verify.json.accessToken
}

test('anya: status, sessions/messages, tasks, tools (deterministic)', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const adminEmail = 'owner@example.invalid'
    const userEmail = 'anya-user@example.com'

    const adminUserId = '00000000-0000-0000-0000-00000000d001'
    const userId = '00000000-0000-0000-0000-00000000d002'
    const adminProfileId = '00000000-0000-0000-0000-00000000e001'
    const userProfileId = '00000000-0000-0000-0000-00000000e002'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES
        ('${adminUserId}', 'Admin User', '${adminEmail}', 1),
        ('${userId}', 'Normal User', '${userEmail}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES
        ('00000000-0000-0000-0000-00000000f001', '${adminUserId}', 'email_otp', '${adminEmail}', 0),
        ('00000000-0000-0000-0000-00000000f002', '${userId}', 'email_otp', '${userEmail}', 0);

      INSERT INTO profiles (id, display_name, user_id, status, tags)
      VALUES
        ('${adminProfileId}', 'Admin Profile', '${adminUserId}', 'active', '[]'),
        ('${userProfileId}', 'User Profile', '${userId}', 'active', '[]');
    `)
    db.close()

    const adminToken = await loginEmailOtp({ port, email: adminEmail })
    const userToken = await loginEmailOtp({ port, email: userEmail })

    // /api/anya/status is admin-only. Non-admin should be rejected deterministically.
    const statusUser = await fetchJson(`http://127.0.0.1:${port}/api/anya/status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${userToken}` },
    })
    assert.equal(statusUser.status, 403)

    const statusAdmin = await fetchJson(`http://127.0.0.1:${port}/api/anya/status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert.equal(statusAdmin.status, 200)
    assert.equal(statusAdmin.json?.status, 'ready')
    assert.equal(typeof statusAdmin.json?.openai?.api_key_configured, 'boolean')
    assert.equal(typeof statusAdmin.json?.anthropic?.api_key_configured, 'boolean')

    // Create a session for the user profile.
    const sessionCreate = await fetchJson(`http://127.0.0.1:${port}/api/anya/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ profile_id: userProfileId, title: 'Test Session' }),
    })
    assert.equal(sessionCreate.status, 201)
    assert.ok(sessionCreate.json?.id)
    const sessionId = sessionCreate.json.id

    // Post a message; should always return user+assistant messages even when AI providers are missing.
    const msgRes = await fetchJson(`http://127.0.0.1:${port}/api/anya/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ content: 'hello anya' }),
    })
    assert.equal(msgRes.status, 201)
    assert.ok(Array.isArray(msgRes.json?.messages))
    assert.equal(msgRes.json.messages.length, 2)
    assert.equal(msgRes.json.messages[0].role, 'user')
    assert.equal(msgRes.json.messages[1].role, 'assistant')
    assert.ok(String(msgRes.json.messages[1].content || '').length > 0)

    // Tasks: create + update
    const taskCreate = await fetchJson(`http://127.0.0.1:${port}/api/anya/sessions/${sessionId}/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ title: 'Follow up with funder', status: 'open', priority: 'normal' }),
    })
    assert.equal(taskCreate.status, 201)
    assert.ok(taskCreate.json?.task?.id)
    assert.equal(taskCreate.json.task.status, 'open')

    const taskId = taskCreate.json.task.id
    const taskUpdate = await fetchJson(`http://127.0.0.1:${port}/api/anya/sessions/${sessionId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ status: 'completed' }),
    })
    assert.equal(taskUpdate.status, 200)
    assert.equal(taskUpdate.json?.task?.status, 'completed')

    // List profile tasks by profile id.
    const listProfileTasks = await fetchJson(`http://127.0.0.1:${port}/api/anya/profiles/${userProfileId}/tasks?status=active`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${userToken}` },
    })
    assert.equal(listProfileTasks.status, 200)
    assert.ok(Array.isArray(listProfileTasks.json?.tasks))

    // Tools list is filtered by admin.
    const toolsUser = await fetchJson(`http://127.0.0.1:${port}/api/anya/tools`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${userToken}` },
    })
    assert.equal(toolsUser.status, 200)
    assert.ok(Array.isArray(toolsUser.json?.tools))
    assert.ok(toolsUser.json.tools.some((t) => t.name === 'noop.echo'))
    assert.ok(!toolsUser.json.tools.some((t) => String(t.name).startsWith('admin.')))

    // Non-admin cannot invoke admin tools.
    const adminToolDenied = await fetchJson(`http://127.0.0.1:${port}/api/anya/tools/admin.crawler.list/invoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ limit: 1 }),
    })
    assert.equal(adminToolDenied.status, 403)

    // Admin can invoke admin tools (use a safe one).
    const adminToolOk = await fetchJson(`http://127.0.0.1:${port}/api/anya/tools/admin.crawler.list/invoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ limit: 1 }),
    })
    assert.equal(adminToolOk.status, 201)
    assert.ok(adminToolOk.json?.result)
    assert.equal(adminToolOk.json.result.tool, 'admin.crawler.list')
  } finally {
    await srv.stop()
  }
})
