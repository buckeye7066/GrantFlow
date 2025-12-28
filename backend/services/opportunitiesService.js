import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const DB_PATH = path.resolve('backend/data/grantflow.db')
const JSON_PATH = path.resolve('backend/data/opportunities.json')

function tryInitSqlite() {
  if (!fs.existsSync(DB_PATH)) return null
  try {
    const Sqlite = require('better-sqlite3')
    return new Sqlite(DB_PATH, { readonly: true })
  } catch {
    return null
  }
}

const db = tryInitSqlite()

export function getOpportunities() {
  if (db) {
    try {
      return db
        .prepare(
          `
          SELECT
            id,
            name,
            type,
            description,
            amount,
            deadline,
            url,
            address,
            phone,
            email,
            website,
            source,
            created_at
          FROM funding_sources
          ORDER BY created_at DESC
        `,
        )
        .all()
    } catch {
      // fall through to JSON
    }
  }

  if (fs.existsSync(JSON_PATH)) {
    try {
      const raw = fs.readFileSync(JSON_PATH, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return []
    }
  }

  return []
}
