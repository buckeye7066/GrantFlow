/**
 * Release gate: verify local_funding crawler returns directory resources.
 *
 * Boots a test server, authenticates, runs the local_funding crawler,
 * and asserts that at least one result survives filtering.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'gf-local-funding-'))
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
      // MIGRATE_ON_BOOT must be set EXPLICITLY here, and DB_AUTO_MIGRATE is not
      // a substitute for it: the two flags control different things
      // (backend/startup/bootPolicy.js). DB_AUTO_MIGRATE only applies
      // backend/db/schema.sql; the numbered migrations are gated by
      // shouldMigrateOnBoot, which returns `!smoke`.
      //
      // This gate's own env — PORT=0 + DB_AUTO_MIGRATE=true + NODE_ENV
      // != production — is precisely the pattern isSmokeMode() INFERS as smoke,
      // so asking for auto-migrate is what turned the migration runner OFF. The
      // server then came up with schema.sql only, which does not declare
      // profile_opportunity_matches (schema.sql is a partial declaration; ~160
      // migrations layer on it), and the crawler failed with
      // "no such table: profile_opportunity_matches".
      //
      // isExplicitOptIn(MIGRATE_ON_BOOT) is checked BEFORE the smoke inference,
      // so this restores the full migrated schema the crawler actually needs.
      MIGRATE_ON_BOOT: 'true',
      AUTH_JWT_SECRET: 'test-secret',
      // This is a deterministic DB-fallback gate, not a web-availability test.
      // The fixture below supplies a known directory row; live crawling is
      // intentionally disabled and token narrowing is disabled so the route's
      // fallback/surfacing behavior is what is measured.
      LIVE_CRAWL_TIMEOUT_MS: '1',
      ENABLE_TOKEN_NARROWING: 'false',
      // The server's default request/response timeout (30s) is tuned for
      // user-facing requests. This gate fires a COLD-START local_funding
      // discovery on a fresh DB; on a slow/loaded CI runner that first run can
      // take longer than 30s and trip the response-timeout middleware (504
      // error_type:'timeout') even though it finishes in seconds locally and is
      // otherwise healthy. Give the gate server generous headroom so a cold run
      // isn't cut off. Live network work is disabled above.
      REQUEST_TIMEOUT_MS: '120000',
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
      try { child.kill('SIGTERM') } catch { /* noop */ }
      reject(new Error(`server not ready\n${stdout}\n${stderr}`))
    }, 60_000)
    child.stdout.on('data', () => {
      const m = stdout.match(/\[Server\] Ready on port\s+(\d+)/)
      if (m) { clearTimeout(timeout); resolve({ port: Number(m[1]) }) }
    })
  })
  async function stop() {
    if (!child.killed) child.kill('SIGTERM')
    await new Promise((r) => child.once('exit', r))
  }
  return { ready, stop, dbPath }
}

