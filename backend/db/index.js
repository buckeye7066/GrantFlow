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

function applyMigrations(db) {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8')
  db.exec(schema)
  try {
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
