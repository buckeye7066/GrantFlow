import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
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
      if (response.ok) return { port }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const { stdout, stderr } = getLogs()
  throw new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}

function startServer({ dbPath, uploadsDir, extraEnv = {} }) {
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
        AUTH_JWT_SECRET: 'test-secret-avatar-persist',
        SMOKE_MODE: '1',
        DISABLE_BACKGROUND_SERVICES: 'true',
        UPLOADS_DIR: uploadsDir,
        ALLOW_EPHEMERAL_UPLOADS: 'true',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))

    return waitForHealthz(port, {
      child,
      getLogs: () => ({ stdout, stderr }),
    })
  })()

  async function stop() {
    if (child.killed) return
    try { child.kill('SIGTERM') } catch {}
    await new Promise((resolve) => child.once('exit', resolve))
  }

  return { ready, stop }
}

function oneByOnePngBlob() {
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+8iUQAAAAASUVORK5CYII='
  const bytes = Buffer.from(pngBase64, 'base64')
  return new Blob([bytes], { type: 'image/png' })
}

test('uploads persistence: avatar upload survives server restart (same db + uploads dir)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-avatar-persist-'))
  const dbPath = path.join(tmp, 'test.db')
  const uploadsDir = path.join(tmp, 'uploads')

  const srv1 = startServer({ dbPath, uploadsDir })
  const { port: port1 } = await srv1.ready

  let token
  let profileId
  let avatarUrl
  let downloadUrl

  try {
    const email = 'avatar-persist@example.com'

    const start = await fetch(`http://127.0.0.1:${port1}/api/auth/email/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    assert.equal(start.status, 202)
    const startJson = await start.json()
    assert.ok(startJson.previewCode)
    assert.ok(startJson.verification_token)

    const verify = await fetch(`http://127.0.0.1:${port1}/api/auth/email/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        code: startJson.previewCode,
        verification_token: startJson.verification_token,
      }),
    })
    assert.equal(verify.status, 200)
    const verifyJson = await verify.json()
    token = verifyJson.accessToken
    assert.ok(token)

    const createProfileRes = await fetch(`http://127.0.0.1:${port1}/api/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ display_name: 'Avatar Persist Profile', primary_type: 'individual_need' }),
    })
    assert.equal(createProfileRes.status, 201)
    const profile = await createProfileRes.json()
    profileId = profile.id
    assert.ok(profileId)

    const form = new FormData()
    form.append('avatar', oneByOnePngBlob(), 'avatar.png')
    const uploadRes = await fetch(`http://127.0.0.1:${port1}/api/profiles/${profileId}/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    assert.equal(uploadRes.status, 200)
    const updated = await uploadRes.json()
    avatarUrl = String(updated?.avatar_url || '')
    downloadUrl = String(updated?.avatar_download_url || '')
    assert.ok(avatarUrl.startsWith('/uploads/'))
    assert.ok(downloadUrl.includes(`/api/profiles/${profileId}/avatar/download`))

    const fileName = avatarUrl.replace('/uploads/', '')
    const filePath = path.join(uploadsDir, fileName)
    assert.ok(existsSync(filePath), `expected uploaded file to exist at ${filePath}`)
  } finally {
    await srv1.stop()
  }

  // Restart using the same DB + uploads dir; download must still succeed.
  const srv2 = startServer({ dbPath, uploadsDir })
  const { port: port2 } = await srv2.ready
  try {
    const profRes = await fetch(`http://127.0.0.1:${port2}/api/profiles/${profileId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(profRes.status, 200)
    const profJson = await profRes.json()
    assert.equal(String(profJson?.avatar_url || ''), avatarUrl)

    const downloadRes = await fetch(`http://127.0.0.1:${port2}${downloadUrl}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(downloadRes.status, 200)
    const ct = downloadRes.headers.get('content-type') || ''
    assert.ok(ct.includes('image/'), `expected image/* content-type, got ${ct}`)
    const buf = Buffer.from(await downloadRes.arrayBuffer())
    assert.ok(buf.length > 0)
  } finally {
    await srv2.stop()
  }
})
