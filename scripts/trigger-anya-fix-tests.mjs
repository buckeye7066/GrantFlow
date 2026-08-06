#!/usr/bin/env node
/**
 * Trigger Anya's mutating test-fix tool against an explicitly confirmed host.
 *
 * Required env:
 * - ANYA_FIX_API_BASE
 * - ANYA_FIX_CONFIRM_MUTATING_HOST (must exactly match the URL hostname)
 * - ANYA_FIX_ADMIN_TOKEN
 * - ANYA_FIX_CONFIRM=APPLY_FIXES
 */

import axios from 'axios'
import process from 'node:process'

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required; this mutating script has no live defaults`)
  return value
}

const apiUrl = new URL(requiredEnv('ANYA_FIX_API_BASE'))
const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(apiUrl.hostname.toLowerCase())
if (apiUrl.protocol !== 'https:' && !(apiUrl.protocol === 'http:' && isLoopback)) {
  throw new Error('ANYA_FIX_API_BASE must use HTTPS unless it targets loopback')
}
if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
  throw new Error('ANYA_FIX_API_BASE must not contain credentials, query parameters, or a fragment')
}
const confirmedHost = requiredEnv('ANYA_FIX_CONFIRM_MUTATING_HOST').toLowerCase()
if (confirmedHost !== apiUrl.hostname.toLowerCase()) {
  throw new Error('ANYA_FIX_CONFIRM_MUTATING_HOST must exactly match the ANYA_FIX_API_BASE hostname')
}
const ADMIN_TOKEN = requiredEnv('ANYA_FIX_ADMIN_TOKEN')
if (requiredEnv('ANYA_FIX_CONFIRM') !== 'APPLY_FIXES') {
  throw new Error('ANYA_FIX_CONFIRM must equal APPLY_FIXES')
}

const API_BASE = apiUrl.toString().replace(/\/$/, '')
const AUTH_HEADERS = Object.freeze({ Authorization: `Bearer ${ADMIN_TOKEN}` })

function responseIsCanonicalAdmin(data) {
  return data?.user?.is_admin === true || data?.role === 'admin'
}

async function triggerTestFix() {
  console.log('\n🔧 Triggering Anya to fix failed tests...\n')

  try {
    const authMe = await axios.get(`${API_BASE}/api/auth/me`, { headers: AUTH_HEADERS })
    if (!responseIsCanonicalAdmin(authMe.data)) {
      throw new Error('ANYA_FIX_ADMIN_TOKEN did not resolve to a canonical server admin')
    }
    console.log('✅ Canonical admin authority verified\n')

    console.log('🤖 Asking Anya to fix failed tests...')
    const response = await axios.post(
      `${API_BASE}/api/anya/tools/execute`,
      {
        tool: 'admin.anya.testFunctions',
        input: {
          testSuites: ['auth', 'profiles', 'grants', 'crawlers', 'ai'],
          fixErrors: true,
          dryRun: false,
        },
      },
      { headers: AUTH_HEADERS },
    )

    const result = response.data.result
    console.log('\n📊 Test Fix Results:')
    console.log(`  Total Tests: ${result.total_tests}`)
    console.log(`  Tests Passed: ${result.tests_passed}`)
    console.log(`  Tests Failed: ${result.tests_failed}`)
    console.log(`  Errors Fixed: ${result.errors_fixed}`)

    if (result.errors_fixed > 0) {
      console.log(`\n✅ Anya fixed ${result.errors_fixed} errors!`)
      console.log('   Re-run tests to verify fixes.')
    } else if (result.tests_failed > 0) {
      console.log(`\n⚠️  ${result.tests_failed} tests still failing`)
      console.log('   These may require manual intervention:')
      result.results.forEach((suite) => {
        suite.tests?.forEach((testResult) => {
          if (testResult.status === 'failed') {
            console.log(`   - ${suite.suite}/${testResult.name}: ${testResult.error}`)
          }
        })
      })
    } else {
      console.log('\n🎉 All tests are passing!')
    }
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message)
    process.exitCode = 1
  }
}

triggerTestFix()
