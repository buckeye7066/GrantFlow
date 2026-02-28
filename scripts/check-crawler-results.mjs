#!/usr/bin/env node
/**
 * Check crawler results and pipeline state from the DB.
 * For policy rejection counts (why 0 included): run a crawler via POST /api/real-crawlers/run
 * and inspect response.debug.validation_rejection_counts and response.debug.policy_rejections_db.
 * Usage: node scripts/check-crawler-results.mjs [--response path/to/crawler-response.json]
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const responseIdx = process.argv.indexOf('--response')
if (responseIdx !== -1 && process.argv[responseIdx + 1]) {
  const pathToJson = process.argv[responseIdx + 1]
  let data
  try {
    data = JSON.parse(readFileSync(pathToJson, 'utf8'))
  } catch (e) {
    console.error('Failed to read/parse', pathToJson, e.message)
    process.exit(1)
  }
  const count = data.count ?? data.opportunities?.length ?? 0
  const counts =
    data.debug?.live?.validation_rejection_counts ??
    data.debug?.validation_rejection_counts ??
    data.validation_rejection_counts ??
    {}
  const dbRejections = data.debug?.policy_rejections_db ?? data.debug?.db?.policy_rejection_counts ?? {}
  console.log('=== CRAWLER RESPONSE SUMMARY ===')
  console.log('Returned count:', count)
  console.log('Policy rejection counts:', Object.keys(counts).length ? counts : '(none)')
  const topReasons = Object.entries({ ...counts, ...dbRejections })
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
  if (topReasons.length) {
    console.log('Top rejection reasons:')
    topReasons.forEach(([reason, n]) => console.log(`  ${reason}: ${n}`))
  }
  process.exit(0)
}

const dbPath = join(__dirname, '..', 'backend', 'data', 'grantflow.db')
let db
try {
  db = new Database(dbPath, { readonly: true })
} catch (e) {
  console.log('Database not found at', dbPath, '- skip or run with valid DB.')
  process.exit(0)
}

console.log('=== CRAWLER RESULTS CHECK ===\n')

// Check opportunities
const oppCount = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get()
console.log(`Total opportunities: ${oppCount.count}`)

// Sample opportunities
const sampleOpps = db.prepare('SELECT title, amount_min, amount_max, source FROM funding_opportunities LIMIT 5').all()
if (sampleOpps.length > 0) {
  console.log('\nSample opportunities:')
  sampleOpps.forEach(opp => {
    console.log(`  - ${opp.title}`)
    console.log(`    Amount: $${opp.amount_min} - $${opp.amount_max}`)
    console.log(`    Source: ${opp.source}`)
  })
}

// Check crawler jobs
console.log('\n=== CRAWLER JOB STATUS ===')
const jobStatus = db.prepare(`
  SELECT type, status, COUNT(*) as count 
  FROM crawler_jobs 
  GROUP BY type, status
`).all()

jobStatus.forEach(stat => {
  console.log(`  ${stat.type}: ${stat.status} (${stat.count})`)
})

// Check recent completed jobs
const recentCompleted = db.prepare(`
  SELECT type, profile_id, 
         json_extract(parameters, '$.inserted') as inserted,
         json_extract(parameters, '$.evaluated') as evaluated
  FROM crawler_jobs 
  WHERE status = 'completed'
  ORDER BY completed_at DESC
  LIMIT 5
`).all()

if (recentCompleted.length > 0) {
  console.log('\nRecent completed crawlers:')
  recentCompleted.forEach(job => {
    console.log(`  - ${job.type}: Evaluated ${job.evaluated || 0}, Inserted ${job.inserted || 0}`)
  })
}

// Check pipeline entries (grants table)
const pipelineCount = db.prepare('SELECT COUNT(*) as count FROM grants').get()
console.log(`\n=== PIPELINE ENTRIES (GRANTS) ===`)
console.log(`Total grant items: ${pipelineCount.count}`)

// Check grants by organization/profile (organizations.name, not display_name)
const grantsByOrg = db.prepare(`
  SELECT o.name, COUNT(g.id) as count
  FROM organizations o
  LEFT JOIN grants g ON o.id = g.organization_id
  GROUP BY o.id
  HAVING count > 0
  LIMIT 5
`).all()

if (grantsByOrg.length > 0) {
  console.log('\nOrganizations with grants:')
  grantsByOrg.forEach(org => {
    console.log(`  - ${org.name}: ${org.count} grants`)
  })
}

// Check recent grants added (organizations.name)
const recentGrants = db.prepare(`
  SELECT g.title, g.status, g.notes, o.name
  FROM grants g
  JOIN organizations o ON g.organization_id = o.id
  WHERE g.notes LIKE '%Auto-added%'
  ORDER BY g.created_at DESC
  LIMIT 5
`).all()

if (recentGrants.length > 0) {
  console.log('\nRecent auto-added grants:')
  recentGrants.forEach(g => {
    console.log(`  - ${g.title}`)
    console.log(`    Org: ${g.name}`)
    console.log(`    Status: ${g.status}`)
  })
}

db.close()
console.log('\n✓ Database check complete!')
console.log('\n--- Policy / debug ---')
console.log('To see returned count, policy rejection counts, and top rejection reasons:')
console.log('  1. POST /api/real-crawlers/run with profile_id and crawler_type')
console.log('  2. response.count = returned opportunities')
console.log('  3. response.debug.validation_rejection_counts = policy_rejections by reason')
console.log('  4. response.debug.policy_rejections_db = DB-path policy rejections')
console.log('To print summary from a saved response: node scripts/check-crawler-results.mjs --response <path-to-json>')