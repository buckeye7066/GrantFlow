#!/usr/bin/env node

/**
 * Stability Hardening Verification Script
 * 
 * Tests all 14 stability fixes to ensure they work as expected.
 */

import { db } from '../backend/db/index.js'
import { cleanupStaleCrawlers } from '../backend/services/crawlerConcurrencyGuard.js'
import { markExhaustedJobs } from '../backend/services/jobBackpressure.js'

console.log('=== Stability Hardening Verification ===\n')

// Sam runs this file as a registered PRODUCTION GATE
// (`PRODUCTION_GATE_NODE_SCRIPTS` in backend/services/sam/samRegistry.js), and
// `samAgent.formatGate` derives the verdict PURELY from the exit code:
//   status: result.skipped ? 'skipped' : (result.ok ? 'passed' : 'failed')
// Nothing reads stdout. So a script that printed every failure as a `❌` line
// and then exited 0 was a gate that COULD NOT FAIL: measured 2026-08-19 against
// an empty SQLite database, all 8 required tables missing, `is_admin` missing,
// dead_letter_queue missing and anya_runs missing still produced
// "All critical stability checks completed." and EXIT 0 — recorded by Sam as
// `passed`. The old summary line ("Review output above for any ❌") delegated
// the verdict to a human reader that this call path does not have.
//
// Every hard failure is now recorded and the process exits non-zero. `⚠️`
// stays advisory on purpose (dev-only JWT secret, optional migrations,
// best-effort counts) so the gate reddens on facts, not on posture.
const criticalFailures = []
function fail(message) {
  criticalFailures.push(message)
  console.log(`   ❌ ${message}`)
}

// 1. Check ENV validation
console.log('1. ENV Validation:')
const jwtSecret = process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET
if (jwtSecret && jwtSecret !== 'grantflow-dev-secret') {
  console.log('   ✅ JWT_SECRET configured')
} else {
  console.log('   ⚠️  JWT_SECRET missing or insecure (dev only)')
}

// 2. Check DB connectivity
console.log('\n2. Database Connectivity:')
try {
  const result = await db.healthcheck()
  if (result.ok) {
    console.log(`   ✅ Database connected (${result.dialect})`)
  }
} catch (error) {
  console.log('   ❌ Database connection failed:', error.message)
  process.exit(1)
}

// 3. Check required tables
console.log('\n3. Required Tables:')
const requiredTables = [
  'users',
  'profiles',
  // The canonical catalog table is `funding_opportunities` (schema.sql:136).
  // This list said `opportunities`, which has never existed in this schema and
  // is referenced by no runtime query — so the gate printed
  // "❌ opportunities (missing or error)" on EVERY run against a perfectly
  // healthy database, and exited 0 anyway. A gate that is permanently red and
  // permanently reported as `passed` is how a stale entry survives: nothing
  // could tell the two apart until the exit code started to mean something.
  'funding_opportunities',
  'grants',
  'organizations',
  'crawler_jobs',
  'dead_letter_queue',
  'anya_runs',
]

for (const table of requiredTables) {
  try {
    await db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
    console.log(`   ✅ ${table}`)
  } catch (error) {
    fail(`required table ${table} is missing or unreadable: ${error.message}`)
  }
}

// 4. Check users.is_admin column
console.log('\n4. Admin Column:')
try {
  const adminCount = await db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1').get()
  console.log(`   ✅ is_admin column exists (${adminCount.count} admins)`)
} catch (error) {
  fail(`users.is_admin column missing or unreadable: ${error.message}`)
}

// 5. Check crawler_jobs schema
console.log('\n5. Crawler Jobs Schema:')
try {
  const job = await db.prepare(`
    SELECT id, status, idempotency_key, profile_context_snapshot, retry_count
    FROM crawler_jobs
    LIMIT 1
  `).get()
  console.log('   ✅ crawler_jobs has idempotency_key, profile_context_snapshot, retry_count')
} catch (error) {
  console.log('   ⚠️  crawler_jobs schema may need migration:', error.message)
}

// 6. Check dead_letter_queue schema
console.log('\n6. Dead Letter Queue:')
try {
  const failures = await db.prepare(`
    SELECT COUNT(*) as count 
    FROM dead_letter_queue 
    WHERE resolved = FALSE
  `).get()
  console.log(`   ✅ Dead letter queue exists (${failures.count} unresolved)`)
} catch (error) {
  fail(`dead_letter_queue missing or unreadable: ${error.message}`)
}

// 7. Check anya_runs schema
console.log('\n7. Anya Runs:')
try {
  const runs = await db.prepare(`
    SELECT COUNT(*) as count, mode, status
    FROM anya_runs
    GROUP BY mode, status
  `).all()
  console.log(`   ✅ Anya runs table exists (${runs.length} mode/status combinations)`)
} catch (error) {
  fail(`anya_runs missing or unreadable: ${error.message}`)
}

// 8. Check grant statuses
console.log('\n8. Grant Status Enums:')
try {
  const statuses = await db.prepare(`
    SELECT DISTINCT status 
    FROM grants 
    WHERE status IS NOT NULL
    ORDER BY status
  `).all()
  const validStatuses = [
    'discovered', 'interested', 'drafting', 'app_prep', 'revision',
    'submission_ready', 'submitted', 'under_review', 'awarded', 'rejected', 'withdrawn'
  ]
  console.log('   Valid statuses:', validStatuses.join(', '))
  console.log('   Used statuses:', statuses.map(s => s.status).join(', ') || 'none')
  console.log('   ✅ Grant status enum documented')
} catch (error) {
  console.log('   ⚠️  Could not check grant statuses')
}

// 9. Test stale crawler cleanup
console.log('\n9. Stale Crawler Cleanup:')
try {
  const cleaned = await cleanupStaleCrawlers(db, 30 * 60 * 1000) // 30 min threshold
  console.log(`   ✅ Cleanup function works (cleaned ${cleaned} stale jobs)`)
} catch (error) {
  fail(`stale-crawler cleanup failed: ${error.message}`)
}

// 10. Test exhausted job marking
console.log('\n10. Exhausted Job Marking:')
try {
  const marked = await markExhaustedJobs(db)
  console.log(`   ✅ Exhausted job marking works (marked ${marked} jobs)`)
} catch (error) {
  fail(`exhausted-job marking failed: ${error.message}`)
}

// 11. Check for running crawlers
console.log('\n11. Running Crawlers:')
try {
  const running = await db.prepare(`
    SELECT COUNT(*) as count 
    FROM crawler_jobs 
    WHERE status IN ('queued', 'running')
  `).get()
  console.log(`   ℹ️  ${running.count} jobs currently queued or running`)
} catch (error) {
  console.log('   ⚠️  Could not check running crawlers')
}

// 12. Summary
console.log('\n=== Summary ===')
if (criticalFailures.length > 0) {
  console.log(`FAILED: ${criticalFailures.length} critical stability check(s) did not pass.`)
  for (const message of criticalFailures) console.log(`  - ${message}`)
  console.log('')
} else {
  console.log('All critical stability checks passed.')
  console.log('Review output above for any ⚠️  advisories.\n')
}

// Close DB connection
if (db.close) {
  await db.close()
}

process.exit(criticalFailures.length > 0 ? 1 : 0)
