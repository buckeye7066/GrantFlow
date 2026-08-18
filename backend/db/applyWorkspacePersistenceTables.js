/**
 * Apply workspace persistence DDL after schema.sql so a fresh local SQLite
 * file has consultant + catalog tables without a separate `npm run migrate`.
 * Numbered migrations 174/175 (and Postgres 0179/0180) remain the prod path;
 * this file is IF NOT EXISTS and safe to run twice.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const extrasPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workspacePersistenceTables.sql')

export function applyWorkspacePersistenceTablesSync(db) {
  if (!db || !fs.existsSync(extrasPath)) return
  db.exec(fs.readFileSync(extrasPath, 'utf8'))
}

export async function applyWorkspacePersistenceTables(db) {
  if (!db || !fs.existsSync(extrasPath)) return
  await db.exec(fs.readFileSync(extrasPath, 'utf8'))
}
