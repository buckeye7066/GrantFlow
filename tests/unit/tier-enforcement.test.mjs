import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-tier-enforcement-'))
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
      reject(
        new Error(
          `server failed to spawn: ${String(err?.message || err)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      )
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

test('tier enforcement is backend-authoritative (pipeline automation, item funding, document AI)', async () => {
  const srv = startServer()
  const { port, dbPath } = await srv.ready

  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath)

    const { ensureBillingSchema } = await import('../../backend/services/billingAccounts.js')
    await ensureBillingSchema(db)

    const adminUserId = '00000000-0000-0000-0000-00000000t001'
    const adminEmail = 'tier-admin@example.com'

    const userId = '00000000-0000-0000-0000-00000000t002'
    const userEmail = 'tier-user@example.com'
    const profileId = '00000000-0000-0000-0000-00000000t010'

    // Seed admin + user + profile.
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES
        ('${adminUserId}', 'Tier Admin', '${adminEmail}', 1),
        ('${userId}', 'Tier User', '${userEmail}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES
        ('00000000-0000-0000-0000-00000000t003', '${adminUserId}', 'email_otp', '${adminEmail}', 0),
        ('00000000-0000-0000-0000-00000000t004', '${userId}', 'email_otp', '${userEmail}', 0);

      INSERT INTO profiles (id, display_name, user_id, status)
      VALUES ('${profileId}', 'Tiered Profile', '${userId}', 'active');
    `)

    // Force a tier with all capabilities disabled.
    db.exec(`
      INSERT OR REPLACE INTO billing_tiers (
        id, name, description,
        base_monthly_cents, hourly_rate_cents,
        enable_pipeline_automation, enable_item_funding, enable_document_ai
      ) VALUES (
        'test_low',
        'Test Low',
        'No paid capabilities enabled',
        NULL, NULL,
        0, 0, 0
      );

      INSERT OR REPLACE INTO billing_accounts (
        id, profile_id, tier_id, assigned_by, assigned_reason, discount_type, discount_percent, is_pro_bono
      ) VALUES (
        '00000000-0000-0000-0000-00000000t020',
        '${profileId}',
        'test_low',
        'test',
        'test',
        'none',
        0,
        0
      );
    `)

    db.close()

    const adminToken = await loginEmailOtp({ port, email: adminEmail, profileId: null })
    const userToken = await loginEmailOtp({ port, email: userEmail, profileId })

    // PIPELINE_AUTOMATION: deny non-admin tier.
    const pipelineDenied = await fetchJson(`http://127.0.0.1:${port}/api/crawlers/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        type: 'pipeline_automation',
        profile_id: profileId,
        parameters: { organization_id: null, limit: 1 },
      }),
    })
    assert.equal(pipelineDenied.status, 403)
    assert.equal(pipelineDenied.json?.error, 'Tier upgrade required')
    assert.equal(pipelineDenied.json?.capability, 'enable_pipeline_automation')

    // ITEM_FUNDING: deny non-admin tier.
    const itemDenied = await fetchJson(`http://127.0.0.1:${port}/api/crawlers/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        type: 'item_search',
        profile_id: profileId,
        parameters: { item: 'wheelchair ramp' },
      }),
    })
    assert.equal(itemDenied.status, 403)
    assert.equal(itemDenied.json?.error, 'Tier upgrade required')
    assert.equal(itemDenied.json?.capability, 'enable_item_funding')

    // DOCUMENT_AI: deny non-admin tier (LLM invoke path).
    const aiDenied = await fetchJson(`http://127.0.0.1:${port}/api/ai/invoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        prompt: 'Say hello in one sentence.',
      }),
    })
    assert.equal(aiDenied.status, 403)
    assert.equal(aiDenied.json?.error, 'Tier upgrade required')
    assert.equal(aiDenied.json?.capability, 'enable_document_ai')

    // Admin bypass: should be allowed even on low tier.
    const pipelineAdmin = await fetchJson(`http://127.0.0.1:${port}/api/crawlers/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        type: 'pipeline_automation',
        profile_id: profileId,
        parameters: { organization_id: null, limit: 1 },
        force: true,
      }),
    })
    assert.ok([200, 201].includes(pipelineAdmin.status))

    const itemAdmin = await fetchJson(`http://127.0.0.1:${port}/api/crawlers/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        type: 'item_search',
        profile_id: profileId,
        parameters: { item: 'wheelchair ramp' },
        force: true,
      }),
    })
    assert.ok([200, 201].includes(itemAdmin.status))

    const aiAdmin = await fetchJson(`http://127.0.0.1:${port}/api/ai/invoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        prompt: 'Return a JSON object with a single key "ok" set to true.',
        response_json_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      }),
    })
    // If no AI provider is configured, invoke falls back; JSON schema mode may 502.
    // The critical assertion is that tier gating did not block admin (no 403).
    assert.notEqual(aiAdmin.status, 403)
  } finally {
    await srv.stop()
  }
})

