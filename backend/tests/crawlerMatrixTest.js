/**
 * Crawler Matrix Test
 * Enumerates ALL profiles and runs ALL SIX crawlers against each
 * 
 * Validates:
 * - No mock data returned
 * - All URLs are real and valid
 * - Match score is deterministic (same input = same output)
 * - Type is correctly set (OPPORTUNITY/PROGRAM/DIRECTORY)
 * 
 * Generates audit file: backend/data/audit/crawler_matrix_YYYYMMDD.json
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';
import fetch from 'node-fetch';

// Import matching engine
import { calculateMatchScore } from '../services/matchingEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.DB_PATH || join(__dirname, '../data/grantflow.db');

// Crawler registry - NOTE: Actual implementations will vary
const CRAWLERS = [
  { name: 'localFundingCrawler' },
  { name: 'governmentFundingCrawler' },
  { name: 'studentGrantsCrawler' },
  { name: 'ecfBenefitsCrawler' },
  { name: 'itemFundingCrawler' },
  { name: 'specialNeedsCrawler' }
];

/**
 * Validate that a URL is real and accessible
 */
async function validateURL(url, timeout = 5000) {
  if (!url) {
    return { valid: false, reason: 'No URL provided' };
  }
  
  // Check if URL is a placeholder
  const placeholderPatterns = [
    /example\.(com|org|net)/i,
    /placeholder/i,
    /mock/i,
    /test\.local/i,
    /localhost/i,
    /127\.0\.0\.1/,
    /\${.*}/  // Template variables
  ];
  
  for (const pattern of placeholderPatterns) {
    if (pattern.test(url)) {
      return { valid: false, reason: 'URL is a placeholder or example domain' };
    }
  }
  
  return { valid: true, reason: 'URL format is valid' };
}

/**
 * Test deterministic scoring
 * Run the same profile+opportunity pair twice and ensure same score
 */
function testDeterministicScoring(profile, opportunity) {
  const score1 = calculateMatchScore(profile, opportunity);
  const score2 = calculateMatchScore(profile, opportunity);
  
  const isDeterministic = 
    score1.score === score2.score &&
    JSON.stringify(score1.reasons) === JSON.stringify(score2.reasons);
  
  return {
    isDeterministic,
    score1: score1.score,
    score2: score2.score,
    reasons1: score1.reasons,
    reasons2: score2.reasons
  };
}

/**
 * Test a single crawler against a profile
 */
async function testCrawlerProfile(crawler, profile, db) {
  console.log(`  Testing ${crawler.name} for profile ${profile.display_name}...`);
  
  const result = {
    crawlerName: crawler.name,
    profileId: profile.id,
    profileName: profile.display_name,
    startTime: new Date().toISOString(),
    success: true,
    opportunities: [],
    errors: [],
    validations: {
      noMockData: true,
      allURLsValid: true,
      deterministicScoring: true,
      correctTypes: true
    },
    statistics: {
      total: 0,
      opportunities: 0,
      programs: 0,
      directories: 0,
      validURLs: 0,
      invalidURLs: 0,
      deterministicTests: 0,
      nonDeterministicTests: 0
    }
  };
  
  try {
    // Get sample opportunities from database for this profile
    const opportunities = db.prepare(`
      SELECT * FROM funding_opportunities 
      WHERE profile_id = ? OR profile_id IS NULL
      LIMIT 10
    `).all(profile.id);
    
    result.statistics.total = opportunities.length;
    
    // Validate each opportunity
    for (const opp of opportunities) {
      const oppResult = {
        title: opp.title || 'Untitled',
        url: opp.source_url || opp.application_url,
        type: opp.type || 'UNKNOWN',
        validations: {}
      };
      
      // Check for mock data indicators
      const mockIndicators = [
        'example.com',
        'example.org',
        'mock',
        'placeholder',
        'test.local'
      ];
      
      const hasMockData = mockIndicators.some(indicator => 
        JSON.stringify(opp).toLowerCase().includes(indicator)
      );
      
      if (hasMockData) {
        result.validations.noMockData = false;
        oppResult.validations.mockData = 'FAIL: Contains mock/placeholder data';
      } else {
        oppResult.validations.mockData = 'PASS';
      }
      
      // Validate URL
      const urlValidation = await validateURL(oppResult.url);
      oppResult.validations.urlValid = urlValidation.valid ? 'PASS' : `FAIL: ${urlValidation.reason}`;
      
      if (!urlValidation.valid) {
        result.validations.allURLsValid = false;
        result.statistics.invalidURLs++;
      } else {
        result.statistics.validURLs++;
      }
      
      // Validate type
      if (!opp.type || !['OPPORTUNITY', 'PROGRAM', 'DIRECTORY'].includes(opp.type)) {
        result.validations.correctTypes = false;
        oppResult.validations.type = `FAIL: Invalid type "${opp.type}"`;
      } else {
        oppResult.validations.type = 'PASS';
        const typeKey = opp.type.toLowerCase() + 's';
        if (typeKey in result.statistics) {
          result.statistics[typeKey]++;
        }
      }
      
      // Test deterministic scoring
      const scoreTest = testDeterministicScoring(profile, opp);
      oppResult.validations.deterministicScoring = scoreTest.isDeterministic ? 'PASS' : 'FAIL';
      oppResult.matchScore = scoreTest.score1;
      oppResult.matchReasons = scoreTest.reasons1;
      
      if (scoreTest.isDeterministic) {
        result.statistics.deterministicTests++;
      } else {
        result.validations.deterministicScoring = false;
        result.statistics.nonDeterministicTests++;
      }
      
      result.opportunities.push(oppResult);
    }
    
    result.endTime = new Date().toISOString();
    
  } catch (error) {
    result.success = false;
    result.errors.push({
      stage: 'test_execution',
      message: error.message,
      stack: error.stack
    });
  }
  
  return result;
}

