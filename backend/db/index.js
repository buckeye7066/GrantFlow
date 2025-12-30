import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

let Database = null
let dependencyError = null

try {
  Database = (await import('better-sqlite3')).default
} catch (error) {
  dependencyError = error
  Database = null
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_PATH = path.resolve(__dirname, '..', 'data', 'grantflow.db')
const SCHEMA_PATH = path.join(__dirname, 'schema.sql')

let dbInstance = null

function ensureFundingSourceColumns(db) {
  const info = db.prepare('PRAGMA table_info(funding_sources)').all()
  const columns = new Set(info.map((column) => column.name))
  const additions = [
    { name: 'phone', type: 'TEXT' },
    { name: 'email', type: 'TEXT' },
    { name: 'address', type: 'TEXT' },
    { name: 'city', type: 'TEXT' },
    { name: 'state', type: 'TEXT' },
    { name: 'zip_code', type: 'TEXT' },
  ]

  for (const addition of additions) {
    if (!columns.has(addition.name)) {
      db.exec(`ALTER TABLE funding_sources ADD COLUMN ${addition.name} ${addition.type}`)
    }
  }
}

function ensureProfileColumns(db) {
  const info = db.prepare('PRAGMA table_info(profiles)').all()
  const columns = new Set(info.map((column) => column.name))
  const additions = [
    { name: 'contact_email', definition: 'TEXT' },
    { name: 'contact_phone', definition: 'TEXT' },
    { name: 'website', definition: 'TEXT' },
    { name: 'mission_statement', definition: 'TEXT' },
    { name: 'ein', definition: 'TEXT' },
    { name: 'duns', definition: 'TEXT' },
    { name: 'cage_code', definition: 'TEXT' },
    { name: 'naics_codes', definition: 'TEXT' },
    { name: 'annual_budget', definition: 'REAL' },
    { name: 'staff_count', definition: 'INTEGER' },
    { name: 'volunteer_count', definition: 'INTEGER' },
    { name: 'service_area', definition: 'TEXT' },
    { name: 'demographics_served', definition: 'TEXT' },
    { name: 'program_focus_areas', definition: 'TEXT' },
    { name: 'compliance_notes', definition: 'TEXT' },
    { name: 'certifications', definition: 'TEXT' },
    { name: 'phi_access_required', definition: 'INTEGER DEFAULT 0' },
    { name: 'created_by', definition: 'TEXT' },
    { name: 'owner_id', definition: 'TEXT' },
    { name: 'case_manager_id', definition: 'TEXT' },
    { name: 'admin_id', definition: 'TEXT' },
    { name: 'last_contacted_at', definition: 'TEXT' },
    { name: 'status', definition: "TEXT DEFAULT 'active'" },
    { name: 'job_title', definition: 'TEXT' },
  ]

  for (const addition of additions) {
    if (!columns.has(addition.name)) {
      db.exec(`ALTER TABLE profiles ADD COLUMN ${addition.name} ${addition.definition}`)
    }
  }
}

function applyMigrations(db) {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8')
  db.exec(schema)
  try {
    ensureProfileColumns(db)
    ensureFundingSourceColumns(db)
  } catch (error) {
    // ignore if table does not exist yet
  }
}

export function getDb() {
  if (!Database) {
    const message =
      'better-sqlite3 dependency is missing. Install it with "npm install better-sqlite3" to enable profile/document persistence.'
    const error = dependencyError ?? new Error(message)
    error.status = 500
    throw error
  }

  if (!dbInstance) {
    dbInstance = new Database(DB_PATH)
    dbInstance.pragma('journal_mode = WAL')
    applyMigrations(dbInstance)
  }
  return dbInstance
}

export function initDb() {
  // Initialize database if available
  if (isDatabaseAvailable()) {
    try {
      getDb()
    } catch (error) {
      console.error('Failed to initialize database:', error)
    }
  }
}

export function isDatabaseAvailable() {
  return Boolean(Database)
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}
