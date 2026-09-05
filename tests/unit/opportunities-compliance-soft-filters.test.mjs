import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { startBackend, stopProcess } from '../helpers/backendHarness.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..', '..')

async function apiFetch(url, { method = 'GET', token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => null)
  return { res, json }
}

test('grant_only does not exclude matching-funds grants (but still excludes loans)', async () => {
  const { proc, port, adminToken } = await startBackend({ rootDir: repoRoot })
  try {
    const base = `http://127.0.0.1:${port}`
    const verifiedAt = new Date().toISOString()

    // These rows intentionally carry current successful link proof so this test
    // isolates the compliance filter instead of being satisfied or defeated by
    // the independent fail-closed direct-link visibility gate.

    // 1) Create a match-required grant (should remain visible in grant_only).
    // Title must not match placeholder patterns (/^(test|sample|...)/i) and
    // application_url is required, otherwise filterActionableOpportunities strips it.
    const matchUrl = 'https://example.test/match-grant'
    const matchOpp = await apiFetch(`${base}/api/opportunities`, {
      method: 'POST',
      token: adminToken,
      body: {
        title: 'Community Resilience Matching Grant Program',
        sponsor: 'Unit Test Sponsor',
        source: 'unit_test',
        application_url: matchUrl,
        opportunity_type: 'grant',
        requires_match: true,
        match_percentage: 25,
        is_active: true,
        is_national: true,
        state: 'nationwide',
        deadline: '2030-01-13',
        deadline_type: 'fixed',
        link_status: 'verified',
        last_verified_at: verifiedAt,
        final_url: matchUrl,
        verification_method: 'unit_test_fixture',
        verified_by: 'unit_test_fixture',
      },
    })
    assert.equal(matchOpp.res.status, 201)
    const matchId = matchOpp.json?.id
    assert.ok(matchId)

    // 2) Create a loan (should be excluded in grant_only). Give it the same
    // valid link-proof posture so its absence can only come from compliance.
    const loanUrl = 'https://example.test/loan-program'
    const loanOpp = await apiFetch(`${base}/api/opportunities`, {
      method: 'POST',
      token: adminToken,
      body: {
        title: 'Small Business Revolving Loan Program',
        sponsor: 'Unit Test Sponsor',
        source: 'unit_test',
        application_url: loanUrl,
        opportunity_type: 'loan',
        is_active: true,
        is_national: true,
        state: 'nationwide',
        deadline: '2030-01-13',
        deadline_type: 'fixed',
        link_status: 'verified',
        last_verified_at: verifiedAt,
        final_url: loanUrl,
        verification_method: 'unit_test_fixture',
        verified_by: 'unit_test_fixture',
      },
    })
    assert.equal(loanOpp.res.status, 201)
    const loanId = loanOpp.json?.id
    assert.ok(loanId)

    // 3) Query grant_only: must include match-required, must exclude loan.
    const list = await apiFetch(`${base}/api/opportunities?compliance=grant_only&limit=500&offset=0`, {
      token: adminToken,
    })
    assert.equal(list.res.status, 200)
    const rows = Array.isArray(list.json?.data) ? list.json.data : []
    const ids = new Set(rows.map((r) => r?.id).filter(Boolean))
    assert.ok(ids.has(matchId), 'match-required grant should be present under grant_only')
    assert.ok(!ids.has(loanId), 'loan should be excluded under grant_only')
  } finally {
    await stopProcess(proc)
  }
})