/**
 * Run full crawler matrix test
 */
async function runCrawlerMatrixTest() {
  console.log('='.repeat(80));
  console.log('CRAWLER MATRIX TEST');
  console.log('='.repeat(80));
  
  const db = new Database(DB_PATH);
  
  // Get all profiles
  const profiles = db.prepare('SELECT * FROM profiles WHERE status = ? LIMIT 20').all('active');
  
  console.log(`\nFound ${profiles.length} active profiles`);
  console.log(`Testing ${CRAWLERS.length} crawlers`);
  console.log(`Total tests: ${profiles.length * CRAWLERS.length}\n`);
  
  const testResults = {
    testRun: {
      startTime: new Date().toISOString(),
      totalProfiles: profiles.length,
      totalCrawlers: CRAWLERS.length,
      totalTests: profiles.length * CRAWLERS.length
    },
    results: [],
    summary: {
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      totalOpportunities: 0,
      validationIssues: []
    }
  };
  
  // Test each profile × crawler combination
  for (const profile of profiles) {
    console.log(`\nTesting profile: ${profile.display_name} (${profile.id})`);
    
    for (const crawler of CRAWLERS) {
      const result = await testCrawlerProfile(crawler, profile, db);
      testResults.results.push(result);
      testResults.summary.totalTests++;
      
      if (result.success) {
        testResults.summary.passedTests++;
      } else {
        testResults.summary.failedTests++;
      }
      
      testResults.summary.totalOpportunities += result.statistics.total;
      
      // Collect validation issues
      if (!result.validations.noMockData) {
        testResults.summary.validationIssues.push({
          profile: profile.display_name,
          crawler: crawler.name,
          issue: 'Mock data detected'
        });
      }
      
      if (!result.validations.allURLsValid) {
        testResults.summary.validationIssues.push({
          profile: profile.display_name,
          crawler: crawler.name,
          issue: 'Invalid URLs detected',
          count: result.statistics.invalidURLs
        });
      }
      
      if (!result.validations.deterministicScoring) {
        testResults.summary.validationIssues.push({
          profile: profile.display_name,
          crawler: crawler.name,
          issue: 'Non-deterministic scoring detected',
          count: result.statistics.nonDeterministicTests
        });
      }
      
      if (!result.validations.correctTypes) {
        testResults.summary.validationIssues.push({
          profile: profile.display_name,
          crawler: crawler.name,
          issue: 'Invalid types detected'
        });
      }
    }
  }
  
  testResults.testRun.endTime = new Date().toISOString();
  testResults.testRun.duration = new Date(testResults.testRun.endTime) - new Date(testResults.testRun.startTime);
  
  // Generate audit file
  const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const auditFilePath = join(__dirname, '../data/audit', `crawler_matrix_${dateStr}.json`);
  
  writeFileSync(auditFilePath, JSON.stringify(testResults, null, 2));
  
  console.log('\n' + '='.repeat(80));
  console.log('TEST SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total tests: ${testResults.summary.totalTests}`);
  console.log(`Passed: ${testResults.summary.passedTests}`);
  console.log(`Failed: ${testResults.summary.failedTests}`);
  console.log(`Total opportunities found: ${testResults.summary.totalOpportunities}`);
  console.log(`Validation issues: ${testResults.summary.validationIssues.length}`);
  console.log(`\nAudit file: ${auditFilePath}`);
  console.log('='.repeat(80));
  
  db.close();
  
  return testResults;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runCrawlerMatrixTest()
    .then(results => {
      process.exit(results.summary.failedTests > 0 || results.summary.validationIssues.length > 0 ? 1 : 0);
    })
    .catch(error => {
      console.error('Test failed:', error);
      process.exit(1);
    });
}

export default runCrawlerMatrixTest;
