#!/usr/bin/env node
/**
 * Promote a local user to admin in the SQLite database.
 *
 * Usage:
 *   node scripts/promote-admin.mjs admin@example.com
 */

import process from 'node:process'
import Database from 'better-sqlite3'

const email = process.argv[2]
if (!email) {
  console.error('Usage: node scripts/promote-admin.mjs <email>')
  process.exit(1)
}

const db = new Database('backend/data/grantflow.db')

const before = db
  .prepare('SELECT id, primary_email, is_admin FROM users WHERE primary_email = ?')
  .get(email)
if (!before) {
  console.error(`No user found for email: ${email}`)
  process.exit(1)
}

db.prepare('UPDATE users SET is_admin = 1 WHERE primary_email = ?').run(email)

const after = db
  .prepare('SELECT id, primary_email, is_admin FROM users WHERE primary_email = ?')
  .get(email)
console.log({ before, after })
