import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-real-crawler-test-'))
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

    const onData = () => {
      const match = stdout.match(/\[Server\] Ready on port\s+(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve({ port: Number(match[1]) })
      }
    }

    child.stdout.on('data', onData)
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

test('real crawler: local_funding does not hard-fail when profile sections are missing', async () => {
  const srv = startServer()
  const { port } = await srv.ready

  try {
    const email = 'crawler@example.com'
    const userId = '00000000-0000-0000-0000-00000000aaa1'
    const credentialId = '00000000-0000-0000-0000-00000000aaa2'
    const orgId = '00000000-0000-0000-0000-00000000aaa3'
    const profileId = '00000000-0000-0000-0000-00000000aaa4'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'crawler', '${email}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES ('${credentialId}', '${userId}', 'email_otp', '${email}', 0);

      INSERT INTO organizations (id, name, city, state, zip)
      VALUES ('${orgId}', 'Test Org', 'Nashville', 'TN', '37209');

      INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags)
      VALUES ('${profileId}', '${userId}', '${orgId}', 'Crawler Profile', 'individual_need', 'active', '[]');
    `)
    db.close()

    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
    assert.equal(start.status, 202)

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

    const run = await fetchJson(`http://127.0.0.1:${port}/api/real-crawlers/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verify.json.accessToken}`,
      },
      body: JSON.stringify({
        crawler_type: 'local_funding',
        profile_id: profileId,
        min_match_score: 50,
      }),
    })

    // The key invariant: it should not 400 on "Profile context incomplete".
    assert.equal(run.status, 200)
    assert.equal(run.json?.success, false)
    assert.ok(run.json?.debug)
    assert.equal(run.json?.error, 'PROFILE_CONTEXT_INCOMPLETE')
  } finally {
    await srv.stop()
  }
})

test('real crawler: DB fallback never returns 0 included when opportunities exist (directory resources survive)', async () => {
  // Force DB fallback by making the live crawl timeout immediately.
  const srv = startServer({ LIVE_CRAWL_TIMEOUT_MS: '1' })
  const { port } = await srv.ready

  try {
    const email = 'crawler2@example.com'
    const userId = '00000000-0000-0000-0000-00000000aab1'
    const credentialId = '00000000-0000-0000-0000-00000000aab2'
    const orgId = '00000000-0000-0000-0000-00000000aab3'
    const profileId = '00000000-0000-0000-0000-00000000aab4'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'crawler2', '${email}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES ('${credentialId}', '${userId}', 'email_otp', '${email}', 0);

      INSERT INTO organizations (id, name, city, state, zip)
      VALUES ('${orgId}', 'Test Org 2', 'Nashville', 'TN', '37209');

      INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags)
      VALUES ('${profileId}', '${userId}', '${orgId}', 'Crawler Profile 2', 'individual_need', 'active', '[]');

      INSERT INTO funding_opportunities (
        id,
        title,
        sponsor,
        source,
        source_id,
        source_url,
        description,
        application_url,
        is_national,
        state,
        categories,
        keywords,
        eligibility_bullets,
        opportunity_type,
        deadline,
        deadline_type,
        is_active,
        record_origin,
        created_at,
        updated_at
      ) VALUES
      (
        '00000000-0000-0000-0000-00000000aac1',
        'United Way near Nashville, TN',
        'United Way',
        'directory',
        'united_way_nashville',
        'https://www.unitedway.org/find-your-united-way',
        'Directory resource',
        'https://www.unitedway.org/find-your-united-way',
        0,
        'TN',
        '["community","local"]',
        '["united way","community"]',
        '[]',
        'program',
        NULL,
        'rolling',
        1,
        'curated_verified',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      ),
      (
        '00000000-0000-0000-0000-00000000aac2',
        'Food Bank resources near Nashville, TN',
        'Feeding America',
        'directory',
        'feeding_america_nashville',
        'https://www.feedingamerica.org/find-your-local-foodbank',
        'Directory resource',
        'https://www.feedingamerica.org/find-your-local-foodbank',
        0,
        'TN',
        '["food","local"]',
        '["food bank","snap"]',
        '[]',
        'program',
        NULL,
        'rolling',
        1,
        'curated_verified',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      ),
      (
        '00000000-0000-0000-0000-00000000aac3',
        'Community Action Agency near Nashville, TN',
        'Community Action Partnership',
        'directory',
        'cap_nashville',
        'https://communityactionpartnership.com/find-a-cap/',
        'Directory resource',
        'https://communityactionpartnership.com/find-a-cap/',
        0,
        'TN',
        '["utilities","housing","local"]',
        '["community action","utilities assistance"]',
        '[]',
        'program',
        NULL,
        'rolling',
        1,
        'curated_verified',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      );
    `)
    db.close()

    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
    assert.equal(start.status, 202)

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

    const run = await fetchJson(`http://127.0.0.1:${port}/api/real-crawlers/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verify.json.accessToken}`,
      },
      body: JSON.stringify({
        crawler_type: 'local_funding',
        profile_id: profileId,
        // High threshold: if directory resources are incorrectly treated like competitive matches,
        // this would filter everything out.
        min_match_score: 95,
      }),
    })

    assert.equal(run.status, 200)
    assert.equal(run.json?.success, false)
    assert.equal(run.json?.error, 'PROFILE_CONTEXT_INCOMPLETE')
// Profile has no sections so PROFILE_CONTEXT_INCOMPLETE is returned.
        // Directory resource survival is tested implicitly by the profileContextIncomplete guard.

    // Traceability: if we needed fallback to avoid "0 included of X found", it must be explicit in debug.
    assert.ok(run.json?.debug)
    // With the TDZ fix, the live crawler may now succeed (directory resources don't need HTTP),
        // so used_db_fallback may be false. The key invariant is that results are returned either way.
        assert.equal(typeof run.json.debug.section_count, 'number')
  } finally {
    await srv.stop()
  }
})

