import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-avatar-upload-test-'))
  const dbPath = path.join(tmp, 'test.db')

  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: '0',
      DB_PROVIDER: 'sqlite',
      SQLITE_DB_PATH: dbPath,
      DB_AUTO_MIGRATE: 'true',
      AUTH_JWT_SECRET: 'test-secret-avatar-upload',
      SMOKE_MODE: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => (stderr += d))

  const ready = new Promise((resolve, reject) => {
    let resolved = false
    let readyPoll = null
    const timeout = setTimeout(() => {
      if (resolved) return
      clearInterval(readyPoll)
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    const checkReady = (newChunk) => {
      if (resolved) return true
      const textToCheck = stdout + (newChunk || '')
      const match = textToCheck.match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
      if (match) {
        clearTimeout(timeout)
        clearInterval(readyPoll)
        resolved = true
        resolve({ port: parseInt(match[1], 10), child, tmp, dbPath })
        return true
      }
      return false
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (!checkReady(chunk)) {
        process.stdout.write(chunk)
      }
    })
    readyPoll = setInterval(() => {
      checkReady()
    }, 50)
    checkReady()

    child.on('error', (err) => {
      if (resolved) return
      clearInterval(readyPoll)
      clearTimeout(timeout)
      resolved = true
      reject(err)
    })
  })

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
    }, 10_000)

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

function oneByOnePngBlob() {
  // 1x1 transparent PNG
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+8iUQAAAAASUVORK5CYII='
  const bytes = Buffer.from(pngBase64, 'base64')
  return new Blob([bytes], { type: 'image/png' })
}

test('avatar upload + download: authorized upload stores /uploads and download streams image', async () => {
  const { port, child } = await startServer()
  try {
    const email = 'avatar-upload@example.com'

    const start = await fetch(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    assert.equal(start.status, 202)
    const startJson = await start.json()
    assert.ok(startJson.previewCode)
    assert.ok(startJson.verification_token)

    const verify = await fetch(`http://127.0.0.1:${port}/api/auth/email/verify`, {
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
    assert.ok(verifyJson.accessToken)

    // Create a profile
    const createProfileRes = await fetch(`http://127.0.0.1:${port}/api/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${verifyJson.accessToken}`,
      },
      body: JSON.stringify({ display_name: 'Avatar Upload Profile', primary_type: 'individual_need' }),
    })
    assert.equal(createProfileRes.status, 201)
    const profile = await createProfileRes.json()
    assert.ok(profile?.id)

    // Upload avatar
    const form = new FormData()
    form.append('avatar', oneByOnePngBlob(), 'avatar.png')
    const uploadRes = await fetch(`http://127.0.0.1:${port}/api/profiles/${profile.id}/avatar`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verifyJson.accessToken}`,
      },
      body: form,
    })
    assert.equal(uploadRes.status, 200)
    const updated = await uploadRes.json()
    assert.ok(String(updated?.avatar_url || '').startsWith('/uploads/'))
    assert.ok(String(updated?.avatar_download_url || '').includes(`/api/profiles/${profile.id}/avatar/download`))

    // Download avatar (must be 200 with correct content-type)
    const downloadRes = await fetch(`http://127.0.0.1:${port}${updated.avatar_download_url}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${verifyJson.accessToken}`,
      },
    })
    assert.equal(downloadRes.status, 200)
    const ct = downloadRes.headers.get('content-type') || ''
    assert.ok(ct.includes('image/'), `expected image/* content-type, got ${ct}`)
    const buf = Buffer.from(await downloadRes.arrayBuffer())
    assert.ok(buf.length > 0)
  } finally {
    await killServer(child)
  }
})
