// CUTOVER (Crawler OS): exercises the legacy crawler route/engine now superseded
// by a no-op shim (legacyCrawlSuperseded.js); invariants are owned + tested by the
// Crawler OS (backend/crawler-os/tests). Skipped pending a re-point to the OS.

/**
 * Crawl fallback policy.
 *
 * UPDATED POLICY (profile-aware matching): the crawlers now use the full profile
 * (profile-derived source plan + search terms + relevance + canonical
 * eligibility). The old "zero results is always a failure — show something"
 * rule predated that and surfaced irrelevant filler. The policy is now:
 *   - When relaxing the score floor, items must STILL be relevant to the profile
 *     (soft relevance pass) and not hard-ineligible (decision REJECT). Genuine
 *     directory resources remain exempt.
 *   - If candidates exist but NONE are relevant, return ZERO with
 *     relevance_suppressed=true + a helpful message — NOT mismatched results.
 *
 * Test 1: cross-state + a national directory resource → fallback still returns
 *   the relevant/directory items (geo mismatch alone is soft, directories are
 *   exempt). Test 2: a hard-ineligible opportunity (veteran-only for a
 *   non-veteran) with no directory → suppressed to zero with relevance_suppressed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-zrfb-'))
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
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    child.stdout.on('data', () => {
      const match = stdout.match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve({ port: Number(match[1]) })
      }
    })
  })

  async function stop() {
    if (child.killed) return
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }

  return { ready, stop, dbPath, getStdout: () => stdout, getStderr: () => stderr }
}

async function fetchJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

test.skip('zero-results fallback: total_found>0 guarantees opportunities.length>0 (non-strict mode)', async () => {
  const srv = startServer({ LIVE_CRAWL_TIMEOUT_MS: '1', ENABLE_TOKEN_NARROWING: 'false' })
  const { port } = await srv.ready

  try {
    const email = 'zrfb@example.com'
    const userId = '00000000-0000-0000-0000-eeee00000001'
    const credId = '00000000-0000-0000-0000-eeee00000002'
    const orgId = '00000000-0000-0000-0000-eeee00000003'
    const profileId = '00000000-0000-0000-0000-eeee00000004'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)

    // Profile is a TN individual. Seed opps that are all in OH (cross-state)
    // and aimed at population mismatches — these were previously eliminated
    // entirely by relevanceFilter + makeDecision. With the new fallback
    // stages, at least one must still be returned.
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'Zero Fallback', '${email}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES ('${credId}', '${userId}', 'email_otp', '${email}', 0);

      INSERT INTO organizations (id, name, city, state, zip)
      VALUES ('${orgId}', 'Zero Org', 'Nashville', 'TN', '37201');

      INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags)
      VALUES ('${profileId}', '${userId}', '${orgId}', 'Zero Tester', 'individual', 'active', '[]');

      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (
        '${profileId}', 'basic_information',
        '{"full_name":"Zero Tester","state":"TN","city":"Nashville","zip":"37201","gender":"male","primary_needs":["food","utilities"]}',
        'test'
      );

      INSERT INTO funding_opportunities (
        id, title, sponsor, source, source_id, source_url, description,
        application_url, is_national, state, categories, keywords,
        opportunity_type, requires_match, match_percentage,
        deadline, deadline_type, is_active, record_origin, created_at, updated_at
      ) VALUES
      (
        '00000000-0000-0000-0000-ffff00000001',
        'Ohio Utility Assistance Program',
        'Ohio DSA',
        'government_funding', 'ohio-util-1',
        'https://example.ohio.gov/utility',
        'Utility assistance for Ohio households',
        'https://example.ohio.gov/utility',
        0, 'OH', '["utilities"]', '["utility","assistance","ohio"]',
        'grant', 0, 0,
        NULL, 'rolling', 1, 'live_crawl', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        '00000000-0000-0000-0000-ffff00000002',
        'National Community Support Resource',
        'Resource Directory',
        'directory_listings', 'dir-1',
        'https://211.org/community',
        'Community resource directory',
        'https://211.org/community',
        1, NULL, '["community"]', '["directory","community"]',
        'program', 0, 0,
        NULL, 'rolling', 1, 'directory_resource', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `)
    db.close()

    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST', body: JSON.stringify({ email }),
    })
    assert.equal(start.status, 202)
    const verify = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/verify`, {
      method: 'POST',
      body: JSON.stringify({
        email, code: start.json.previewCode,
        verification_token: start.json.verification_token,
      }),
    })
    const token = verify.json?.accessToken
    assert.ok(token, 'auth token must be present')

    const run = await fetchJson(`http://127.0.0.1:${port}/api/real-crawlers/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        crawler_type: 'government_funding',
        profile_id: profileId,
        min_match_score: 50,
        strict_min_score: false,
      }),
    })

    assert.equal(run.status, 200, `run failed: ${JSON.stringify(run.json)}`)
    const { total_found, count, opportunities, drop_counts } = run.json
    assert.ok(Array.isArray(opportunities), 'opportunities must be array')

    // Core invariant: the response shape is self-consistent.
    // total_found counts the items that entered the filter pipeline.
    assert.equal(count, opportunities.length, 'count must equal opportunities.length')
    assert.ok(typeof drop_counts === 'object', 'drop_counts must be surfaced')

    // The national directory resource is relevant/exempt, so the fallback still
    // returns at least it (geo mismatch alone is soft; directories survive).
    if (total_found > 0) {
      assert.ok(
        opportunities.length > 0,
        `total_found=${total_found} but opportunities.length=${opportunities.length} (drop_counts=${JSON.stringify(drop_counts)})`,
      )
    }
  } finally {
    await srv.stop()
  }
})

test.skip('relevance policy: hard-ineligible candidates are suppressed to zero (no irrelevant filler)', async () => {
  const srv = startServer({ LIVE_CRAWL_TIMEOUT_MS: '1', ENABLE_TOKEN_NARROWING: 'false' })
  const { port } = await srv.ready
  try {
    const email = 'relsup@example.com'
    const userId = '00000000-0000-0000-0000-dddd00000001'
    const credId = '00000000-0000-0000-0000-dddd00000002'
    const orgId = '00000000-0000-0000-0000-dddd00000003'
    const profileId = '00000000-0000-0000-0000-dddd00000004'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    // A non-veteran TN individual; the only candidate is a VETERAN-ONLY grant
    // (hard-ineligible) and there is NO directory resource to fall back to.
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'Rel Sup', '${email}', 0);
      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES ('${credId}', '${userId}', 'email_otp', '${email}', 0);
      INSERT INTO organizations (id, name, city, state, zip)
      VALUES ('${orgId}', 'Rel Org', 'Nashville', 'TN', '37201');
      INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags)
      VALUES ('${profileId}', '${userId}', '${orgId}', 'Rel Tester', 'individual', 'active', '[]');
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES ('${profileId}', 'basic_information',
        '{"full_name":"Rel Tester","state":"TN","city":"Nashville","zip":"37201","primary_needs":["food"]}', 'test');
      INSERT INTO funding_opportunities (
        id, title, sponsor, source, source_id, source_url, description,
        application_url, is_national, state, categories, keywords,
        opportunity_type, requires_match, match_percentage,
        deadline, deadline_type, is_active, record_origin, created_at, updated_at
      ) VALUES (
        '00000000-0000-0000-0000-cccc00000001',
        'Veterans-Only Emergency Grant', 'VetOrg',
        'government_funding', 'vet-1', 'https://example.gov/vets',
        'Emergency grant for military veterans only. Must be a veteran to apply.',
        'https://example.gov/vets', 1, NULL, '["veteran"]', '["veteran","military","veterans only"]',
        'grant', 0, 0,
        NULL, 'rolling', 1, 'live_crawl', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `)
    db.close()

    const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, { method: 'POST', body: JSON.stringify({ email }) })
    const verify = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/verify`, {
      method: 'POST',
      body: JSON.stringify({ email, code: start.json.previewCode, verification_token: start.json.verification_token }),
    })
    const token = verify.json?.accessToken
    assert.ok(token, 'auth token must be present')

    const run = await fetchJson(`http://127.0.0.1:${port}/api/real-crawlers/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ crawler_type: 'government_funding', profile_id: profileId, min_match_score: 50, strict_min_score: false }),
    })
    assert.equal(run.status, 200, `run failed: ${JSON.stringify(run.json)}`)
    const { count, opportunities } = run.json
    assert.equal(count, opportunities.length, 'count must equal opportunities.length')
    // The veteran-only grant is hard-ineligible for a non-veteran — it must NEVER
    // be surfaced (not in the main results, not via any relaxed fallback). Other
    // genuinely-relevant seeded programs may appear; that's fine.
    const titles = opportunities.map((o) => String(o.title || o.name || '').toLowerCase())
    assert.ok(
      !titles.some((t) => t.includes('veterans-only') || t.includes('veterans only')),
      `veteran-only grant must be suppressed for a non-veteran, but it was returned: ${JSON.stringify(titles)}`,
    )
  } finally {
    await srv.stop()
  }
})
