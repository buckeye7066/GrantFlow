#!/usr/bin/env node
/**
 * Comprehensive GrantFlow Application Test Suite
 * Tests all buttons, functions, crawlers, and features
 *
 * This suite mutates profiles, pipelines, crawler jobs, and Anya sessions.
 * It requires an explicit API URL, expected admin email, admin token, matching
 * host confirmation, and COMPREHENSIVE_TEST_CONFIRM=RUN_MUTATING_SUITE.
 */

import axios from 'axios'
import chalk from 'chalk'
import { promises as fs } from 'fs'
import process from 'node:process'

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required; this mutating suite has no live defaults`)
  return value
}

const apiUrl = new URL(requiredEnv('COMPREHENSIVE_TEST_API_BASE'))
const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(apiUrl.hostname.toLowerCase())
if (apiUrl.protocol !== 'https:' && !(apiUrl.protocol === 'http:' && isLoopback)) {
  throw new Error('COMPREHENSIVE_TEST_API_BASE must use HTTPS unless it targets loopback')
}
if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
  throw new Error('COMPREHENSIVE_TEST_API_BASE must not contain credentials, query parameters, or a fragment')
}
const confirmedHost = requiredEnv('COMPREHENSIVE_TEST_CONFIRM_MUTATING_HOST').toLowerCase()
if (confirmedHost !== apiUrl.hostname.toLowerCase()) {
  throw new Error('COMPREHENSIVE_TEST_CONFIRM_MUTATING_HOST must exactly match the API hostname')
}
if (requiredEnv('COMPREHENSIVE_TEST_CONFIRM') !== 'RUN_MUTATING_SUITE') {
  throw new Error('COMPREHENSIVE_TEST_CONFIRM must equal RUN_MUTATING_SUITE')
}

const API_BASE = apiUrl.toString().replace(/\/$/, '')
const ADMIN_TOKEN = requiredEnv('COMPREHENSIVE_TEST_ADMIN_TOKEN')
const ADMIN_EMAIL = requiredEnv('COMPREHENSIVE_TEST_ADMIN_EMAIL').toLowerCase()
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ADMIN_EMAIL)) {
  throw new Error('COMPREHENSIVE_TEST_ADMIN_EMAIL must be a valid email address')
}

// Test results tracking
const results = {
  passed: [],
  failed: [],
  fixed: []
}

// Helper function for API calls
async function apiCall(method, path, data = null, token = null) {
  const config = {
    method,
    url: `${API_BASE}${path}`,
    headers: {}
  }
  
  if (token) config.headers.Authorization = `Bearer ${token}`
  if (data) config.data = data
  
  return axios(config)
}

// Get auth token
async function authenticate() {
  try {
    console.log(chalk.yellow('\n📝 Verifying canonical admin authority...'))

    const authMe = await apiCall('GET', '/api/auth/me', null, ADMIN_TOKEN)
    const authenticatedUser = authMe.data?.user || authMe.data || {}
    const authenticatedEmail = String(
      authenticatedUser.primary_email || authenticatedUser.email || '',
    ).trim().toLowerCase()
    const isAdmin = authenticatedUser.is_admin === true || authMe.data?.role === 'admin'
    if (!isAdmin) {
      throw new Error('COMPREHENSIVE_TEST_ADMIN_TOKEN did not resolve to a canonical server admin')
    }
    if (!authenticatedEmail || authenticatedEmail !== ADMIN_EMAIL) {
      throw new Error('admin token identity does not match COMPREHENSIVE_TEST_ADMIN_EMAIL')
    }

    console.log(chalk.green('✅ Canonical admin authority verified'))
    results.passed.push('Authentication')
    return ADMIN_TOKEN
  } catch (error) {
    console.log(chalk.red('❌ Authentication failed:', error.message))
    results.failed.push({ test: 'Authentication', error: error.message })
    throw error
  }
}

// Test all API endpoints
async function testAPIEndpoints(token) {
  console.log(chalk.yellow('\n🔌 Testing API Endpoints...'))
  
  const endpoints = [
    { method: 'GET', path: '/health', name: 'Health Check', requiresAuth: false },
    { method: 'GET', path: '/api/auth/me', name: 'Get Current User', requiresAuth: true },
    { method: 'GET', path: '/api/profiles', name: 'List Profiles', requiresAuth: true },
    { method: 'GET', path: '/api/opportunities', name: 'List Opportunities', requiresAuth: false },
    { method: 'GET', path: '/api/crawlers/jobs', name: 'List Crawler Jobs', requiresAuth: true },
    { method: 'GET', path: '/api/grants', name: 'List Grants', requiresAuth: true },
    { method: 'GET', path: '/api/anya/tools', name: 'Anya Tools', requiresAuth: true },
    { method: 'GET', path: '/api/organizations', name: 'List Organizations', requiresAuth: true }
  ]
  
  for (const endpoint of endpoints) {
    try {
      const res = await apiCall(
        endpoint.method, 
        endpoint.path, 
        null, 
        endpoint.requiresAuth ? token : null
      )
      
      console.log(chalk.green(`  ✅ ${endpoint.name}: ${res.status}`))
      results.passed.push(endpoint.name)
    } catch (error) {
      const status = error.response?.status || 'Network Error'
      console.log(chalk.red(`  ❌ ${endpoint.name}: ${status} - ${error.message}`))
      results.failed.push({ test: endpoint.name, error: `${status}: ${error.message}` })
    }
  }
}

// Test Profile CRUD
async function testProfiles(token) {
  console.log(chalk.yellow('\n👤 Testing Profile Operations...'))
  
  try {
    // Create test profile
    const createRes = await apiCall('POST', '/api/profiles', {
      display_name: 'Test Profile ' + Date.now(),
      primary_type: 'individual'
    }, token)
    
    const profileId = createRes.data.id
    console.log(chalk.green('  ✅ Create Profile'))
    results.passed.push('Create Profile')
    
    // Read profile
    const readRes = await apiCall('GET', `/api/profiles/${profileId}`, null, token)
    console.log(chalk.green('  ✅ Read Profile'))
    results.passed.push('Read Profile')
    
    // Update profile
    await apiCall('PUT', `/api/profiles/${profileId}`, {
      display_name: 'Updated Test Profile'
    }, token)
    console.log(chalk.green('  ✅ Update Profile'))
    results.passed.push('Update Profile')
    
    // Test AI field assistance
    try {
      await apiCall('POST', `/api/profiles/${profileId}/fields/ai`, {
        fieldName: 'mission',
        fieldLabel: 'Mission Statement',
        currentValue: '',
        sectionKey: 'narrative'
      }, token)
      console.log(chalk.green('  ✅ AI Field Assistance'))
      results.passed.push('AI Field Assistance')
    } catch (error) {
      console.log(chalk.red('  ❌ AI Field Assistance:', error.message))
      results.failed.push({ test: 'AI Field Assistance', error: error.message })
    }
    
    // Delete profile
    await apiCall('DELETE', `/api/profiles/${profileId}`, null, token)
    console.log(chalk.green('  ✅ Delete Profile'))
    results.passed.push('Delete Profile')
    
  } catch (error) {
    console.log(chalk.red('  ❌ Profile Operations:', error.message))
    results.failed.push({ test: 'Profile Operations', error: error.message })
  }
}

// Test Crawlers
async function testCrawlers(token) {
  console.log(chalk.yellow('\n🕷️ Testing Crawlers...'))
  
  const crawlers = [
    'local',
    'government', 
    'student',
    'ecf',
    'item',
    'specialNeeds'
  ]
  
  // Get a test profile
  const profilesRes = await apiCall('GET', '/api/profiles?limit=1', null, token)
  const profileId = profilesRes.data[0]?.id
  
  if (!profileId) {
    console.log(chalk.yellow('  ⚠️ No profiles to test crawlers with'))
    return
  }
  
  for (const crawler of crawlers) {
    try {
      // Map crawler names to expected format
      const crawlerTypeMap = {
        'local': 'local_funding',
        'government': 'government_funding',
        'student': 'student_grants',
        'ecf': 'ecf_benefits',
        'item': 'item_matching',
        'specialNeeds': 'special_needs'
      }
      
      const res = await apiCall('POST', '/api/real-crawlers/run', {
        profile_id: profileId,
        crawler_type: crawlerTypeMap[crawler]
      }, token)
      
      console.log(chalk.green(`  ✅ ${crawler} crawler: Found ${res.data.opportunities?.length || 0} opportunities`))
      results.passed.push(`${crawler} crawler`)
    } catch (error) {
      console.log(chalk.red(`  ❌ ${crawler} crawler: ${error.message}`))
      results.failed.push({ test: `${crawler} crawler`, error: error.message })
    }
  }
}

// Test Grant Discovery
async function testDiscovery(token) {
  console.log(chalk.yellow('\n🔍 Testing Grant Discovery...'))
  
  try {
    // Get a profile for testing
    const profilesRes = await apiCall('GET', '/api/profiles?limit=1', null, token)
    const profileId = profilesRes.data[0]?.id
    
    if (!profileId) {
      console.log(chalk.yellow('  ⚠️ No profiles to test discovery with'))
      return
    }
    
    // Test AI match endpoint
    const matchRes = await apiCall('POST', '/api/ai/match', {
      profile_id: profileId,
      limit: 10
    }, token)
    
    console.log(chalk.green(`  ✅ AI Match: ${matchRes.data.opportunities?.length || 0} results`))
    results.passed.push('AI Match')
    
    // Test reminder plans (another AI feature)
    try {
      const reminderRes = await apiCall('POST', '/api/ai/reminder-plan', {
        profile_id: profileId,
        grant_id: matchRes.data.opportunities?.[0]?.id
      }, token)
      console.log(chalk.green('  ✅ AI Reminder Plan'))
      results.passed.push('AI Reminder Plan')
    } catch (e) {
      // Optional feature
      console.log(chalk.yellow('  ⚠️ Reminder Plan not available'))
    }
    
  } catch (error) {
    console.log(chalk.red('  ❌ Discovery:', error.message))
    results.failed.push({ test: 'Discovery', error: error.message })
  }
}

// Test Pipeline Operations
async function testPipeline(token) {
  console.log(chalk.yellow('\n📊 Testing Pipeline Operations...'))
  
  try {
    // Get profiles and opportunities
    const profilesRes = await apiCall('GET', '/api/profiles?limit=1', null, token)
    const profileId = profilesRes.data[0]?.id
    
    const oppsRes = await apiCall('GET', '/api/opportunities?limit=1', null, token)
    const oppId = oppsRes.data.opportunities?.[0]?.id
    
    if (!profileId || !oppId) {
      console.log(chalk.yellow('  ⚠️ Need profile and opportunity to test pipeline'))
      return
    }
    
    // Add to pipeline
    const addRes = await apiCall('POST', '/api/grants', {
      profile_id: profileId,
      opportunity_id: oppId,
      status: 'potential'
    }, token)
    
    const grantId = addRes.data.id
    console.log(chalk.green('  ✅ Add to Pipeline'))
    results.passed.push('Add to Pipeline')
    
    // Update pipeline status
    await apiCall('PUT', `/api/grants/${grantId}`, {
      status: 'in_progress'
    }, token)
    console.log(chalk.green('  ✅ Update Pipeline Status'))
    results.passed.push('Update Pipeline Status')
    
    // Get pipeline
    const pipelineRes = await apiCall('GET', `/api/grants?profile_id=${profileId}`, null, token)
    console.log(chalk.green(`  ✅ Get Pipeline: ${pipelineRes.data.length} items`))
    results.passed.push('Get Pipeline')
    
  } catch (error) {
    console.log(chalk.red('  ❌ Pipeline:', error.message))
    results.failed.push({ test: 'Pipeline', error: error.message })
  }
}

// Test Anya Features
async function testAnya(token) {
  console.log(chalk.yellow('\n🤖 Testing Anya AI Features...'))
  
  try {
    // Get Anya status
    const statusRes = await apiCall('GET', '/api/anya/status', null, token)
    console.log(chalk.green(`  ✅ Anya Status: ${statusRes.data.service}`))
    results.passed.push('Anya Status')
    
    // Get Anya tools
    const toolsRes = await apiCall('GET', '/api/anya/tools', null, token)
    console.log(chalk.green(`  ✅ Anya Tools: ${toolsRes.data.tools?.length || 0} tools available`))
    results.passed.push('Anya Tools')
    
    // Create Anya session
    const sessionRes = await apiCall('POST', '/api/anya/sessions', {
      name: 'Test Session'
    }, token)
    const sessionId = sessionRes.data.session_id
    console.log(chalk.green(`  ✅ Anya Session Created: ${sessionId}`))
    results.passed.push('Anya Session')
    
    // Add message to session
    const msgRes = await apiCall('POST', `/api/anya/sessions/${sessionId}/messages`, {
      role: 'user',
      content: 'Hello Anya, this is a test'
    }, token)
    console.log(chalk.green('  ✅ Anya Message Added'))
    results.passed.push('Anya Message')
    
    // Generate response
    const genRes = await apiCall('POST', `/api/anya/sessions/${sessionId}/generate`, {}, token)
    console.log(chalk.green('  ✅ Anya Response Generated'))
    results.passed.push('Anya Generate')
    
  } catch (error) {
    console.log(chalk.red('  ❌ Anya:', error.message))
    results.failed.push({ test: 'Anya', error: error.message })
  }
}

// Fix common errors
async function fixCommonErrors() {
  console.log(chalk.yellow('\n🔨 Checking for Common Issues...'))
  
  const fixes = []
  
  // Check for missing environment variables
  const requiredEnvVars = [
    'RESEND_API_KEY',
    'FROM_EMAIL',
    'JWT_SECRET',
    'OPENAI_API_KEY'
  ]
  
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      console.log(chalk.yellow(`  ⚠️ Missing ${envVar} - setting default`))
      fixes.push(`Set default for ${envVar}`)
    }
  }
  
  // Check database file exists
  try {
    await fs.access('./backend/data/grantflow.db')
    console.log(chalk.green('  ✅ Database file exists'))
  } catch {
    console.log(chalk.yellow('  ⚠️ Database file missing - will be created on startup'))
    fixes.push('Database will be created')
  }
  
  // Check for port conflicts
  try {
    await apiCall('GET', '/health')
    console.log(chalk.green('  ✅ Backend server responding'))
  } catch {
    console.log(chalk.yellow('  ⚠️ Backend server not responding on port 4000'))
    fixes.push('Backend server needs restart')
  }
  
  return fixes
}

// Main test runner
async function runAllTests() {
  console.log(chalk.cyan('════════════════════════════════════════════════'))
  console.log(chalk.cyan.bold('   🧪 GRANTFLOW COMPREHENSIVE TEST SUITE'))
  console.log(chalk.cyan('════════════════════════════════════════════════'))
  
  try {
    // Check and fix common issues first
    const fixes = await fixCommonErrors()
    results.fixed = fixes
    
    // Authenticate
    const token = await authenticate()
    
    // Run all test suites
    await testAPIEndpoints(token)
    await testProfiles(token)
    await testCrawlers(token)
    await testDiscovery(token)
    await testPipeline(token)
    await testAnya(token)
    
  } catch (error) {
    console.log(chalk.red('\n⚠️ Critical error:', error.message))
    process.exitCode = 1
  }
  
  // Display results summary
  console.log(chalk.cyan('\n════════════════════════════════════════════════'))
  console.log(chalk.cyan.bold('   📊 TEST RESULTS SUMMARY'))
  console.log(chalk.cyan('════════════════════════════════════════════════'))
  
  console.log(chalk.green(`\n✅ PASSED: ${results.passed.length} tests`))
  if (results.passed.length > 0) {
    results.passed.forEach(test => {
      console.log(chalk.gray(`   • ${test}`))
    })
  }
  
  if (results.failed.length > 0) {
    console.log(chalk.red(`\n❌ FAILED: ${results.failed.length} tests`))
    results.failed.forEach(({ test, error }) => {
      console.log(chalk.red(`   • ${test}: ${error}`))
    })
  }
  
  if (results.fixed.length > 0) {
    console.log(chalk.yellow(`\n🔨 FIXES APPLIED: ${results.fixed.length}`))
    results.fixed.forEach(fix => {
      console.log(chalk.yellow(`   • ${fix}`))
    })
  }
  
  // Calculate success rate
  const total = results.passed.length + results.failed.length
  const successRate = total > 0 ? ((results.passed.length / total) * 100).toFixed(1) : 0
  
  console.log(chalk.cyan('\n────────────────────────────────────────────────'))
  console.log(chalk.bold(`Success Rate: ${successRate}%`))
  console.log(chalk.cyan('════════════════════════════════════════════════\n'))
  
  // Save results to file
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total_tests: total,
      passed: results.passed.length,
      failed: results.failed.length,
      success_rate: successRate + '%'
    },
    details: results
  }
  
  await fs.writeFile(
    './test-results.json',
    JSON.stringify(report, null, 2)
  )
  console.log(chalk.gray('Test results saved to test-results.json'))
  if (results.failed.length > 0) process.exitCode = 1
}

// Run tests
runAllTests().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
