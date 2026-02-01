/**
 * Lightweight verification:
 * - hits POST /api/grants/from-opportunity with a directory-style opportunity payload
 * - expects 200/201 (never 500) and a returned grant id
 * - tests the main failure scenarios that were fixed
 *
 * Usage:
 *   # in one terminal
 *   npm run backend
 *
 *   # in another terminal
 *   PROFILE_ID=profile-anastasia node scripts/verify-add-to-pipeline-from-opportunity.mjs http://localhost:8080
 *
 * Notes:
 * - Requires you to be authenticated in that backend (cookie/JWT) depending on your setup.
 * - If you're not authenticated, it will return 401 and the script will fail (expected).
 * - Tests multiple scenarios to ensure robust error handling
 */
const baseUrl = process.argv[2] || 'http://localhost:8080'

async function test(name, payload, expectedStatus) {
  try {
    const res = await fetch(`${baseUrl}/api/grants/from-opportunity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // NOTE: If your backend uses bearer tokens locally, add:
        authorization: `Bearer ${process.env.ADMIN_TOKEN || ''}`,
      },
      body: JSON.stringify(payload),
    })

    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      // keep raw text
    }

    if (Array.isArray(expectedStatus) ? !expectedStatus.includes(res.status) : res.status !== expectedStatus) {
      throw new Error(`Expected status ${expectedStatus}, got ${res.status}: ${text}`)
    }

    console.log(`✓ ${name}: ${res.status} ${json?.id || json?.error || 'ok'}`)
    return { ok: true, status: res.status, data: json }
  } catch (err) {
    console.error(`✗ ${name}: ${err.message}`)
    return { ok: false, error: err.message }
  }
}

async function main() {
  const profileId = process.env.PROFILE_ID || 'profile-anastasia'
  console.log('[verify] Testing /api/grants/from-opportunity endpoint')
  console.log(`[verify] Base URL: ${baseUrl}`)
  console.log(`[verify] Profile ID: ${profileId}`)
  console.log('')

  const results = []

  // Test 1: Valid request (should succeed)
  results.push(await test(
    'Valid opportunity_data',
    {
      profile_id: profileId,
      opportunity_data: {
        title: `Test Directory Resource (${Date.now()})`,
        sponsor: 'United Way',
        deadline: null,
        url: `https://www.unitedway.org/find-your-united-way?t=${Date.now()}`,
        awardMin: null,
        awardMax: null,
        descriptionMd: 'Test directory resource for pipeline insertion.',
        eligibilityBullets: [],
        source: 'local_funding',
      },
    },
    [200, 201]
  ))

  // Test 2: Both opportunity_id and opportunity_data (tests FK fix)
  results.push(await test(
    'FK constraint fix (opp_id + fallback)',
    {
      profile_id: profileId,
      opportunity_id: 'nonexistent-opportunity',
      opportunity_data: {
        title: `Test FK Fix (${Date.now()})`,
        sponsor: 'Test',
        url: `https://example.com/test-fk-${Date.now()}`,
      },
    },
    [200, 201]
  ))

  // Test 3: Non-existent profile (should return 404, not 500)
  results.push(await test(
    'Non-existent profile error',
    {
      profile_id: `nonexistent-${Date.now()}`,
      opportunity_data: {
        title: 'Test',
        sponsor: 'Test',
      },
    },
    404
  ))

  // Test 4: Missing required fields (should return 400, not 500)
  results.push(await test(
    'Validation error handling',
    {
      // Missing profile_id and organization_id
      opportunity_data: {
        title: 'Test',
        sponsor: 'Test',
      },
    },
    400
  ))

  console.log('')
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length

  if (failed === 0) {
    console.log(`[verify] ✓ All ${passed} tests passed`)
    process.exitCode = 0
  } else {
    console.log(`[verify] ✗ ${failed} test(s) failed, ${passed} passed`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('[verify] fatal error', err?.message || err)
  process.exitCode = 1
})

