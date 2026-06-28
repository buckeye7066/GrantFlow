#!/usr/bin/env node

/**
 * Ensures the admin user exists in the database with the correct credentials.
 * This script is idempotent and can be run multiple times safely.
 * 
 * Usage:
 *   node scripts/ensure-admin-user.mjs
 *   ADMIN_EMAIL=custom@email.com ADMIN_PHONE=+1234567890 node scripts/ensure-admin-user.mjs
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.invalid'
const ADMIN_PHONE = process.env.ADMIN_PHONE || '+15550101000'
const ADMIN_NAME = process.env.ADMIN_NAME || 'GrantFlow Admin'

function resolveDbPath() {
  const envPath = process.env.DB_PATH
  if (envPath && envPath.trim().length > 0) {
    return path.resolve(process.cwd(), envPath.trim())
  }
  return path.resolve(__dirname, '../backend/data/grantflow.db')
}

const dbPath = resolveDbPath()

try {
  const db = new Database(dbPath)
  
  // Check if admin user exists with this email
  const existingUser = db
    .prepare('SELECT id, is_admin FROM users WHERE primary_email = ?')
    .get(ADMIN_EMAIL)
  
  if (existingUser) {
    // Update existing user to be admin
    if (!existingUser.is_admin) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existingUser.id)
      console.log(`✓ Updated existing user ${existingUser.id} to admin status`)
    } else {
      console.log(`✓ Admin user already exists with email ${ADMIN_EMAIL}`)
    }
    
    // Update phone if different
    db.prepare('UPDATE users SET primary_phone = ? WHERE id = ?').run(ADMIN_PHONE, existingUser.id)
  } else {
    // Create new admin user
    const userId = `admin-${Date.now()}`
    db.prepare(`
      INSERT INTO users (id, display_name, primary_email, primary_phone, is_admin)
      VALUES (?, ?, ?, ?, 1)
    `).run(userId, ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE)
    
    console.log(`✓ Created new admin user with email ${ADMIN_EMAIL}`)
  }
  
  // Verify admin user
  const adminUser = db
    .prepare('SELECT id, display_name, primary_email, primary_phone, is_admin FROM users WHERE primary_email = ?')
    .get(ADMIN_EMAIL)
  
  console.log('\nAdmin user details:')
  console.log(`  ID: ${adminUser.id}`)
  console.log(`  Name: ${adminUser.display_name}`)
  console.log(`  Email: ${adminUser.primary_email}`)
  console.log(`  Phone: ${adminUser.primary_phone}`)
  console.log(`  Is Admin: ${adminUser.is_admin === 1 ? 'Yes' : 'No'}`)
  
  db.close()
  process.exit(0)
} catch (error) {
  console.error('Error ensuring admin user:', error.message)
  process.exit(1)
}
