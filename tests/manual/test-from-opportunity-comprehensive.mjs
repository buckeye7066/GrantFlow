/**
 * Comprehensive test suite for /api/grants/from-opportunity endpoint
 * Tests all failure scenarios that were previously causing 500 errors
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const BASE_URL = process.env.TEST_API_URL || 'http://localhost:3457'
const TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token'

async function makeRequest(payload) {
  const response = await fetch(`${BASE_URL}/api/grants/from-opportunity`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(payload),
  })

  let data
  try {
    data = await response.json()
  } catch (e) {
    data = { error: 'invalid_response', message: 'Response was not valid JSON', text: await response.text() }
  }

  return { status: response.status, data }
}

test('POST /api/grants/from-opportunity - Comprehensive failure prevention', async (t) => {
  
  await t.test('✅ Valid request returns 201, not 500', async () => {
    const { status, data } = await makeRequest({
      profile_id: 'profile-demo-tennessee-stem-student',
      opportunity_data: {
        title: `Test Valid ${Date.now()}`,
        sponsor: 'Test Foundation',
        url: `https://example.com/test-${Date.now()}`,
      },
    })

    assert.notEqual(status, 500, `Should not return 500. Got: ${JSON.stringify(data)}`)
    assert.ok(status === 200 || status === 201, `Expected 200/201, got ${status}`)
    if (status === 201) {
      assert.ok(data.id, 'Should have grant ID')
    }
  })

  await t.test('✅ Both opportunity_id and opportunity_data returns 201, not 500', async () => {
    const { status, data } = await makeRequest({
      profile_id: 'profile-demo-tennessee-stem-student',
      opportunity_id: 'nonexistent-opp-id',  // This doesn't exist in DB
      opportunity_data: {
        title: `Test Fallback ${Date.now()}`,
        sponsor: 'Test',
        url: `https://example.com/test-${Date.now()}`,
      },
    })

    assert.notEqual(status, 500, `Should not return 500. Got: ${JSON.stringify(data)}`)
    assert.ok(status === 200 || status === 201, `Expected 200/201, got ${status}. This tests FK constraint fix.`)
    if (status === 201) {
      assert.ok(data.id, 'Should have grant ID')
      // funding_opportunity_id should be null because the opportunity_id wasn't found
      assert.equal(data.funding_opportunity_id, null, 'Should not have funding_opportunity_id when fallback is used')
    }
  })

  await t.test('✅ Non-existent profile_id returns 404, not 500 or confusing error', async () => {
    const { status, data } = await makeRequest({
      profile_id: `nonexistent-${Date.now()}`,
      opportunity_data: {
        title: 'Test',
        sponsor: 'Test',
      },
    })

    assert.notEqual(status, 500, `Should not return 500. Got: ${JSON.stringify(data)}`)
    assert.equal(status, 404, `Should return 404 for non-existent profile`)
    assert.equal(data.error, 'profile_not_found', 'Should have profile_not_found error code')
    assert.ok(data.message.includes('not found'), 'Error message should mention "not found"')
  })

  await t.test('✅ opportunity_id not found without fallback returns 404, not 500', async () => {
    const { status, data } = await makeRequest({
      profile_id: 'profile-demo-tennessee-stem-student',
      opportunity_id: 'nonexistent-opp-id',
      // No opportunity_data provided
    })

    assert.notEqual(status, 500, `Should not return 500. Got: ${JSON.stringify(data)}`)
    assert.equal(status, 404, `Should return 404 for non-existent opportunity`)
    assert.equal(data.error, 'opportunity_not_found', 'Should have opportunity_not_found error code')
  })

  await t.test('✅ Missing profile_id AND organization_id returns 400, not 500', async () => {
    const { status, data } = await makeRequest({
      opportunity_data: {
        title: 'Test',
        sponsor: 'Test',
      },
    })

    assert.notEqual(status, 500, `Should not return 500. Got: ${JSON.stringify(data)}`)
    assert.equal(status, 400, 'Should return 400 for validation error')
    assert.equal(data.error, 'missing_required_field')
  })

  await t.test('✅ Invalid opportunity_data type returns 400, not 500', async () => {
    const { status, data } = await makeRequest({
      profile_id: 'profile-demo-tennessee-stem-student',
      opportunity_data: 'invalid string',
    })

    assert.notEqual(status, 500, `Should not return 500. Got: ${JSON.stringify(data)}`)
    assert.equal(status, 400, 'Should return 400 for type error')
    assert.equal(data.error, 'invalid_opportunity_data')
  })

  await t.test('✅ Missing title returns 400, not 500', async () => {
    const { status, data } = await makeRequest({
      profile_id: 'profile-demo-tennessee-stem-student',
      opportunity_data: {
        sponsor: 'Test',
      },
    })

    assert.notEqual(status, 500, `Should not return 500. Got: ${JSON.stringify(data)}`)
    assert.equal(status, 400, 'Should return 400 for missing title')
    assert.equal(data.error, 'missing_opportunity_title')
  })

  await t.test('✅ Expired deadline returns 400, not 500', async () => {
    const { status, data } = await makeRequest({
      profile_id: 'profile-demo-tennessee-stem-student',
      opportunity_data: {
        title: 'Test Expired',
        sponsor: 'Test',
        deadline: '2020-01-01',
      },
    })

    assert.notEqual(status, 500, `Should not return 500. Got: ${JSON.stringify(data)}`)
    assert.equal(status, 400, 'Should return 400 for expired deadline')
    assert.equal(data.error, 'opportunity_expired')
  })

  await t.test('✅ Error responses include requestId for tracing', async () => {
    const { status, data } = await makeRequest({
      // Missing required fields
      opportunity_data: {
        title: 'Test',
      },
    })

    assert.notEqual(status, 500, `Should not return 500. Got: ${JSON.stringify(data)}`)
    assert.ok(data.requestId, 'Should have requestId for error tracing')
  })
})

console.log('[test] Running comprehensive from-opportunity tests...')
