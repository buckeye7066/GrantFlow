import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import Database from 'better-sqlite3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_PATH = path.resolve(__dirname, '../data/grantflow.db')
const SCHEMA_PATH = path.resolve(__dirname, 'schema.sql')

let db = null

/**
 * Initialize database connection and run migrations
 */
export function initDb() {
  if (db) return db

  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH)
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  // Run schema migrations
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8')
  db.exec(schema)

  return db
}

/**
 * Get database instance
 */
export function getDb() {
  if (!db) {
    initDb()
  }
  return db
}

/**
 * Close database connection
 */
export function closeDb() {
  if (db) {
    db.close()
    db = null
  }
}

// Profile CRUD operations

export function getAllProfiles() {
  const db = getDb()
  return db.prepare('SELECT * FROM profiles ORDER BY updated_at DESC').all()
}

export function getProfileById(id) {
  const db = getDb()
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id)
}

export function createProfile(profile) {
  const db = getDb()
  const now = new Date().toISOString()
  const stmt = db.prepare(`
    INSERT INTO profiles (
      id, profile_type, display_name, notes, created_at, updated_at,
      full_name, dob, address_line1, address_line2, city, state, zip
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  
  stmt.run(
    profile.id,
    profile.profile_type || 'organization',
    profile.display_name,
    profile.notes || '',
    now,
    now,
    profile.full_name || null,
    profile.dob || null,
    profile.address_line1 || null,
    profile.address_line2 || null,
    profile.city || null,
    profile.state || null,
    profile.zip || null
  )
  
  return getProfileById(profile.id)
}

export function updateProfile(id, updates) {
  const db = getDb()
  const now = new Date().toISOString()
  
  const fields = []
  const values = []
  
  const allowedFields = [
    'profile_type', 'display_name', 'notes', 'full_name', 'dob',
    'address_line1', 'address_line2', 'city', 'state', 'zip'
  ]
  
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = ?`)
      values.push(updates[field])
    }
  }
  
  if (fields.length === 0) {
    return getProfileById(id)
  }
  
  fields.push('updated_at = ?')
  values.push(now, id)
  
  const stmt = db.prepare(`UPDATE profiles SET ${fields.join(', ')} WHERE id = ?`)
  stmt.run(...values)
  
  return getProfileById(id)
}

export function deleteProfile(id) {
  const db = getDb()
  const stmt = db.prepare('DELETE FROM profiles WHERE id = ?')
  const result = stmt.run(id)
  return result.changes > 0
}

// Document CRUD operations

export function getAllDocuments() {
  const db = getDb()
  return db.prepare('SELECT * FROM documents ORDER BY created_at DESC').all()
}

export function getDocumentById(id) {
  const db = getDb()
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id)
}

export function getDocumentsByProfileId(profileId) {
  const db = getDb()
  return db.prepare('SELECT * FROM documents WHERE profile_id = ? ORDER BY created_at DESC').all(profileId)
}

export function createDocument(document) {
  const db = getDb()
  const now = new Date().toISOString()
  
  const stmt = db.prepare(`
    INSERT INTO documents (
      id, profile_id, original_filename, mime_type, storage_path,
      sha256, size_bytes, status, doc_type, extracted_json,
      suggested_patches_json, applied_at, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  
  stmt.run(
    document.id,
    document.profile_id,
    document.original_filename,
    document.mime_type,
    document.storage_path,
    document.sha256,
    document.size_bytes,
    document.status || 'uploaded',
    document.doc_type || 'unknown',
    document.extracted_json || null,
    document.suggested_patches_json || null,
    document.applied_at || null,
    document.error || null,
    now,
    now
  )
  
  return getDocumentById(document.id)
}

export function updateDocument(id, updates) {
  const db = getDb()
  const now = new Date().toISOString()
  
  const fields = []
  const values = []
  
  const allowedFields = [
    'status', 'doc_type', 'extracted_json', 'suggested_patches_json',
    'applied_at', 'error'
  ]
  
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = ?`)
      values.push(updates[field])
    }
  }
  
  if (fields.length === 0) {
    return getDocumentById(id)
  }
  
  fields.push('updated_at = ?')
  values.push(now, id)
  
  const stmt = db.prepare(`UPDATE documents SET ${fields.join(', ')} WHERE id = ?`)
  stmt.run(...values)
  
  return getDocumentById(id)
}

export function deleteDocument(id) {
  const db = getDb()
  const stmt = db.prepare('DELETE FROM documents WHERE id = ?')
  const result = stmt.run(id)
  return result.changes > 0
}

// Transaction helper
export function runInTransaction(fn) {
  const db = getDb()
  return db.transaction(fn)()
}

export default {
  initDb,
  getDb,
  closeDb,
  getAllProfiles,
  getProfileById,
  createProfile,
  updateProfile,
  deleteProfile,
  getAllDocuments,
  getDocumentById,
  getDocumentsByProfileId,
  createDocument,
  updateDocument,
  deleteDocument,
  runInTransaction,
}
