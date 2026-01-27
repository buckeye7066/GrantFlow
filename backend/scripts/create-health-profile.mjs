import Database from 'better-sqlite3'
import crypto from 'crypto'
import fs from 'fs'

// Ensure local data directory exists; sqlite will create the db file.
if (!fs.existsSync('./data')) {
  fs.mkdirSync('./data', { recursive: true })
}

const db = new Database('./data/grantflow.db')

console.log('=== Creating Health-Oriented Profile (seed) ===\n')

// Ensure schema exists when running against a fresh local DB.
try {
  const hasProfilesTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profiles' LIMIT 1")
    .get()
  if (!hasProfilesTable) {
    const schemaSql = fs.readFileSync('./backend/db/schema.sql', 'utf8')
    db.exec(schemaSql)
    console.log('✓ Initialized database schema (backend/db/schema.sql)')
  }
} catch (error) {
  console.warn('⚠️ Could not auto-initialize schema. If this is a fresh environment, run: node scripts/build-seed-db.mjs')
  console.warn('   Error:', error?.message || String(error))
}

// Check if a matching profile already exists (idempotent).
const existing = db.prepare("SELECT id FROM profiles WHERE display_name LIKE '%Health Demo%' LIMIT 1").get()
if (existing?.id) {
  console.log('Profile already exists:', existing.id)
  db.close()
  process.exit(0)
}

const profileId = crypto.randomUUID()

db.prepare(`
  INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by)
  VALUES (?, 'Health Demo Profile', 'individual_need', 'active', ?, 'admin')
`).run(profileId, JSON.stringify(['health', 'medical', 'patient assistance']))

// Basic info (include location so state-based enrichment works)
const basicInfo = {
  full_name: 'Health Demo Profile',
  email: 'health.demo@example.com',
  phone: '',
  address: '123 Demo Street\nNashville, TN 37209',
  state: 'TN',
  zip: '37209',
}

// Health section with structured conditions + support needs + consent
const healthMedical = {
  conditions: [
    { name: 'Epilepsy' },
  ],
  support_needs: ['transportation', 'copay_assistance'],
  consent_for_studies: true,
  mobility_or_transport_notes: 'Needs help getting to appointments.',
  chronic_illness: true,
  chronic_illness_type: 'Epilepsy',
  disability_type: ['neurological'],
  support_needs_level: 'moderate',
  notes: 'Informational only. Used to match support resources.',
}

db.prepare(`
  INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
  VALUES (?, 'basic_information', ?, 'seed')
`).run(profileId, JSON.stringify(basicInfo))

db.prepare(`
  INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
  VALUES (?, 'health_medical', ?, 'seed')
`).run(profileId, JSON.stringify(healthMedical))

console.log('✅ Created health profile:')
console.log('   Profile ID:', profileId)
console.log('   View at: http://localhost:5173/grantflow/profile/' + profileId)
console.log('')
console.log('Next:')
console.log('- Log in and open this profile → Health tab to see resources.')
console.log("- Auto-discovery will queue a 'health_resources' job on login because indicators exist.")

db.close()