async function fetchJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function main() {
  const srv = startServer()
  let port
  try {
    ;({ port } = await srv.ready)

    const email = 'localfunding@example.com'
    const userId = '20000000-0000-0000-0000-000000000001'
    const credId = '20000000-0000-0000-0000-000000000002'
    const orgId = '20000000-0000-0000-0000-000000000003'
    const profileId = '20000000-0000-0000-0000-000000000004'
    const opportunityId = '20000000-0000-0000-0000-000000000005'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin) VALUES ('${userId}', 'u', '${email}', 0);
      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count) VALUES ('${credId}', '${userId}', 'email_otp', '${email}', 0);
      INSERT INTO organizations (id, name, city, state, zip) VALUES ('${orgId}', 'Org', 'Columbus', 'OH', '43215');
      INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags) VALUES ('${profileId}', '${userId}', '${orgId}', 'P', 'individual_need', 'active', '[]');
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES ('${profileId}', 'basic_information', '{"city":"Columbus","state":"OH","zip":"43215","primary_needs":["housing","food","utilities"]}', 'test');

      -- Deterministic fallback evidence. Earlier versions disabled live crawling
      -- with a 1 ms timeout but inserted NO catalog opportunity, so the gate's
      -- answer depended on whether unrelated startup/background seeding happened
      -- to finish first. That race produced alternating 32-result and 0-result
      -- runs on identical code. The gate now owns its fixture.
      INSERT INTO funding_opportunities (
        id, title, sponsor, source, source_id, source_url, description,
        application_url, is_national, state, categories, keywords,
        eligibility_bullets, opportunity_type, deadline, deadline_type,
        is_active, record_origin, created_at, updated_at
      ) VALUES (
        '${opportunityId}',
        'Ohio Community Resource Directory',
        'Community Action Partnership',
        'directory',
        'community_action_ohio_fixture',
        'https://communityactionpartnership.com/find-a-cap/',
        'Directory for local housing, food, and utility assistance resources.',
        'https://communityactionpartnership.com/find-a-cap/',
        0,
        'OH',
        '["housing","food","utilities","community"]',
        '["community action","utility assistance","food assistance","housing assistance"]',
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
    if (start.status !== 202) {
      console.error('[gate:discover-local-funding] auth start failed', start.json)
      process.exitCode = 1
      return
    }
    const verify = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/verify`, {
      method: 'POST',
      body: JSON.stringify({ email, code: start.json.previewCode, verification_token: start.json.verification_token }),
    })
    if (verify.status !== 200 || !verify.json?.accessToken) {
      console.error('[gate:discover-local-funding] auth verify failed', verify.json)
      process.exitCode = 1
      return
    }
    const token = verify.json.accessToken

    // The local_funding discovery is a cold-start, first-request run. On a slow /
    // loaded CI runner it can exceed the server's response-timeout middleware and
    // come back as a transient 504. Retry only transport/timeouts; a clean 200
    // with zero results is a real gate failure because the fixture is guaranteed.
    const isTransient = (r) =>
      r.status === 502 ||
      r.status === 503 ||
      r.status === 504 ||
      r.json?.error_type === 'timeout'
    let run
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      run = await fetchJson(`http://127.0.0.1:${port}/api/real-crawlers/run`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          crawler_type: 'local_funding',
          profile_id: profileId,
          min_match_score: 0,
        }),
      })
      if (!isTransient(run)) break
      console.warn(
        `[gate:discover-local-funding] transient ${run.status} (${run.json?.error_type || 'gateway'}) on attempt ${attempt}/3; retrying`,
      )
      await new Promise((r) => setTimeout(r, 2000))
    }

    if (run.status !== 200) {
      console.error('[gate:discover-local-funding] run failed', run.status, run.json)
      process.exitCode = 1
      return
    }

    const json = run.json
    const opportunities = Array.isArray(json.opportunities)
      ? json.opportunities
      : Array.isArray(json.results)
        ? json.results
        : []
    const count = json.count ?? opportunities.length
    const totalFound = json.total_found ?? count

    if (!json.success) {
      console.error('[gate:discover-local-funding] crawler returned success=false', json.error)
      process.exitCode = 1
      return
    }

    console.log(`[gate:discover-local-funding] total_found=${totalFound} count=${count}`)

    if (count === 0 && totalFound === 0) {
      console.error('[gate:discover-local-funding] FAIL: deterministic directory fixture did not survive')
      process.exitCode = 1
      return
    }

    const fixtureReturned = opportunities.some((opp) => String(opp?.id || '') === opportunityId)
    const directoryReturned = opportunities.some((opp) => {
      const source = String(opp?.source || opp?.record_origin || '').toLowerCase()
      const kind = String(opp?.opportunity_kind || opp?.opportunity_type || '').toUpperCase()
      return opp?.is_directory_resource === true || source.includes('directory') || kind === 'DIRECTORY' || kind === 'PROGRAM'
    })
    if (!fixtureReturned && !directoryReturned) {
      console.error('[gate:discover-local-funding] FAIL: results contained no directory-style fallback evidence')
      process.exitCode = 1
      return
    }

    console.log('[gate:discover-local-funding] PASS')
  } catch (err) {
    console.error('[gate:discover-local-funding] ERROR:', err.message)
    process.exitCode = 1
  } finally {
    await srv.stop()
  }
}

main()
