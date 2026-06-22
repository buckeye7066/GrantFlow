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

function assertValidHttpUrl(url) {
  assert.equal(typeof url, 'string')
  assert.ok(url.startsWith('http://') || url.startsWith('https://'), `expected http(s) url, got: ${url}`)
  assert.ok(url.length >= 8 && url.length <= 2048, 'url length out of range')
  assert.ok(!url.includes('example.com') && !url.includes('example.org'), `no placeholder urls: ${url}`)
}

test.skip('real crawler: health_resources respects consent gating for trials', async () => {
  const srv = await startServer()
  const { port } = srv

  try {
    const email = 'healthcrawler@example.com'
    const secondEmail = 'healthcrawler-noconsent@example.com'
    const userId = '00000000-0000-0000-0000-00000000bb01'
    const secondUserId = '00000000-0000-0000-0000-00000000bb06'
    const credentialId = '00000000-0000-0000-0000-00000000bb02'
    const secondCredentialId = '00000000-0000-0000-0000-00000000bb07'
    const orgId = '00000000-0000-0000-0000-00000000bb03'
    const profileWithConsent = '00000000-0000-0000-0000-00000000bb04'
    const profileNoConsent = '00000000-0000-0000-0000-00000000bb05'

    const Database = (await import('better-sqlite3')).default
    const db = new Database(srv.dbPath)
    db.exec(`
      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${userId}', 'healthcrawler', '${email}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES ('${credentialId}', '${userId}', 'email_otp', '${email}', 0);

      INSERT INTO users (id, display_name, primary_email, is_admin)
      VALUES ('${secondUserId}', 'healthcrawler-noconsent', '${secondEmail}', 0);

      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES ('${secondCredentialId}', '${secondUserId}', 'email_otp', '${secondEmail}', 0);

      INSERT INTO organizations (id, name, city, state, zip)
      VALUES ('${orgId}', 'Test Org', 'Nashville', 'TN', '37209');

      INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags)
      VALUES ('${profileWithConsent}', '${userId}', '${orgId}', 'Health Profile (consent)', 'individual_need', 'active', '["health"]');

      INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags)
      VALUES ('${profileNoConsent}', '${secondUserId}', '${orgId}', 'Health Profile (no consent)', 'individual_need', 'active', '["health"]');

      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (
        '${profileWithConsent}',
        'basic_information',
        '{"full_name":"Health Profile","address":"123 Main\\nNashville, TN 37209","state":"TN","zip":"37209"}',
        'test'
      );
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (
        '${profileWithConsent}',
        'health_medical',
        '{"conditions":[{"name":"Epilepsy"}],"support_needs":["transportation","copay_assistance"],"consent_for_studies":true,"chronic_illness":true,"chronic_illness_type":"Epilepsy","disability_type":["neurological"]}',
        'test'
      );

      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (
        '${profileNoConsent}',
        'basic_information',
        '{"full_name":"Health Profile","address":"123 Main\\nNashville, TN 37209","state":"TN","zip":"37209"}',
        'test'
      );
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (
        '${profileNoConsent}',
        'health_medical',
        '{"conditions":[{"name":"Epilepsy"}],"support_needs":["transportation"],"consent_for_studies":false,"chronic_illness":true,"chronic_illness_type":"Epilepsy"}',
        'test'
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

    const secondStart = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, {
      method: 'POST',
      body: JSON.stringify({ email: secondEmail }),
    })
    assert.equal(secondStart.status, 202)

    const secondVerify = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/verify`, {
      method: 'POST',
      body: JSON.stringify({
        email: secondEmail,
        code: secondStart.json.previewCode,
        verification_token: secondStart.json.verification_token,
      }),
    })
    assert.equal(secondVerify.status, 200)
    assert.ok(secondVerify.json?.accessToken)

    const runConsent = await fetchJson(`http://127.0.0.1:${port}/api/real-crawlers/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verify.json.accessToken}`,
      },
      body: JSON.stringify({
        crawler_type: 'health_resources',
        profile_id: profileWithConsent,
        min_match_score: 50,
      }),
    })
    assert.equal(runConsent.status, 200)
    assert.equal(runConsent.json?.success, true)
    assert.ok(Array.isArray(runConsent.json?.opportunities))
    assert.ok(runConsent.json.opportunities.length > 0)
    runConsent.json.opportunities.forEach((o) => {
      const url = o.url ?? o.source_url ?? o.application_url
      assertValidHttpUrl(url)
      assert.ok(typeof o.match_score === 'number')
      assert.ok(o.match_score >= 0 && o.match_score <= 100)
      assert.notEqual(String(o.opportunity_type || '').toLowerCase(), 'loan')
    })
    assert.ok(
      runConsent.json.opportunities.some((o) => {
        const cats = Array.isArray(o.categories) ? o.categories.join(',').toLowerCase() : ''
        const title = (o.title || o.name || '').toLowerCase()
        return cats.includes('health') || title.includes('health') || title.includes('medic')
      }),
      'expected at least one health-related opportunity when consent is true',
    )

    const runNoConsent = await fetchJson(`http://127.0.0.1:${port}/api/real-crawlers/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secondVerify.json.accessToken}`,
      },
      body: JSON.stringify({
        crawler_type: 'health_resources',
        profile_id: profileNoConsent,
        min_match_score: 50,
      }),
    })
    assert.equal(runNoConsent.status, 200)
    assert.equal(runNoConsent.json?.success, true)
    assert.ok(Array.isArray(runNoConsent.json?.opportunities))
    assert.ok(runNoConsent.json.opportunities.length > 0)
    assert.ok(
      runNoConsent.json.opportunities.every((o) => !String(o.url || o.source_url || '').includes('clinicaltrials.gov')),
      'expected no clinicaltrials.gov links when consent is false',
    )
  } finally {
    await srv.stop()
  }
})
