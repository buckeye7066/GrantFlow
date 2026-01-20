#!/usr/bin/env node
/**
 * Smoke test to verify authentication error handling endpoints
 * Tests the new health check and diagnostics endpoints
 * 
 * Run the backend first with: npm run backend
 * Then run this script: node scripts/smoke-auth-diagnostics.mjs
 */

import process from 'node:process'

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:8080'

async function testHealthEndpoint() {
  console.log('\n[test] Testing /health endpoint...')
  
  try {
    const response = await fetch(`${API_BASE_URL}/health`)
    const data = await response.json()
    
    console.log(`[test] Health endpoint status: ${response.status}`)
    console.log('[test] Health response:', JSON.stringify(data, null, 2))
    
    if (!response.ok) {
      throw new Error('Health endpoint returned non-OK status')
    }
    
    if (!data.status || !data.dependencies) {
      throw new Error('Health endpoint missing required fields')
    }
    
    console.log('[test] ✅ Health endpoint test passed')
    return true
  } catch (error) {
    console.error('[test] ❌ Health endpoint test failed:', error.message)
    return false
  }
}

async function testAuthDiagnosticsEndpoint() {
  console.log('\n[test] Testing /api/auth/diagnostics endpoint...')
  
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/diagnostics`)
    const data = await response.json()
    
    console.log(`[test] Diagnostics endpoint status: ${response.status}`)
    console.log('[test] Diagnostics response:', JSON.stringify(data, null, 2))
    
    if (!response.ok) {
      console.warn('[test] ⚠️  Diagnostics endpoint returned non-OK status (may be expected if auth not configured)')
    }
    
    if (!data.status || !data.auth || !data.providers) {
      throw new Error('Diagnostics endpoint missing required fields')
    }
    
    // Check that providers are reported
    const providers = ['google', 'facebook', 'yahoo']
    for (const provider of providers) {
      if (!data.providers[provider]) {
        throw new Error(`Provider ${provider} not in diagnostics response`)
      }
      console.log(`[test] ${provider} configured: ${data.providers[provider].configured}`)
    }
    
    console.log('[test] ✅ Auth diagnostics endpoint test passed')
    return true
  } catch (error) {
    console.error('[test] ❌ Auth diagnostics endpoint test failed:', error.message)
    return false
  }
}

async function testOAuthStartEndpoint() {
  console.log('\n[test] Testing OAuth start endpoints...')
  
  try {
    // Test with an unsupported provider (should return 404)
    const unsupportedResponse = await fetch(`${API_BASE_URL}/api/auth/unsupported/start`)
    console.log(`[test] Unsupported provider status: ${unsupportedResponse.status}`)
    
    if (unsupportedResponse.status !== 404) {
      throw new Error('Expected 404 for unsupported provider')
    }
    
    // Test with a supported but potentially unconfigured provider
    // This should return 503 or redirect
    const googleResponse = await fetch(`${API_BASE_URL}/api/auth/google/start`, {
      redirect: 'manual' // Don't follow redirects
    })
    console.log(`[test] Google OAuth start status: ${googleResponse.status}`)
    
    // Should be either 503 (not configured) or 302 (redirect to OAuth)
    if (googleResponse.status !== 503 && googleResponse.status !== 302) {
      console.warn(`[test] ⚠️  Unexpected status ${googleResponse.status} for Google OAuth start`)
    }
    
    if (googleResponse.status === 503) {
      const errorData = await googleResponse.json()
      console.log('[test] Provider not configured (expected):', errorData.error)
    } else if (googleResponse.status === 302) {
      console.log('[test] Provider configured and redirecting to OAuth provider')
    }
    
    console.log('[test] ✅ OAuth start endpoint test passed')
    return true
  } catch (error) {
    console.error('[test] ❌ OAuth start endpoint test failed:', error.message)
    return false
  }
}

async function run() {
  console.log('[test] Starting authentication error handling smoke tests')
  console.log(`[test] API Base URL: ${API_BASE_URL}`)
  
  const results = []
  
  // Test health endpoint
  results.push(await testHealthEndpoint())
  
  // Test auth diagnostics endpoint
  results.push(await testAuthDiagnosticsEndpoint())
  
  // Test OAuth start endpoint
  results.push(await testOAuthStartEndpoint())
  
  // Summary
  console.log('\n[test] ========================================')
  console.log('[test] Test Summary:')
  const passed = results.filter(r => r).length
  const total = results.length
  console.log(`[test] Passed: ${passed}/${total}`)
  
  if (passed === total) {
    console.log('[test] ✅ All tests passed!')
    process.exitCode = 0
  } else {
    console.log('[test] ❌ Some tests failed')
    process.exitCode = 1
  }
}

run().catch((error) => {
  console.error('[test] Test suite failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
