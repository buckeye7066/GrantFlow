/**
 * Direct test to reproduce "Failed to add grant to pipeline" errors
 * 
 * This test directly calls the endpoint with various payloads to identify
 * the exact failure points that cause 500 errors in production.
 */

import { db } from '../../backend/db/index.js'

// Import the app directly
const serverModule = await import('../../backend/server.js')
const app = serverModule.default

console.log('[test] Starting direct from-opportunity failure reproduction test')

// Helper to make authenticated requests
async function makeAuthenticatedRequest(path, method, body, userId = 'test-user-1') {
  // Create a minimal user in DB
  try {
    db.prepare(`
      INSERT OR IGNORE INTO users (id, primary_email, is_admin, created_at, updated_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(userId, 'test@example.com')
  } catch (e) {
    // User might already exist
  }

  // Create test profile
  const profileId = 'test-profile-' + Date.now()
  const orgId = 'test-org-' + Date.now()
  
  try {
    db.prepare(`
      INSERT INTO organizations (id, name, applicant_type, created_at, updated_at)
      VALUES (?, 'Test Org', 'nonprofit', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(orgId)
    
    db.prepare(`
      INSERT INTO profiles (id, user_id, organization_id, display_name, created_at, updated_at)
      VALUES (?, ?, ?, 'Test Profile', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(profileId, userId, orgId)
  } catch (e) {
    console.error('[test] Error creating test data:', e.message)
  }

  return { profileId, orgId, userId }
}

// Test 1: Valid payload with opportunity_data
console.log('\n[TEST 1] Testing valid opportunity_data payload...')
const test1Data = await makeAuthenticatedRequest()
const test1Payload = {
  profile_id: test1Data.profileId,
  opportunity_data: {
    title: 'Test Grant from Direct Test',
    sponsor: 'Test Foundation',
    deadline: '2026-12-31',
    url: 'https://example.com/test-grant-' + Date.now(),
    awardMin: 5000,
    awardMax: 25000,
    descriptionMd: 'This is a test grant',
    eligibilityBullets: ['Nonprofits', 'Educational institutions'],
    source: 'test',
  },
}

try {
  const result = await fetch('http://localhost:3456/api/grants/from-opportunity', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-admin-token',
    },
    body: JSON.stringify(test1Payload),
  })
  
  const data = await result.json()
  console.log(`[TEST 1] Status: ${result.status}`)
  console.log(`[TEST 1] Response:`, data)
  
  if (result.status === 500) {
    console.error('❌ TEST 1 FAILED: Returned 500 for valid payload')
    console.error('Error details:', data)
  } else if (result.status === 200 || result.status === 201) {
    console.log('✅ TEST 1 PASSED: Returned', result.status)
  } else {
    console.warn('⚠️  TEST 1: Unexpected status', result.status)
  }
} catch (error) {
  console.error('❌ TEST 1 EXCEPTION:', error.message)
}

// Test 2: Missing profile_id and organization_id
console.log('\n[TEST 2] Testing missing profile_id/organization_id...')
try {
  const result = await fetch('http://localhost:3456/api/grants/from-opportunity', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-admin-token',
    },
    body: JSON.stringify({
      opportunity_data: {
        title: 'Test Grant',
        sponsor: 'Test',
      },
    }),
  })
  
  const data = await result.json()
  console.log(`[TEST 2] Status: ${result.status}`)
  console.log(`[TEST 2] Response:`, data)
  
  if (result.status === 500) {
    console.error('❌ TEST 2 FAILED: Should return 400, not 500')
  } else if (result.status === 400) {
    console.log('✅ TEST 2 PASSED: Correctly returned 400')
  } else {
    console.warn('⚠️  TEST 2: Unexpected status', result.status)
  }
} catch (error) {
  console.error('❌ TEST 2 EXCEPTION:', error.message)
}

// Test 3: Invalid opportunity_data type
console.log('\n[TEST 3] Testing invalid opportunity_data type...')
const test3Data = await makeAuthenticatedRequest()
try {
  const result = await fetch('http://localhost:3456/api/grants/from-opportunity', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-admin-token',
    },
    body: JSON.stringify({
      profile_id: test3Data.profileId,
      opportunity_data: 'this should be an object',
    }),
  })
  
  const data = await result.json()
  console.log(`[TEST 3] Status: ${result.status}`)
  console.log(`[TEST 3] Response:`, data)
  
  if (result.status === 500) {
    console.error('❌ TEST 3 FAILED: Should return 400, not 500')
  } else if (result.status === 400) {
    console.log('✅ TEST 3 PASSED: Correctly returned 400')
  } else {
    console.warn('⚠️  TEST 3: Unexpected status', result.status)
  }
} catch (error) {
  console.error('❌ TEST 3 EXCEPTION:', error.message)
}

// Test 4: Missing required title in opportunity_data
console.log('\n[TEST 4] Testing missing title in opportunity_data...')
const test4Data = await makeAuthenticatedRequest()
try {
  const result = await fetch('http://localhost:3456/api/grants/from-opportunity', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-admin-token',
    },
    body: JSON.stringify({
      profile_id: test4Data.profileId,
      opportunity_data: {
        sponsor: 'Test',
        // missing title
      },
    }),
  })
  
  const data = await result.json()
  console.log(`[TEST 4] Status: ${result.status}`)
  console.log(`[TEST 4] Response:`, data)
  
  if (result.status === 500) {
    console.error('❌ TEST 4 FAILED: Should return 400, not 500')
  } else if (result.status === 400) {
    console.log('✅ TEST 4 PASSED: Correctly returned 400')
  } else {
    console.warn('⚠️  TEST 4: Unexpected status', result.status)
  }
} catch (error) {
  console.error('❌ TEST 4 EXCEPTION:', error.message)
}

// Test 5: Non-existent profile_id
console.log('\n[TEST 5] Testing non-existent profile_id...')
try {
  const result = await fetch('http://localhost:3456/api/grants/from-opportunity', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-admin-token',
    },
    body: JSON.stringify({
      profile_id: 'nonexistent-profile-' + Date.now(),
      opportunity_data: {
        title: 'Test Grant',
        sponsor: 'Test',
      },
    }),
  })
  
  const data = await result.json()
  console.log(`[TEST 5] Status: ${result.status}`)
  console.log(`[TEST 5] Response:`, data)
  
  if (result.status === 500) {
    console.error('❌ TEST 5 FAILED: Should return 403/404, not 500')
    console.error('Error details:', data)
  } else if (result.status === 403 || result.status === 404) {
    console.log('✅ TEST 5 PASSED: Correctly returned', result.status)
  } else {
    console.warn('⚠️  TEST 5: Unexpected status', result.status)
  }
} catch (error) {
  console.error('❌ TEST 5 EXCEPTION:', error.message)
}

console.log('\n[test] All tests complete')
process.exit(0)
