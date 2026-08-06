/**
 * Regression test for POST /api/grants/from-opportunity production bug
 * 
 * This test specifically addresses the production bug where the endpoint returns 500
 * for valid requests that should succeed or return specific 400 errors.
 * 
 * The test MUST:
 * 1. Fail before the fix
 * 2. Pass after the fix
 * 3. Cover both opportunity_id and opportunity_data paths
 * 4. Verify error details are properly propagated to client
 * 5. Test actual production-like scenarios
 */

import test from 'node:test'
import assert from 'node:assert/strict'

test('POST /api/grants/from-opportunity - production bug regression', async (t) => {
  // Note: This test requires a running server with database
  // Run with: NODE_ENV=test npm test tests/integration/grants-from-opportunity.test.mjs
  
  const BASE_URL = process.env.TEST_API_URL || 'http://localhost:3456'
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin'
  
  const makeRequest = async (payload, token = ADMIN_TOKEN) => {
    const response = await fetch(`${BASE_URL}/api/grants/from-opportunity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    })

    let data
    try {
      data = await response.json()
    } catch (e) {
      data = { error: 'invalid_response', message: 'Response was not valid JSON' }
    }
    
    return { response, data, status: response.status }
  }

  await t.test('[CRITICAL] returns 201 for valid opportunity_data, not 500', async () => {
    const { status, data } = await makeRequest({
      profile_id: 'profile-demo-tennessee-stem-student', // Use known profile from seed data
      opportunity_data: {
        title: 'Production Bug Regression Test Grant',
        sponsor: 'Test Foundation',
        deadline: '2026-12-31',
        url: 'https://example.com/regression-test',
        awardMin: 5000,
        awardMax: 25000,
        descriptionMd: 'This tests the production bug fix',
        eligibilityBullets: ['Nonprofits', 'Educational institutions'],
        source: 'regression_test',
      },
    })

    // THIS IS THE CRITICAL ASSERTION - was returning 500 in production
    assert.notEqual(status, 500, `FAILED: Still returning 500! Response: ${JSON.stringify(data)}`)
    assert.ok(status === 200 || status === 201, `Expected 200/201, got ${status}`)
    
    if (status === 201) {
      assert.ok(data.id, 'Should have grant ID')
      assert.equal(data.title, 'Production Bug Regression Test Grant')
    } else if (status === 200) {
      assert.equal(data.already_exists, true, 'Should indicate duplicate')
    }
  })

  await t.test('returns proper error structure (not generic 500)', async () => {
    const { status, data } = await makeRequest({
      // Missing both profile_id and organization_id
      opportunity_data: {
        title: 'Test',
        sponsor: 'Test',
      },
    })

    assert.equal(status, 400, 'Should return 400 for validation error')
    assert.ok(data.error, 'Should have error code')
    assert.ok(data.message, 'Should have error message')
    assert.ok(data.requestId, 'Should have requestId for tracing')
    assert.notEqual(data.error, 'internal_server_error', 'Should not be generic 500 error')
  })

  await t.test('validates input before processing', async () => {
    const { status, data } = await makeRequest({
      profile_id: 'profile-demo-tennessee-stem-student',
      opportunity_data: 'this should be an object', // Invalid type
    })

    assert.equal(status, 400, 'Should return 400 for type error')
    assert.equal(data.error, 'invalid_opportunity_data')
    assert.ok(data.message.includes('must be a valid object'))
  })

  await t.test('handles missing title gracefully', async () => {
    const { status, data } = await makeRequest({
      profile_id: 'profile-demo-tennessee-stem-student',
      opportunity_data: {
        sponsor: 'Test',
        // missing title
      },
    })

    assert.equal(status, 400, 'Should return 400 for missing title')
    assert.equal(data.error, 'missing_opportunity_title')
  })
})

test('GET /api/version - deployment verification', async (t) => {
  const BASE_URL = process.env.TEST_API_URL || 'http://localhost:3456'
  
  await t.test('returns version information', async () => {
    const response = await fetch(`${BASE_URL}/api/version`)
    const data = await response.json()
    
    assert.equal(response.status, 200, 'Should return 200')
    assert.ok(data.commit || data.commitShort, 'Should have commit info')
    assert.ok(data.environment, 'Should have environment')
    assert.ok(data.nodeVersion, 'Should have Node version')
    
    console.log('[version] Deployed:', data)
  })
})
