import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-integrity-repair-'))
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
      AUTH_JWT_SECRET: 'test-secret',
      ...extraEnv,
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
    const timeout = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    child.stdout.on('data', () => {
      const m = stdout.match(/\[Server\] Ready on port\s+(\d+)/)
      if (m) {
        clearTimeout(timeout)
        resolve({ port: Number(m[1]), dbPath })
      }
    })
  })

  async function stop() {
    if (child.killed) return
    try { child.kill('SIGTERM') } catch {}
    await new Promise((resolve) => child.once('exit', resolve))
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

async function loginEmailOtp({ port, email, profileId }) {
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
      profile_id: profileId ?? null,
    }),
  })
  assert.equal(verify.status, 200)
  assert.ok(verify.json?.accessToken)
  return verify.json.accessToken
}

test('admin integrity repair: dry-run + apply reattaches unowned profile by email signal', async () => {
  const srv = startServer()
  const { port, dbPath } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath)

    const adminUserId = '00000000-0000-0000-0000-00000000f901'
    const adminEmail = 'integrity-repair-admin@example.com'
    const ownerUserId = '00000000-0000-0000-0000-00000000f902'
    const ownerEmail = 'owner-match@example.com'

    const profileId = '00000000-0000-0000-0000-00000000f911'

    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES
        ('${adminUserId}', 'Integrity Repair Admin', '${adminEmail}', 1),
        ('${ownerUserId}', 'Owner', '${ownerEmail}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES
        ('00000000-0000-0000-0000-00000000f903', '${adminUserId}', 'email_otp', '${adminEmail}', 0),
        ('00000000-0000-0000-0000-00000000f904', '${ownerUserId}', 'email_otp', '${ownerEmail}', 0);

      -- Unowned profile with email signal in sections.
      INSERT INTO profiles (id, display_name, user_id, status, tags)
      VALUES ('${profileId}', 'Unowned Profile', NULL, 'active', '[]');

      INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES
        ('00000000-0000-0000-0000-00000000f921', '${profileId}', 'basic_information', '{"email":"${ownerEmail}"}');
    `)
    db.close()

    const adminToken = await loginEmailOtp({ port, email: adminEmail, profileId: null })

    const dry = await fetchJson(`http://127.0.0.1:${port}/api/admin/profiles/integrity/repair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ dry_run: true }),
    })
    assert.equal(dry.status, 200)
    assert.equal(dry.json?.ok, true)
    assert.equal(dry.json?.dry_run, true)
    assert.ok(dry.json?.reattach?.planned >= 1)

    const apply = await fetchJson(`http://127.0.0.1:${port}/api/admin/profiles/integrity/repair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ dry_run: false }),
    })
    assert.equal(apply.status, 200)
    assert.equal(apply.json?.ok, true)
    assert.equal(apply.json?.dry_run, false)
    assert.ok(apply.json?.reattach?.applied >= 1)

    const prof = await fetchJson(`http://127.0.0.1:${port}/api/profiles/${profileId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert.equal(prof.status, 200)
    assert.equal(String(prof.json?.user_id || ''), ownerUserId)
  } finally {
    await srv.stop()
  }
})

