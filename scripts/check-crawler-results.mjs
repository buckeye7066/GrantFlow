#!/usr/bin/env node
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const dbPath = join(__dirname, '..', 'backend', 'data', 'grantflow.db')
const db = new Database(dbPath, { readonly: true })

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

// Check pipeline entries
const pipelineCount = db.prepare('SELECT COUNT(*) as count FROM grant_pipeline').get()
console.log(`\n=== PIPELINE ENTRIES ===`)
console.log(`Total pipeline items: ${pipelineCount.count}`)

// Check pipeline by profile
const pipelineByProfile = db.prepare(`
  SELECT p.display_name, COUNT(gp.id) as count
  FROM profiles p
  LEFT JOIN grant_pipeline gp ON p.id = gp.profile_id
  GROUP BY p.id
  HAVING count > 0
  LIMIT 5
`).all()

if (pipelineByProfile.length > 0) {
  console.log('\nProfiles with pipeline items:')
  pipelineByProfile.forEach(p => {
    console.log(`  - ${p.display_name}: ${p.count} items`)
  })
}

// Check high match scores
const highMatches = db.prepare(`
  SELECT gp.match_score, o.title, p.display_name
  FROM grant_pipeline gp
  JOIN funding_opportunities o ON gp.grant_id = o.id
  JOIN profiles p ON gp.profile_id = p.id
  WHERE gp.match_score >= 80
  LIMIT 5
`).all()

if (highMatches.length > 0) {
  console.log('\nHigh match items (≥80%):')
  highMatches.forEach(m => {
    console.log(`  - ${m.match_score}%: ${m.title}`)
    console.log(`    Profile: ${m.display_name}`)
  })
}

db.close()
console.log('\n✓ Database check complete!')