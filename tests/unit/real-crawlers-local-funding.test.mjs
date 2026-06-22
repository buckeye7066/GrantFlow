// CUTOVER (Crawler OS): exercises the legacy crawler route/engine now superseded
// by a no-op shim (legacyCrawlSuperseded.js); invariants are owned + tested by the
// Crawler OS (backend/crawler-os/tests). Skipped pending a re-point to the OS.

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { startBackend, stopProcess } from '../helpers/backendHarness.mjs'

async function startServer(extraEnv = {}) {
  const started = await startBackend({
    rootDir: path.resolve('.'),
    envOverrides: extraEnv,
  })

  return {
    port: started.port,
    dbPath: path.join(started.tempDir, 'grantflow-test.db'),
    stop: async () => stopProcess(started.proc),
  }
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

test.skip('real crawler: local_funding runs with minimal profile (sparse context allowed for directory + DB fallback)', async () => {
  const srv = await startServer()
  const { port } = srv

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

    // Sparse/minimal profile is allowed: run proceeds for directory + DB fallback (no 400).
    assert.equal(run.status, 200)
    assert.ok(Array.isArray(run.json?.opportunities))
    assert.ok(typeof run.json?.total_found === 'number')
  } finally {
    await srv.stop()
  }
})

test.skip('real crawler: DB fallback never returns 0 included when opportunities exist (directory resources survive)', async () => {
  // Force DB fallback by making the live crawl timeout immediately.
  // Disable token narrowing so seeded directory opportunities are not filtered out by profile tokens.
  const srv = await startServer({ LIVE_CRAWL_TIMEOUT_MS: '1', ENABLE_TOKEN_NARROWING: 'false' })
  const { port } = srv

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

      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (
        '${profileId}',
        'basic_information',
        '{"full_name":"Crawler Profile 2","profile_category":"individual_need","city":"Nashville","state":"TN","zip":"37209"}',
        'test'
      );
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (
        '${profileId}',
        'narrative',
        '{"primary_goal":"Need local food and utility assistance","target_population":"household in need","geographic_focus":"Nashville"}',
        'test'
      );

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

    assert.equal(run.status, 200, run.json?.error ? `run error: ${run.json.error}` : '')
    assert.equal(run.json?.success, true, run.json?.message ? `run message: ${run.json.message}` : '')
    assert.ok(Array.isArray(run.json?.opportunities), 'opportunities must be array')
    assert.ok((run.json?.total_found ?? 0) > 0, `expected total_found > 0, got ${run.json?.total_found}`)
    assert.ok((run.json?.count ?? 0) > 0, `expected count > 0, got ${run.json?.count}`)
    assert.equal(run.json.count, run.json.filtered_count, `count (${run.json?.count}) should equal filtered_count (${run.json?.filtered_count})`)
    assert.ok(
      run.json.opportunities.every((opp) => typeof opp.match_score === 'number' && opp.match_score >= 0),
      'all returned opportunities should have numeric match_score',
    )
    assert.ok(
      run.json.opportunities.some(
        (opp) =>
          opp.is_directory_resource === true ||
          String(opp.opportunity_type || '').toLowerCase() === 'program' ||
          String(opp.record_origin || '').toLowerCase().includes('directory') ||
          String(opp.record_origin || '').toLowerCase().includes('curated'),
      ),
      'expected at least one directory-style opportunity to survive filtering',
    )
  } finally {
    await srv.stop()
  }
})
