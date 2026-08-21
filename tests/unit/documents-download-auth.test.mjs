import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

function startServer({ dbPath, uploadsDir }) {
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: '0',
      DB_PROVIDER: 'sqlite',
      SQLITE_DB_PATH: dbPath,
      DB_AUTO_MIGRATE: 'true',
      AUTH_JWT_SECRET: 'test-secret',
      ADMIN_TOKEN: 'test-admin-token',
      UPLOADS_DIR: uploadsDir,
      ALLOW_EPHEMERAL_UPLOADS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))

  const ready = new Promise((resolve, reject) => {
    let resolved = false
    let readyPoll = null
    const timeout = setTimeout(() => {
      if (resolved) return
      clearInterval(readyPoll)
      try { child.kill('SIGTERM') } catch {}
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    const checkReady = () => {
      const match = stdout.match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
      if (match) {
        resolved = true
        clearInterval(readyPoll)
        clearTimeout(timeout)
        resolve({ port: Number(match[1]) })
      }
    }
    child.stdout.on('data', checkReady)
    readyPoll = setInterval(checkReady, 50)
    checkReady()
  })

  async function stop() {
    if (child.killed) return
    try { child.kill('SIGTERM') } catch {}
    await new Promise((resolve) => child.once('exit', resolve))
  }

  return { ready, stop }
}

test('documents download: 401 without auth, 200 with admin bearer', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-doc-download-'))
  const dbPath = path.join(tmp, 'test.db')
  const uploadsDir = path.join(tmp, 'uploads')

  const { ready, stop } = startServer({ dbPath, uploadsDir })
  const { port } = await ready

  try {
    // Seed DB row + file for download.
    const db = new Database(dbPath)
    try {
      const docId = 'doc_test_1'
      const profileId = 'profile_test_1'
      const fileName = 'test-download.txt'
      const filePath = path.join(uploadsDir, fileName)
      const avatarPath = path.join(uploadsDir, 'avatar_profile_test_1_123.png')
      const outsidePath = path.join(tmp, 'outside-secret.txt')
      const symlinkPath = path.join(uploadsDir, 'outside-link.txt')
      mkdirSync(uploadsDir, { recursive: true })
      writeFileSync(filePath, 'hello world', 'utf8')
      writeFileSync(avatarPath, 'avatar cache', 'utf8')
      writeFileSync(outsidePath, 'must not leave the server', 'utf8')
      symlinkSync(outsidePath, symlinkPath)

      // Satisfy FK constraints (documents.profile_id -> profiles.id)
      db.prepare(
        `
          INSERT INTO profiles (id, display_name, status, created_at, updated_at)
          VALUES (?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
      ).run(profileId, 'Test Profile')

      db.prepare(
        `
          INSERT INTO documents (id, profile_id, name, file_url, file_path, mime_type, created_at)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `,
      ).run(
        docId,
        profileId,
        'Test Download',
        `/uploads/${fileName}`,
        filePath,
        'text/plain',
      )

      const insertUnsafeDocument = db.prepare(
        `
          INSERT INTO documents (id, profile_id, name, file_path, mime_type, created_at)
          VALUES (?, ?, ?, ?, 'text/plain', CURRENT_TIMESTAMP)
        `,
      )
      insertUnsafeDocument.run('doc_outside', profileId, 'Outside path', outsidePath)
      insertUnsafeDocument.run('doc_symlink', profileId, 'Symlink path', symlinkPath)
      insertUnsafeDocument.run('doc_directory', profileId, 'Directory path', uploadsDir)
      db.prepare(
        `
          INSERT INTO documents (id, profile_id, name, file_path, file_bytes, mime_type, created_at)
          VALUES (?, ?, ?, ?, ?, 'text/plain', CURRENT_TIMESTAMP)
        `,
      ).run('doc_durable_bytes', profileId, 'Durable bytes', outsidePath, Buffer.from('safe durable bytes'))
    } finally {
      db.close()
    }

    const base = `http://127.0.0.1:${port}`

    const publicDiagnostics = await fetch(`${base}/api/auth/diagnostics`)
    assert.equal(publicDiagnostics.status, 401)

    const adminDiagnostics = await fetch(`${base}/api/auth/diagnostics`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    })
    assert.equal(adminDiagnostics.status, 200)

    const publicPipelineHealth = await fetch(`${base}/api/admin/pipeline-health`)
    assert.equal(publicPipelineHealth.status, 401)

    const adminPipelineHealth = await fetch(`${base}/api/admin/pipeline-health`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    })
    assert.equal(adminPipelineHealth.status, 200)

    // /api/health/storage is admin-gated as of the epic slice-9 hardening
    // (it discusses filesystem/storage state): anonymous is refused outright,
    // and even the authorized admin payload stays redacted.
    const publicStorageHealth = await fetch(`${base}/api/health/storage`)
    assert.equal(publicStorageHealth.status, 401)

    const storageHealth = await fetch(`${base}/api/health/storage`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    })
    assert.equal(storageHealth.status, 200)
    const storageJson = await storageHealth.json()
    assert.equal(storageJson.details_redacted, true)
    assert.equal(Object.hasOwn(storageJson, 'uploadsDir'), false)
    assert.equal(Object.hasOwn(storageJson, 'legacyUploadsDir'), false)
    assert.equal(Object.hasOwn(storageJson, 'storage_status'), false)

    // Direct /uploads access is intentionally limited to public avatar cache files.
    const directUpload = await fetch(`${base}/uploads/test-download.txt`, {
      headers: { Accept: 'application/json' },
    })
    assert.equal(directUpload.status, 404)
    const directJson = await directUpload.json()
    assert.equal(directJson.code, 'UPLOAD_PRIVATE')

    const publicAvatarCache = await fetch(`${base}/uploads/avatar_profile_test_1_123.png`)
    assert.equal(publicAvatarCache.status, 200)
    assert.equal(await publicAvatarCache.text(), 'avatar cache')

    // Unauthenticated => 401
    const unauth = await fetch(`${base}/api/documents/doc_test_1/download`)
    assert.equal(unauth.status, 401)

    // Admin bearer => 200
    const auth = await fetch(`${base}/api/documents/doc_test_1/download`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    })
    assert.equal(auth.status, 200)
    const text = await auth.text()
    assert.equal(text, 'hello world')

    for (const docId of ['doc_outside', 'doc_symlink', 'doc_directory']) {
      const blocked = await fetch(`${base}/api/documents/${docId}/download`, {
        headers: { Authorization: 'Bearer test-admin-token' },
      })
      assert.equal(blocked.status, 404, `${docId} must not be streamed`)
      const body = await blocked.json()
      assert.equal(body.code, 'DOCUMENT_FILE_MISSING')
    }

    const durableBytes = await fetch(`${base}/api/documents/doc_durable_bytes/download`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    })
    assert.equal(durableBytes.status, 200)
    assert.equal(await durableBytes.text(), 'safe durable bytes')

    const durableMetadata = await fetch(`${base}/api/documents/doc_durable_bytes`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    })
    assert.equal(durableMetadata.status, 200)
    const durableMetadataJson = await durableMetadata.json()
    assert.equal(durableMetadataJson.download_url, '/api/documents/doc_durable_bytes/download')
    assert.equal(Object.hasOwn(durableMetadataJson, 'file_bytes'), false)
    assert.equal(Object.hasOwn(durableMetadataJson, 'has_durable_bytes'), false)

    const documentList = await fetch(`${base}/api/documents?profile_id=profile_test_1`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    })
    assert.equal(documentList.status, 200)
    const listedDurable = (await documentList.json()).find((doc) => doc.id === 'doc_durable_bytes')
    assert.equal(listedDurable.download_url, '/api/documents/doc_durable_bytes/download')
    assert.equal(Object.hasOwn(listedDurable, 'file_bytes'), false)
    assert.equal(Object.hasOwn(listedDurable, 'has_durable_bytes'), false)
  } finally {
    await stop()
  }
})
