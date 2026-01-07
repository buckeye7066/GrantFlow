#!/usr/bin/env node
/**
 * Trigger Anya to fix failed tests
 */

import axios from 'axios'

async function triggerTestFix() {
  console.log('\n🔧 Triggering Anya to fix failed tests...\n')
  
  try {
    // Authenticate as admin
    const authStart = await axios.post('http://localhost:8080/api/auth/email/start', {
      email: 'buckeye7066@gmail.com'
    })
    
    const authVerify = await axios.post('http://localhost:8080/api/auth/email/verify', {
      email: 'buckeye7066@gmail.com',
      code: authStart.data.previewCode
    })
    
    const token = authVerify.data.accessToken
    console.log('✅ Authenticated as admin\n')
    
    // Trigger Anya to fix the tests
    console.log('🤖 Asking Anya to fix failed tests...')
    const response = await axios.post(
      'http://localhost:8080/api/anya/tools/execute',
      {
        tool: 'admin.anya.testFunctions',
        input: {
          testSuites: ['auth', 'profiles', 'grants', 'crawlers', 'ai'],
          fixErrors: true,  // Enable automatic fixing
          dryRun: false,    // Actually apply fixes
        }
      },
      { headers: { Authorization: `Bearer ${token}` } }
    )
    
    const result = response.data.result
    console.log('\n📊 Test Fix Results:')
    console.log(`  Total Tests: ${result.total_tests}`)
    console.log(`  Tests Passed: ${result.tests_passed}`)
    console.log(`  Tests Failed: ${result.tests_failed}`)
    console.log(`  Errors Fixed: ${result.errors_fixed}`)
    
    if (result.errors_fixed > 0) {
      console.log('\n✅ Anya fixed ${result.errors_fixed} errors!')
      console.log('   Re-run tests to verify fixes.')
    } else if (result.tests_failed > 0) {
      console.log('\n⚠️  ${result.tests_failed} tests still failing')
      console.log('   These may require manual intervention:')
      
      // Show which tests are failing
      result.results.forEach(suite => {
        suite.tests?.forEach(test => {
          if (test.status === 'failed') {
            console.log(`   - ${suite.suite}/${test.name}: ${test.error}`)
          }
        })
      })
    } else {
      console.log('\n🎉 All tests are passing!')
    }
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message)
  }
}

// Run it
triggerTestFix()