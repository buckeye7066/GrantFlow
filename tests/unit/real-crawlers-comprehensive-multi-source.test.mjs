// CUTOVER (Crawler OS): this file exercises the legacy crawler route/engine that
// is now a retired OS-compatibility no-op (backend/services/crawlerOsCompatibility.js). The
// discovery/matching invariants it checked are owned + tested by the Crawler OS
// (backend/crawler-os/tests, 149 tests). Skipped pending a re-point to the OS pipeline.

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { startBackend, stopProcess } from '../helpers/backendHarness.mjs'

async function startServer(extraEnv = {}) {
  const started = await startBackend({
    rootDir: path.resolve('.'),
    envOverrides: {
      LIVE_CRAWL_TIMEOUT_MS: '1',
      MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK: '999',
      ENABLE_TOKEN_NARROWING: 'false',
      ...extraEnv,
    },
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

test.skip('real crawler: comprehensive returns non-zero results from multiple funding sources', async () => {
  const srv = await startServer({
    LIVE_CRAWL_TIMEOUT_MS: '1',
    MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK: '999',
    ENABLE_TOKEN_NARROWING: 'false',
  })
  const { port } = srv

  try {
    const email = 'comprehensive.crawler@example.com'
    const userId = '00000000-0000-0000-0000-00000000ce01'
    const credentialId = '00000000-0000-0000-0000-00000000ce02'
    const orgId = '00000000-0000-0000-0000-00000000ce03'
    const profileId = '00000000-0000-0000-0000-00000000ce04'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'comprehensive', '${email}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES ('${credentialId}', '${userId}', 'email_otp', '${email}', 0);

      INSERT INTO organizations (id, name, city, state, zip)
      VALUES ('${orgId}', 'Comprehensive Org', 'Nashville', 'TN', '37209');

      INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags)
      VALUES ('${profileId}', '${userId}', '${orgId}', 'Comprehensive Profile', 'individual_need', 'active', '["food","health"]');

      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (
        '${profileId}',
        'basic_information',
        '{"full_name":"Comprehensive Profile","profile_category":"individual_need","city":"Nashville","state":"TN","zip":"37209"}',
        'test'
      );
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (
        '${profileId}',
        'narrative',
        '{"primary_goal":"Need food assistance, utility support, and medical copay help","target_population":"low-income household","geographic_focus":"Nashville TN"}',
        'test'
      );
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (
        '${profileId}',
        'government_assistance',
        '{"snap_recipient":true,"medicaid_enrolled":true}',
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
        '00000000-0000-0000-0000-00000000cf01',
        'Nashville Community Food Assistance Grant',
        'Metro Community Foundation',
        'local_funding',
        'lf-1',
        'https://www.unitedway.org/find-your-united-way',
        'Food assistance and utility support grants for low-income households in Nashville TN',
        'https://www.unitedway.org/find-your-united-way',
        0,
        'TN',
        '["community","food"]',
        '["food assistance","utility support"]',
        '["low-income households"]',
        'program',
        NULL,
        'rolling',
        1,
        'curated_verified',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      ),
      (
        '00000000-0000-0000-0000-00000000cf02',
        'Tennessee Federal Relief and Basic Needs Grant',
        'USDA',
        'government_funding',
        'gov-1',
        'https://www.usda.gov/topics/food-and-nutrition',
        'Federal and state grant support for nutrition and household relief',
        'https://www.usda.gov/topics/food-and-nutrition',
        1,
        'TN',
        '["government","nutrition"]',
        '["federal grant","food assistance"]',
        '["Tennessee residents"]',
        'grant',
        NULL,
        'rolling',
        1,
        'curated_verified',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      ),
      (
        '00000000-0000-0000-0000-00000000cf03',
        'Patient Copay and Medical Assistance Program',
        'NeedyMeds',
        'health_resources',
        'health-1',
        'https://www.needymeds.org',
        'Medical copay assistance and healthcare support for eligible residents',
        'https://www.needymeds.org',
        1,
        'TN',
        '["health","medical"]',
        '["medical assistance","copay"]',
        '["patients"]',
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

    const run = await fetchJson(`http://127.0.0.1:${port}/api/real-crawlers/run?admin=true`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verify.json.accessToken}`,
      },
      body: JSON.stringify({
        crawler_type: 'comprehensive',
        profile_id: profileId,
        min_match_score: 60,
      }),
    })

    assert.equal(run.status, 200, `run status: ${run.status} body: ${JSON.stringify(run.json?.error || run.json?.message || run.json).slice(0, 200)}`)
    assert.equal(run.json?.success, true, `expected success true, got: ${run.json?.success} ${run.json?.error ? `error: ${run.json.error}` : ''}`)
    assert.ok((run.json?.total_found ?? 0) > 0, 'expected total_found > 0')
    assert.ok((run.json?.count ?? 0) > 0, 'expected count > 0')
    assert.ok(Array.isArray(run.json?.opportunities))
    assert.ok(run.json.opportunities.length > 0)

    const distinctSources = new Set(
      run.json.opportunities
        .map((opp) => String(opp.source || opp.crawler_type || '').toLowerCase())
        .filter(Boolean),
    )
    assert.ok(distinctSources.size >= 2, `expected >=2 distinct sources, got ${distinctSources.size}: [${Array.from(distinctSources).join(', ')}]; opportunities: ${run.json.opportunities?.length ?? 0}`)

    assert.ok(run.json?.debug?.analysis, 'debug.analysis should contain profile signals (use ?admin=true)')
    assert.ok(run.json?.debug?.strategy, 'debug.strategy should name the active strategy (use ?admin=true)')
  } finally {
    await srv.stop()
  }
})
