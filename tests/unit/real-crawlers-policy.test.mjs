// CUTOVER (Crawler OS): this file exercises the legacy crawler route/engine that
// is now a retired OS-compatibility no-op (backend/services/crawlerOsCompatibility.js). The
// discovery/matching invariants it checked are owned + tested by the Crawler OS
// (backend/crawler-os/tests, 149 tests). Skipped pending a re-point to the OS pipeline.

/**
 * Integration-style tests: real-crawlers pipeline drops forbidden opps (loan, matching funds, no URL)
 * and enforces min_match_score. Seed DB with mixed opportunities; run crawler; assert only policy-compliant returned.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { startBackend, stopProcess } from '../helpers/backendHarness.mjs'

async function startServer(extraEnv = {}) {
  const started = await startBackend({
    rootDir: path.resolve('.'),
    envOverrides: {
      LIVE_CRAWL_TIMEOUT_MS: '1',
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
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

test.skip('real-crawlers: DB fallback excludes loan, matching_funds, missing URL; returns only valid grant', async () => {
  const srv = await startServer({ LIVE_CRAWL_TIMEOUT_MS: '1' })
  const { port } = srv
  const email = 'policy@example.com'
  const userId = '10000000-0000-0000-0000-000000000001'
  const credId = '10000000-0000-0000-0000-000000000002'
  const orgId = '10000000-0000-0000-0000-000000000003'
  const profileId = '10000000-0000-0000-0000-000000000004'

  const Database = (await import('better-sqlite3')).default
  const db = new Database(srv.dbPath)
  db.exec(`
    INSERT INTO users (id, display_name, primary_email, is_admin) VALUES ('${userId}', 'u', '${email}', 0);
    INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count) VALUES ('${credId}', '${userId}', 'email_otp', '${email}', 0);
    INSERT INTO organizations (id, name, city, state, zip) VALUES ('${orgId}', 'Org', 'Nashville', 'TN', '37209');
    INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags) VALUES ('${profileId}', '${userId}', '${orgId}', 'P', 'individual_need', 'active', '[]');
    INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES ('${profileId}', 'basic_information', '{"city":"Nashville","state":"TN","zip":"37209"}', 'test');
  `)
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const cols = 'id, title, sponsor, source, source_id, source_url, description, application_url, is_national, state, categories, keywords, eligibility_bullets, opportunity_type, deadline_type, is_active, record_origin, created_at, updated_at'
  db.exec(`
    INSERT INTO funding_opportunities (${cols}) VALUES
    ('p001', 'Valid Federal Grant', 'US DOE', 'government_funding', 'g1', 'https://www.grants.gov/real', 'Real grant', 'https://www.grants.gov/real', 1, 'TN', '[]', '[]', '[]', 'grant', 'rolling', 1, 'curated_verified', '${now}', '${now}'),
    ('p002', 'Loan Program', 'Bank', 'government_funding', 'g2', 'https://sba.gov/loan', 'Microloan', 'https://sba.gov/loan', 1, 'TN', '[]', '[]', '[]', 'loan', 'rolling', 1, 'curated_verified', '${now}', '${now}'),
    ('p003', 'Match Required Grant', 'State', 'government_funding', 'g3', 'https://state.gov/match', 'Dollar-for-dollar match required', 'https://state.gov/match', 0, 'TN', '[]', '[]', '[]', 'grant', 'rolling', 1, 'curated_verified', '${now}', '${now}'),
    ('p004', 'No URL Grant', 'Unknown', 'government_funding', 'g4', '', 'No URL', '', 0, 'TN', '[]', '[]', '[]', 'grant', 'rolling', 1, 'curated_verified', '${now}', '${now}');
  `)
  db.prepare(`UPDATE funding_opportunities SET requires_match = 1, match_percentage = 50 WHERE id = 'p003'`).run()
  db.close()

  const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, { method: 'POST', body: JSON.stringify({ email }) })
  assert.equal(start.status, 202)
  const verify = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/verify`, {
    method: 'POST',
    body: JSON.stringify({ email, code: start.json.previewCode, verification_token: start.json.verification_token }),
  })
  assert.equal(verify.status, 200)
  assert.ok(verify.json?.accessToken)

  const run = await fetchJson(`http://127.0.0.1:${port}/api/real-crawlers/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${verify.json.accessToken}` },
    body: JSON.stringify({ crawler_type: 'government_funding', profile_id: profileId, min_match_score: 0 }),
  })
  await srv.stop()

  assert.equal(run.status, 200)
  assert.ok(Array.isArray(run.json?.opportunities))
  const opps = run.json.opportunities
  const titles = opps.map((o) => o?.title)
  assert.ok(!titles.includes('Loan Program'), 'loan must not be returned')
  assert.ok(!titles.includes('Match Required Grant'), 'matching-funds must not be returned')
  assert.ok(!titles.includes('No URL Grant'), 'missing URL must not be returned')
  assert.ok(opps.every((o) => (o?.url || o?.application_url || o?.source_url || '').startsWith('http')), 'all returned must have real URL')
  assert.ok(opps.every((o) => String(o?.opportunity_type || '').toLowerCase() !== 'loan'), 'no loan type in results')
  assert.ok(
    opps.every((o) => typeof o.match_score === 'number' || typeof o.score === 'number'),
    'all returned opportunities must carry a numeric match score (Goal 8)'
  )
  assert.ok(
    opps.every((o) => o.match_decision || o.decision),
    'all returned opportunities must carry a match_decision field (Goal 8)'
  )
  assert.ok(opps.length > 0, 'curated pipeline should return at least one policy-compliant opportunity for an individual_need profile in TN')
  assert.ok(titles.includes('Valid Federal Grant'), 'the single valid seed grant must appear in results')
})

test.skip('real-crawlers: min_match_score threshold enforced', async () => {
  const srv = await startServer({ LIVE_CRAWL_TIMEOUT_MS: '1' })
  const { port } = srv
  const email = 'score@example.com'
  const userId = '20000000-0000-0000-0000-000000000001'
  const credId = '20000000-0000-0000-0000-000000000002'
  const orgId = '20000000-0000-0000-0000-000000000003'
  const profileId = '20000000-0000-0000-0000-000000000004'

  const Database = (await import('better-sqlite3')).default
  const db = new Database(srv.dbPath)
  db.exec(`
    INSERT INTO users (id, display_name, primary_email, is_admin) VALUES ('${userId}', 'u', '${email}', 0);
    INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count) VALUES ('${credId}', '${userId}', 'email_otp', '${email}', 0);
    INSERT INTO organizations (id, name, city, state, zip) VALUES ('${orgId}', 'Org', 'Nashville', 'TN', '37209');
    INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, status, tags) VALUES ('${profileId}', '${userId}', '${orgId}', 'P', 'individual_need', 'active', '[]');
    INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES ('${profileId}', 'basic_information', '{"city":"Nashville","state":"TN","zip":"37209"}', 'test');
  `)
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  db.exec(`
    INSERT INTO funding_opportunities (id, title, sponsor, source, source_id, source_url, description, application_url, is_national, state, categories, keywords, eligibility_bullets, opportunity_type, deadline_type, is_active, record_origin, created_at, updated_at)
    VALUES ('s1', 'State Grant TN', 'State', 'government_funding', 'sg1', 'https://tn.gov/grant', 'Grant', 'https://tn.gov/grant', 0, 'TN', '[]', '[]', '[]', 'grant', 'rolling', 1, 'curated_verified', '${now}', '${now}');
  `)
  db.close()

  const start = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/start`, { method: 'POST', body: JSON.stringify({ email }) })
  assert.equal(start.status, 202)
  const verify = await fetchJson(`http://127.0.0.1:${port}/api/auth/email/verify`, {
    method: 'POST',
    body: JSON.stringify({ email, code: start.json.previewCode, verification_token: start.json.verification_token }),
  })
  assert.equal(verify.status, 200)

  const run = await fetchJson(`http://127.0.0.1:${port}/api/real-crawlers/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${verify.json.accessToken}` },
    body: JSON.stringify({ crawler_type: 'government_funding', profile_id: profileId, min_match_score: 80 }),
  })
  await srv.stop()

  assert.equal(run.status, 200)
  assert.strictEqual(run.json?.min_match_score, 80)
  const opps = run.json?.opportunities ?? []
  assert.ok(Array.isArray(opps))
  assert.ok(opps.every((o) => typeof o.match_score === 'number'), 'all returned must have numeric match_score')
  // A requested threshold is a ranking preference, not an exact-match gate.
  // If enforcing it would create a zero-result experience, the API must return
  // best-available reviewable results and explain the relaxation.
  if (opps.length > 0) {
    assert.ok(run.json?.threshold_fallback_message || opps.every((o) => o.match_score >= 80))
  }
})
