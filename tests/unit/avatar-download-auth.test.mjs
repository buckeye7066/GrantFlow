import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer as createNetServer } from 'node:net'

function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : null
      srv.close((err) => {
        if (err) reject(err)
        else resolve(port)
      })
    })
  })
}

async function waitForHealthz(port, { child, getLogs, timeoutMs = 60_000 }) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      const { stdout, stderr } = getLogs()
      throw new Error(`server exited before ready (code=${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (response.ok) return { port, child }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const { stdout, stderr } = getLogs()
  throw new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-avatar-auth-test-'))
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
        AUTH_JWT_SECRET: 'test-secret-avatar',
        SMOKE_MODE: '1',
        DISABLE_BACKGROUND_SERVICES: 'true',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (d) => (stderr += d))

    return waitForHealthz(port, {
      child,
      getLogs: () => ({ stdout, stderr }),
    }).then(() => ({ port, child, tmp, dbPath }))
  })()

  return ready
}

function killServer(proc) {
  return new Promise((resolve, reject) => {
    if (!proc || proc.killed) {
      resolve()
      return
    }

    const timeout = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // ignore
      }
      reject(new Error('Server did not stop gracefully'))
    }, 10000)

    proc.on('exit', () => {
      clearTimeout(timeout)
      resolve()
    })

    try {
      proc.kill('SIGTERM')
    } catch {
      clearTimeout(timeout)
      resolve()
    }
  })
}

test('avatar download: returns 401 for unauthenticated requests', async () => {
  const { port, child } = await startServer()
  try {
    // Create a profile first (with auth)
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test-avatar@example.com',
        password: 'testpass123',
      }),
    })

    let accessToken = null
    if (loginRes.status === 200) {
      const loginData = await loginRes.json()
      accessToken = loginData.accessToken
    } else {
      // User doesn't exist, create one
      const signupRes = await fetch(`http://127.0.0.1:${port}/api/auth/email/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test-avatar@example.com',
          password: 'testpass123',
          name: 'Test Avatar User',
        }),
      })
      if (signupRes.ok) {
        const signupData = await signupRes.json()
        accessToken = signupData.accessToken
      }
    }

    // Create a profile
    let profileId = null
    if (accessToken) {
      const createProfileRes = await fetch(`http://127.0.0.1:${port}/api/profiles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          display_name: 'Test Profile for Avatar',
          primary_type: 'individual',
        }),
      })

      if (createProfileRes.ok) {
        const profileData = await createProfileRes.json()
        profileId = profileData.id
      }
    }

    // If we couldn't create a profile, use a dummy ID for the 401 test
    const testProfileId = profileId || 'test-profile-id'

    // Test 1: Unauthenticated request should return 401
    const unauthRes = await fetch(
      `http://127.0.0.1:${port}/api/profiles/${testProfileId}/avatar/download`,
      {
        method: 'GET',
      }
    )

    assert.equal(
      unauthRes.status,
      401,
      'Unauthenticated request to avatar download should return 401'
    )

    // Test 2: Authenticated request should NOT return 401 (could be 404 if avatar doesn't exist, but not 401)
    if (accessToken && profileId) {
      const authRes = await fetch(
        `http://127.0.0.1:${port}/api/profiles/${profileId}/avatar/download`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      )

      assert.notEqual(
        authRes.status,
        401,
        'Authenticated request to avatar download should not return 401'
      )

      // It should return 404 (avatar not set) since we didn't upload one
      assert.equal(
        authRes.status,
        404,
        'Avatar download for profile without avatar should return 404'
      )
    }
  } finally {
    await killServer(child)
  }
})
