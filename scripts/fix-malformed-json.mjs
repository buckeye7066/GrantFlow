#!/usr/bin/env node
/**
 * Fix Malformed JSON Fields
 * 
 * Converts comma-separated strings to proper JSON arrays for:
 * - profiles.interests
 * - profiles.tags
 * - organizations.focus_areas
 * - organizations.keywords
 * - organizations.program_areas
 */

import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../backend/data/grantflow.db')

console.log('=== Fix Malformed JSON Fields ===\n')
console.log('Database:', DB_PATH)

const db = new Database(DB_PATH)

/**
 * Safely parse array field - handles both JSON arrays and comma-separated strings
 */
function safeParseArrayField(value) {
  if (!value) return null
  if (typeof value !== 'string') return value
  
  const trimmed = value.trim()
  
  // Already a JSON array
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? JSON.stringify(parsed) : value
    } catch {
      // Invalid JSON, treat as comma-separated
    }
  }
  
  // Comma-separated string - convert to JSON array
  const items = trimmed.split(',').map(s => s.trim()).filter(Boolean)
  return JSON.stringify(items)
}

/**
 * Fix malformed JSON in a table column
 */
function fixTableColumn(tableName, columnName) {
  console.log(`\nFixing ${tableName}.${columnName}...`)
  
  // Get all rows with non-null values in this column
  const rows = db.prepare(`
    SELECT id, ${columnName} 
    FROM ${tableName} 
    WHERE ${columnName} IS NOT NULL AND ${columnName} != ''
  `).all()
  
  console.log(`Found ${rows.length} rows with data`)
  
  let fixed = 0
  let alreadyValid = 0
  
  for (const row of rows) {
    const value = row[columnName]
    
    // Skip if already valid JSON array
    if (value.trim().startsWith('[')) {
      try {
        JSON.parse(value)
        alreadyValid++
        continue
      } catch {
        // Will be fixed below
      }
    }
    
    // Convert to proper JSON array
    const fixedValue = safeParseArrayField(value)
    
    if (fixedValue !== value) {
      db.prepare(`
        UPDATE ${tableName}
        SET ${columnName} = ?
        WHERE id = ?
      `).run(fixedValue, row.id)
      fixed++
      
      if (fixed <= 3) {
        console.log(`  Example: "${value}" → "${fixedValue}"`)
      }
    }
  }
  
  console.log(`  ✅ Fixed: ${fixed}`)
  console.log(`  ✓ Already valid: ${alreadyValid}`)
}

// Fields to fix
const fieldsToFix = [
  { table: 'profiles', column: 'interests' },
  { table: 'profiles', column: 'tags' },
  { table: 'organizations', column: 'focus_areas' },
  { table: 'organizations', column: 'keywords' },
  { table: 'organizations', column: 'program_areas' },
]

console.log('Starting migration...')

for (const { table, column } of fieldsToFix) {
  try {
    fixTableColumn(table, column)
  } catch (error) {
    console.error(`Error fixing ${table}.${column}:`, error.message)
  }
}

console.log('\n=== Migration Complete ===')

db.close()
