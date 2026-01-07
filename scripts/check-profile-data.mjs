import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DB_PATH = join(__dirname, '../seed/grantflow.db')
const db = new Database(DB_PATH)

console.log('=== Profile Data Check ===\n')

// Get profiles
const profiles = db.prepare('SELECT * FROM profiles').all()
console.log(`Found ${profiles.length} profiles:`)
profiles.forEach(p => {
  console.log(`\n  Profile: ${p.display_name}`)
  console.log(`    ID: ${p.id}`)
  console.log(`    Type: ${p.primary_type}`)
  console.log(`    Organization ID: ${p.organization_id}`)
  
  // Get sections
  const sections = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(p.id)
  console.log(`    Sections: ${sections.length}`)
  sections.forEach(s => {
    const data = JSON.parse(s.data)
    console.log(`      - ${s.section_key}:`, JSON.stringify(data).substring(0, 100))
  })
  
  // Get organization data
  if (p.organization_id) {
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(p.organization_id)
    if (org) {
      console.log(`    Organization:`)
      console.log(`      Name: ${org.name}`)
      console.log(`      State: ${org.state}`)
      console.log(`      Type: ${org.organization_type}`)
      console.log(`      Mission: ${org.mission?.substring(0, 50)}...`)
    }
  }
})

// Get opportunities
const oppCount = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get()
console.log(`\n\nFound ${oppCount.count} funding opportunities`)

// Sample some opportunities
const sampleOpps = db.prepare('SELECT title, sponsor, state, categories, keywords FROM funding_opportunities LIMIT 3').all()
sampleOpps.forEach(o => {
  console.log(`\n  Opportunity: ${o.title}`)
  console.log(`    Sponsor: ${o.sponsor}`)
  console.log(`    State: ${o.state}`)
  console.log(`    Categories: ${o.categories}`)
  console.log(`    Keywords: ${o.keywords?.substring(0, 80)}`)
})

db.close()
