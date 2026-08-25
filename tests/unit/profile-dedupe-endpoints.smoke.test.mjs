import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-dedupe-smoke-'))
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
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    child.stdout.on('data', () => {
      const m = stdout.match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
      if (m) {
        clearTimeout(timeout)
        resolve({ port: Number(m[1]), dbPath })
      }
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`server failed to spawn: ${String(err?.message || err)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })

    child.on('exit', (code) => {
      if (/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port/.test(stdout)) return
      clearTimeout(timeout)
      reject(new Error(`server exited before ready (code=${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })

  async function stop() {
    if (child.killed) return
    child.kill('SIGTERM')
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

test('admin dedupe endpoints: duplicates + merge (dry-run + apply) enforce admin-only and preserve owner access', async () => {
  const srv = startServer()
  const { port, dbPath } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath)

    const adminUserId = '00000000-0000-0000-0000-00000000d901'
    const adminEmail = 'dedupe-admin@example.com'

    const ownerUserId = '00000000-0000-0000-0000-00000000d902'
    const ownerEmail = 'dup-owner@example.com'

    const winnerProfileId = '00000000-0000-0000-0000-00000000d911'
    const loserProfileId = '00000000-0000-0000-0000-00000000d912'

    // Seed admin + owner users.
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES
        ('${adminUserId}', 'Dedupe Admin', '${adminEmail}', 1),
        ('${ownerUserId}', 'Dup Owner', '${ownerEmail}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES
        ('00000000-0000-0000-0000-00000000d903', '${adminUserId}', 'email_otp', '${adminEmail}', 0),
        ('00000000-0000-0000-0000-00000000d904', '${ownerUserId}', 'email_otp', '${ownerEmail}', 0);

      -- Winner is owned by the end-user. Loser is legacy/unowned.
      INSERT INTO profiles (id, display_name, user_id, status)
      VALUES
        ('${winnerProfileId}', 'Dup Profile Winner', '${ownerUserId}', 'active'),
        ('${loserProfileId}', 'Dup Profile Loser', NULL, 'active');

      -- Email signal is stored in profile sections for both, so strategy=email_or_phone groups them.
      INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES
        ('00000000-0000-0000-0000-00000000d921', '${winnerProfileId}', 'basic_information', '{"email":"${ownerEmail}","state":"OH","zip":"43004"}'),
        ('00000000-0000-0000-0000-00000000d922', '${loserProfileId}', 'basic_information', '{"email":"${ownerEmail}"}');
    `)

    db.close()

    const adminToken = await loginEmailOtp({ port, email: adminEmail, profileId: null })
    const ownerToken = await loginEmailOtp({ port, email: ownerEmail, profileId: winnerProfileId })

    // Non-admin cannot query duplicates.
    const dupUser = await fetchJson(
      `http://127.0.0.1:${port}/api/admin/profiles/duplicates?strategy=email_or_phone&limitGroups=10&minGroupSize=2`,
      { method: 'GET', headers: { Authorization: `Bearer ${ownerToken}` } },
    )
    assert.equal(dupUser.status, 403)

    // Admin can query duplicates.
    const dupAdmin = await fetchJson(
      `http://127.0.0.1:${port}/api/admin/profiles/duplicates?strategy=email_or_phone&limitGroups=10&minGroupSize=2`,
      { method: 'GET', headers: { Authorization: `Bearer ${adminToken}` } },
    )
    assert.equal(dupAdmin.status, 200)
    assert.equal(dupAdmin.json?.ok, true)
    assert.ok(Array.isArray(dupAdmin.json?.groups))
    assert.ok(dupAdmin.json.groups.length >= 1)

    const group = dupAdmin.json.groups.find((g) => String(g?.key || '').includes(ownerEmail.toLowerCase()))
    assert.ok(group, 'expected duplicate group keyed by owner email')
    assert.equal(group.winner.id, winnerProfileId)
    assert.ok(Array.isArray(group.losers) && group.losers.some((p) => p.id === loserProfileId))

    // dry_run is REMOVED OUTRIGHT (owner no-dry-runs order): NAMING the flag
    // fails with 400 — it must never silently proceed as a real merge.
    const mergeNamed = await fetchJson(`http://127.0.0.1:${port}/api/admin/profiles/merge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        winnerId: winnerProfileId,
        loserIds: [loserProfileId],
        dryRun: true,
      }),
    })
    assert.equal(mergeNamed.status, 400)
    assert.match(String(mergeNamed.json?.error || ''), /removed/i)

    // Apply merge (no flag = the real thing).
    const mergeApply = await fetchJson(`http://127.0.0.1:${port}/api/admin/profiles/merge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        winnerId: winnerProfileId,
        loserIds: [loserProfileId],
      }),
    })
    assert.equal(mergeApply.status, 200)
    assert.equal(mergeApply.json?.ok, true)
    assert.equal(mergeApply.json?.dry_run, false)

    // Owner can still list and access only their winner profile.
    const listOwner = await fetchJson(`http://127.0.0.1:${port}/api/profiles`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` },
    })
    assert.equal(listOwner.status, 200)
    assert.ok(Array.isArray(listOwner.json))
    assert.ok(listOwner.json.some((p) => p.id === winnerProfileId))
    assert.ok(!listOwner.json.some((p) => p.id === loserProfileId))

    const loserAccess = await fetchJson(`http://127.0.0.1:${port}/api/profiles/${loserProfileId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ownerToken}` },
    })
    // Depending on whether loser was hard-deleted or soft-deleted, this can be 403 or 404.
    assert.ok([403, 404].includes(loserAccess.status))
  } finally {
    await srv.stop()
  }
})

