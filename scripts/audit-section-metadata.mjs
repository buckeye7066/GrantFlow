#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { SECTION_METADATA } from '../src/config/sectionMetadata.js'
import { DESIGNATED_PROFILES } from '../backend/config/designatedProfiles.js'
import { PROFILE_FIELD_ALIASES } from '../shared/profileSuggestionGuards.js'

const SUPPORTED_FORMATS = new Set([
  'string',
  'text',
  'long_text',
  'string_array',
  'json',
  'currency_usd',
  'currency_cents_usd',
  'percent',
  'date',
  'datetime',
  'url',
  'email',
  'phone',
  'boolean_tri',
  'enum',
])

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
  for (const [sectionKey, section] of Object.entries(SECTION_METADATA)) {
    const seen = new Set()
    for (const field of section.fields ?? []) {
      const prefix = `${sectionKey}.${field?.name ?? '<missing-name>'}`
      if (!field?.name) failures.push(`${prefix}: missing name`)
      if (field?.name && seen.has(field.name)) failures.push(`${prefix}: duplicate field`)
      if (field?.name) seen.add(field.name)
      if (!field?.label) failures.push(`${prefix}: missing label`)
      if (!field?.format) failures.push(`${prefix}: missing format`)
      if (!field?.help) failures.push(`${prefix}: missing help`)
      if (field?.format && !SUPPORTED_FORMATS.has(field.format)) failures.push(`${prefix}: unsupported format ${field.format}`)
      if (field?.format === 'enum' && (!Array.isArray(field.options) || field.options.length === 0)) {
        failures.push(`${prefix}: enum missing options`)
      }
    }
  }

  for (const [sectionKey, keys] of observed) {
    const declaredFields = SECTION_METADATA[sectionKey]?.fields ?? []
    const declared = new Set(declaredFields.map((field) => field.name))
    const formats = new Map(declaredFields.map((field) => [field.name, field.format]))
    for (const key of keys) {
      if (!declared.has(key)) failures.push(`${sectionKey}.${key}`)
      if (formats.get(key) === 'text') {
        // Fixtures should not force text renderers to handle objects/arrays.
        for (const profile of DESIGNATED_PROFILES) {
          const value = profile?.sections?.[sectionKey]?.[key]
          if (value && typeof value === 'object') failures.push(`${sectionKey}.${key}: text field has structured fixture value`)
        }
      }
    }
  }

  for (const [sectionKey, aliases] of Object.entries(PROFILE_FIELD_ALIASES)) {
    const declared = new Set((SECTION_METADATA[sectionKey]?.fields ?? []).map((field) => field.name))
    for (const [from, to] of Object.entries(aliases)) {
      if (!declared.has(to)) failures.push(`${sectionKey}.${from}: alias target ${to} missing from metadata`)
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
