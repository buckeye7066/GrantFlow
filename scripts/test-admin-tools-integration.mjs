#!/usr/bin/env node
/**
 * Test specific admin tools with a database connection
 */

import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { invokeTool } from '../backend/services/anyaToolRegistry.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dbPath = path.join(__dirname, '..', 'backend', 'data', 'grantflow.db')

console.log('🧪 Testing Admin Tools with Database...\n')

let db
try {
  db = new Database(dbPath, { readonly: true })
  console.log('✓ Database connected\n')
} catch (error) {
  console.log('⚠ Database not found, using mock context\n')
  db = null
}

const adminUser = { role: 'admin', userId: 'test-admin' }

// Test 1: admin.db.stats
console.log('Test 1: admin.db.stats')
try {
  const result = await invokeTool('admin.db.stats', {}, { user: adminUser, db })
  console.log('  ✓ Successfully retrieved database stats')
  if (result.output?.tables) {
    console.log(`  ✓ Found ${result.output.tables} tables`)
  }
  if (result.output?.table_counts) {
    const tableNames = Object.keys(result.output.table_counts)
    console.log(`  ✓ Table counts for: ${tableNames.slice(0, 3).join(', ')}...`)
  }
} catch (error) {
  if (!db) {
    console.log('  ⚠ Skipped (no database)')
  } else {
    console.error(`  ✗ Failed: ${error.message}`)
  }
}

// Test 2: admin.health.check
console.log('\nTest 2: admin.health.check')
try {
  const result = await invokeTool('admin.health.check', {}, { user: adminUser, db })
  console.log('  ✓ Health check completed')
  console.log(`  ✓ Status: ${result.output?.status}`)
  if (result.output?.services) {
    const services = Object.keys(result.output.services)
    console.log(`  ✓ Checked services: ${services.join(', ')}`)
  }
} catch (error) {
  console.error(`  ✗ Failed: ${error.message}`)
}

// Test 3: admin.crawler.list
console.log('\nTest 3: admin.crawler.list')
try {
  const result = await invokeTool(
    'admin.crawler.list',
    { limit: 5 },
    { user: adminUser, db },
  )
  console.log('  ✓ Successfully listed crawler jobs')
  console.log(`  ✓ Found ${result.output?.count || 0} jobs (limit: ${result.output?.limit})`)
} catch (error) {
  if (!db) {
    console.log('  ⚠ Skipped (no database)')
  } else {
    console.error(`  ✗ Failed: ${error.message}`)
  }
}

// Test 4: admin.db.query with invalid query (should fail)
console.log('\nTest 4: admin.db.query with UPDATE (should fail)')
try {
  await invokeTool(
    'admin.db.query',
    { sql: 'UPDATE users SET name = "hacked"' },
    { user: adminUser, db },
  )
  console.error('  ✗ Should have blocked UPDATE query')
} catch (error) {
  if (error.message.includes('Only SELECT')) {
    console.log('  ✓ Successfully blocked non-SELECT query')
  } else if (!db) {
    console.log('  ⚠ Skipped (no database)')
  } else {
    console.error(`  ✗ Unexpected error: ${error.message}`)
  }
}

// Test 5: admin.code.crawl
console.log('\nTest 5: admin.code.crawl')
try {
  const result = await invokeTool(
    'admin.code.crawl',
    { pattern: 'console\\.log', directory: 'backend', includeTests: false },
    { user: adminUser },
  )
  console.log('  ✓ Code crawl completed')
  console.log(`  ✓ Findings: ${result.output?.findings_count || 0}`)
  if (result.output?.findings && result.output.findings.length > 0) {
    console.log(`  ✓ First finding: ${result.output.findings[0].file}:${result.output.findings[0].line}`)
  }
} catch (error) {
  console.error(`  ✗ Failed: ${error.message}`)
}

if (db) {
  db.close()
}

console.log('\n✅ Admin tool integration tests complete!')
