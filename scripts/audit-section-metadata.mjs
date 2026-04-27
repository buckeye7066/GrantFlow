#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { SECTION_METADATA } from '../src/config/sectionMetadata.js'
import { DESIGNATED_PROFILES } from '../backend/config/designatedProfiles.js'

function collectFromProfile(profile, out) {
  for (const [sectionKey, data] of Object.entries(profile?.sections ?? {})) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    if (!out.has(sectionKey)) out.set(sectionKey, new Set())
    for (const key of Object.keys(data)) out.get(sectionKey).add(key)
  }
}

async function collectFromDb(out) {
  const dbPath = process.env.SQLITE_DB_PATH || process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'grantflow.db')
  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const rows = db.prepare('SELECT section_key, data FROM profile_sections').all()
    for (const row of rows) {
      const data = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      if (!out.has(row.section_key)) out.set(row.section_key, new Set())
      for (const key of Object.keys(data)) out.get(row.section_key).add(key)
    }
    db.close()
    return rows.length > 0
  } catch {
    return false
  }
}

async function main() {
  const observed = new Map()
  const loadedDb = await collectFromDb(observed)
  if (!loadedDb) {
    for (const profile of DESIGNATED_PROFILES) collectFromProfile(profile, observed)
    const anastasiaPath = path.join(process.cwd(), 'backend', 'config', 'profile-anastasia.json')
    const anastasia = JSON.parse(readFileSync(anastasiaPath, 'utf8'))
    collectFromProfile(anastasia, observed)
  }

  const failures = []
  for (const [sectionKey, keys] of observed) {
    const declared = new Set((SECTION_METADATA[sectionKey]?.fields ?? []).map((field) => field.name))
    for (const key of keys) {
      if (!declared.has(key)) failures.push(`${sectionKey}.${key}`)
    }
  }

  if (failures.length > 0) {
    console.error('[metadata-audit] Orphan profile section keys not declared in SECTION_METADATA:')
    for (const failure of failures.sort()) console.error(`- ${failure}`)
    process.exit(1)
  }

  console.log(`[metadata-audit] OK (${loadedDb ? 'database' : 'designated seeds'})`)
}

main().catch((error) => {
  console.error('[metadata-audit] Failed:', error?.message || error)
  process.exit(1)
})
