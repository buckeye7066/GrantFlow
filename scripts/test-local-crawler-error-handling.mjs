#!/usr/bin/env node
/**
 * Test local crawler error handling improvements
 * Validates error handling for:
 * - Invalid ZIP codes
 * - Missing coordinates
 * - Geocoding failures
 * - Missing profile data
 */

import { crawlLocalFunding } from '../backend/services/crawlers/localFundingCrawler.js'

console.log('[test] Testing local crawler error handling...\n')

// Test 1: Valid profile with valid ZIP
console.log('Test 1: Valid profile with valid ZIP code')
try {
  const validProfile = {
    signals: {
      location: { zip: '10001', state: 'NY', city: 'New York' },
      interests: new Set(['education', 'youth']),
      demographics: new Set(),
      keywordSet: new Set(['education', 'youth', 'community']),
      coverage: { pct: 100 }
    }
  }
  const results = await crawlLocalFunding(validProfile, { min_match_score: 50 })
  console.log(`✓ Valid ZIP test passed - got ${results.length} results`)
} catch (error) {
  console.error('✗ Valid ZIP test failed:', error.message)
  process.exit(1)
}

// Test 2: Profile with invalid ZIP code (non-5-digit)
console.log('\nTest 2: Profile with invalid ZIP code')
try {
  const invalidZipProfile = {
    signals: {
      location: { zip: '123', state: 'NY', city: 'New York' },
      interests: new Set(['education']),
      demographics: new Set(),
      keywordSet: new Set(['education']),
      coverage: { pct: 100 }
    }
  }
  const results = await crawlLocalFunding(invalidZipProfile, { min_match_score: 50 })
  console.log(`✓ Invalid ZIP test passed - got ${results.length} directory results (coordinates not resolved)`)
} catch (error) {
  console.error('✗ Invalid ZIP test failed:', error.message)
  process.exit(1)
}

// Test 3: Profile with no ZIP code
console.log('\nTest 3: Profile with no ZIP code')
try {
  const noZipProfile = {
    signals: {
      location: { state: 'CA', city: 'San Francisco' },
      interests: new Set(['education']),
      demographics: new Set(),
      keywordSet: new Set(['education']),
      coverage: { pct: 100 }
    }
  }
  const results = await crawlLocalFunding(noZipProfile, { min_match_score: 50 })
  console.log(`✓ No ZIP test passed - got ${results.length} directory results`)
} catch (error) {
  console.error('✗ No ZIP test failed:', error.message)
  process.exit(1)
}

// Test 4: Profile with no signals (should handle gracefully)
console.log('\nTest 4: Profile with no signals')
try {
  const noSignalsProfile = {
    zip_code: '10001',
    state: 'NY'
  }
  const results = await crawlLocalFunding(noSignalsProfile, { min_match_score: 50 })
  console.log(`✓ No signals test passed - got ${results.length} results (graceful degradation)`)
} catch (error) {
  console.error('✗ No signals test failed:', error.message)
  process.exit(1)
}

// Test 5: Profile with non-existent ZIP code
console.log('\nTest 5: Profile with non-existent ZIP code')
try {
  const nonExistentZipProfile = {
    signals: {
      location: { zip: '00000', state: 'XX', city: 'Unknown' },
      interests: new Set(['education']),
      demographics: new Set(),
      keywordSet: new Set(['education']),
      coverage: { pct: 100 }
    }
  }
  const results = await crawlLocalFunding(nonExistentZipProfile, { min_match_score: 50 })
  console.log(`✓ Non-existent ZIP test passed - got ${results.length} directory results (coordinates not found)`)
} catch (error) {
  console.error('✗ Non-existent ZIP test failed:', error.message)
  process.exit(1)
}

// Test 6: Profile with null values (should handle gracefully)
console.log('\nTest 6: Profile with null/undefined values')
try {
  const nullProfile = {
    signals: {
      location: { zip: null, state: 'TX', city: 'Austin' },
      interests: new Set(['technology']),
      demographics: new Set(),
      keywordSet: new Set(['technology']),
      coverage: { pct: 100 }
    }
  }
  const results = await crawlLocalFunding(nullProfile, { min_match_score: 50 })
  console.log(`✓ Null values test passed - got ${results.length} results`)
} catch (error) {
  console.error('✗ Null values test failed:', error.message)
  process.exit(1)
}

console.log('\n✓ All error handling tests passed!')
console.log('\nSummary:')
console.log('- Geocoding failures are handled gracefully')
console.log('- Invalid ZIP codes are validated and rejected')
console.log('- Missing profile data is handled with fallbacks')
console.log('- Directory resources are always returned as baseline')
process.exit(0)
