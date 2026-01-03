#!/usr/bin/env node
/**
 * Simple smoke test for Anya admin tools
 * Tests that admin tools are registered and access control works
 * 
 * NOTE: This script must be run from the project root directory:
 *   node scripts/test-admin-tools.mjs
 */

import { listToolMetadata, invokeTool } from '../backend/services/anyaToolRegistry.js'

console.log('🧪 Testing Anya Admin Tools...\n')

// Test 1: List tools for regular user (should not include admin tools)
console.log('Test 1: Regular user should not see admin tools')
const regularUserTools = listToolMetadata({ role: 'user' })
const regularUserAdminTools = regularUserTools.filter((t) => t.requiresAdmin)
console.log(`  ✓ Regular user sees ${regularUserTools.length} tools`)
console.log(`  ✓ Admin tools visible: ${regularUserAdminTools.length} (expected: 0)`)
if (regularUserAdminTools.length > 0) {
  console.error('  ✗ FAIL: Regular user should not see admin tools')
  process.exit(1)
}

// Test 2: List tools for admin user (should include admin tools)
console.log('\nTest 2: Admin user should see admin tools')
const adminUserTools = listToolMetadata({ role: 'admin' })
const adminOnlyTools = adminUserTools.filter((t) => t.requiresAdmin)
console.log(`  ✓ Admin user sees ${adminUserTools.length} tools`)
console.log(`  ✓ Admin-only tools visible: ${adminOnlyTools.length}`)
if (adminOnlyTools.length === 0) {
  console.error('  ✗ FAIL: Admin user should see admin tools')
  process.exit(1)
}

// Test 3: Verify specific admin tools are registered
console.log('\nTest 3: Verify admin tool categories')
const expectedAdminTools = [
  'admin.code.crawl',
  'admin.code.lint',
  'admin.crawler.list',
  'admin.crawler.run',
  'admin.db.query',
  'admin.db.stats',
  'admin.health.check',
]

const adminToolNames = adminOnlyTools.map((t) => t.name)
let allFound = true
for (const toolName of expectedAdminTools) {
  if (adminToolNames.includes(toolName)) {
    console.log(`  ✓ ${toolName} registered`)
  } else {
    console.error(`  ✗ ${toolName} NOT FOUND`)
    allFound = false
  }
}

if (!allFound) {
  console.error('\n✗ FAIL: Some admin tools are missing')
  process.exit(1)
}

// Test 4: Verify access control - regular user cannot invoke admin tool
console.log('\nTest 4: Access control - regular user cannot invoke admin tools')
try {
  await invokeTool('admin.health.check', {}, { user: { role: 'user' } })
  console.error('  ✗ FAIL: Regular user should not be able to invoke admin tools')
  process.exit(1)
} catch (error) {
  if (error.status === 403 && error.message.includes('admin privileges')) {
    console.log('  ✓ Access denied for regular user (expected)')
  } else {
    console.error(`  ✗ FAIL: Unexpected error: ${error.message}`)
    process.exit(1)
  }
}

// Test 5: Verify admin can invoke admin tool
console.log('\nTest 5: Access control - admin user can invoke admin tools')
try {
  const result = await invokeTool('admin.health.check', {}, { user: { role: 'admin' } })
  console.log('  ✓ Admin successfully invoked admin.health.check')
  console.log(`  ✓ Result includes health status: ${result.output?.status || 'unknown'}`)
} catch (error) {
  console.error(`  ✗ FAIL: Admin should be able to invoke admin tools: ${error.message}`)
  process.exit(1)
}

// Test 6: Verify requiresAdmin flag is set correctly
console.log('\nTest 6: Verify requiresAdmin flag')
const allTools = listToolMetadata({ role: 'admin' })
const nonAdminTools = ['noop.echo', 'code.search', 'grants.summarizeMatches']
for (const toolName of nonAdminTools) {
  const tool = allTools.find((t) => t.name === toolName)
  if (tool && !tool.requiresAdmin) {
    console.log(`  ✓ ${toolName} is not admin-only (correct)`)
  } else if (!tool) {
    console.error(`  ✗ ${toolName} not found`)
    process.exit(1)
  } else {
    console.error(`  ✗ ${toolName} incorrectly marked as admin-only`)
    process.exit(1)
  }
}

console.log('\n✅ All tests passed!')
console.log(`\nSummary:`)
console.log(`  - Total tools: ${allTools.length}`)
console.log(`  - Admin-only tools: ${adminOnlyTools.length}`)
console.log(`  - Regular tools: ${allTools.length - adminOnlyTools.length}`)
console.log(`  - Access control: Working ✓`)
