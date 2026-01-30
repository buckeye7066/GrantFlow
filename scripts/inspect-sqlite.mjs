#!/usr/bin/env node
/**
 * Inspect a SQLite database file.
 *
 * Usage:
 *   node scripts/inspect-sqlite.mjs /path/to/file.db
 */

import process from 'node:process'
import Database from 'better-sqlite3'

const dbPath = process.argv[2] ? String(process.argv[2]) : null
if (!dbPath) {
  console.error('[inspect-sqlite] Missing db path argument.')
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((row) => row.name)

const countFor = (name) => {
  try {
    const row = db.prepare(`SELECT COUNT(1) AS c FROM ${name}`).get()
    return Number(row?.c ?? 0) || 0
  } catch {
    return null
  }
}

const tableCounts = Object.fromEntries(tables.map((t) => [t, countFor(t)]))

console.log(
  JSON.stringify(
    {
      db: dbPath,
      tables,
      tableCounts,
    },
    null,
    2,
  ),
)

