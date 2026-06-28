#!/usr/bin/env node
/**
 * Smoke test for auth-adjacent production checks.
 *
 * This intentionally treats unauthenticated /api/auth/diagnostics as a PASS
 * when it returns 401/403. Diagnostics expose operational configuration state
 * and must not be public in production.
 */

import process from 'node:process'

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:8080'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.GRANTFLOW_ADMIN_TOKEN || null

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function testHealthEndpoint() {
  console.log('\n[test] Testing /api/health endpoint...')

  try {
    const response = await fetch(`${API_BASE_URL}/api/health`)
    const data = await readJson(response)

    console.log(`[test] Health endpoint status: ${response.status}`)
    console.log('[test] Health response:', JSON.stringify(data, null, 2))

    if (!response.ok) {
      throw new Error('Health endpoint returned non-OK status')
    }

    if (!data || (!data.status && data.ok !== true)) {
      throw new Error('Health endpoint missing status signal')
    }

    console.log('[test] PASS Health endpoint test passed')
    return true
  } catch (error) {
    console.error('[test] FAIL Health endpoint test failed:', error.message)
    return false
  }
}

async function testAuthDiagnosticsEndpoint() {
  console.log('\n[test] Testing /api/auth/diagnostics endpoint...')

  try {
    const headers = ADMIN_TOKEN
      ? { Authorization: `Bearer ${ADMIN_TOKEN}`, 'X-Admin-Token': ADMIN_TOKEN }
      : {}
    const response = await fetch(`${API_BASE_URL}/api/auth/diagnostics`, { headers })
    const data = await readJson(response)

    console.log(`[test] Diagnostics endpoint status: ${response.status}`)
    console.log('[test] Diagnostics response:', JSON.stringify(data, null, 2))

    if (!ADMIN_TOKEN) {
      if (response.status !== 401 && response.status !== 403) {
        throw new Error(`Expected diagnostics to require admin auth, got ${response.status}`)
      }
      console.log('[test] PASS Auth diagnostics correctly require admin authentication')
      return true
    }

    if (!response.ok) {
      throw new Error(`Diagnostics endpoint returned ${response.status}`)
    }

    if (!data?.status || !data?.auth || !data?.providers) {
      throw new Error('Diagnostics endpoint missing required fields')
    }

    for (const provider of ['google', 'facebook', 'yahoo']) {
      if (!data.providers[provider]) {
        throw new Error(`Provider ${provider} not in diagnostics response`)
      }
      console.log(`[test] ${provider} configured: ${data.providers[provider].configured}`)
    }

    console.log('[test] PASS Auth diagnostics endpoint test passed')
    return true
  } catch (error) {
    console.error('[test] FAIL Auth diagnostics endpoint test failed:', error.message)
    return false
  }
}

async function testOAuthStartEndpoint() {
  console.log('\n[test] Testing OAuth start endpoints...')

  try {
    const unsupportedResponse = await fetch(`${API_BASE_URL}/api/auth/unsupported/start`)
    console.log(`[test] Unsupported provider status: ${unsupportedResponse.status}`)

    if (unsupportedResponse.status !== 404) {
      throw new Error('Expected 404 for unsupported provider')
    }

    const googleResponse = await fetch(`${API_BASE_URL}/api/auth/google/start`, {
      redirect: 'manual',
    })
    console.log(`[test] Google OAuth start status: ${googleResponse.status}`)

    if (googleResponse.status !== 503 && googleResponse.status !== 302) {
      throw new Error(`Unexpected status ${googleResponse.status} for Google OAuth start`)
    }

    if (googleResponse.status === 503) {
      const errorData = await readJson(googleResponse)
      console.log('[test] Provider not configured:', errorData?.error || 'configuration unavailable')
    } else {
      console.log('[test] Provider configured and redirecting to OAuth provider')
    }

    console.log('[test] PASS OAuth start endpoint test passed')
    return true
  } catch (error) {
    console.error('[test] FAIL OAuth start endpoint test failed:', error.message)
    return false
  }
}

async function run() {
  console.log('[test] Starting authentication smoke tests')
  console.log(`[test] API Base URL: ${API_BASE_URL}`)
  console.log(`[test] Admin diagnostics token: ${ADMIN_TOKEN ? 'provided' : 'not provided'}`)

  const results = [
    await testHealthEndpoint(),
    await testAuthDiagnosticsEndpoint(),
    await testOAuthStartEndpoint(),
  ]

  const passed = results.filter(Boolean).length
  const total = results.length
  console.log('\n[test] ========================================')
  console.log(`[test] Passed: ${passed}/${total}`)

  process.exitCode = passed === total ? 0 : 1
}

run().catch((error) => {
  console.error('[test] Test suite failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
