#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { SECTION_METADATA } from '../src/config/sectionMetadata.js'
import { DESIGNATED_PROFILES } from '../backend/config/designatedProfiles.js'
import { PROFILE_FIELD_ALIASES } from '../shared/profileSuggestionGuards.js'
import { PROFILE_SCHEMA } from '../backend/config/profileSchema.js'

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
  // Schema redesign 2026-07-07: controlled multi-select tag arrays (drawn from
  // the matcher's own vocabulary) and drafting-only prose (scored:false, used
  // by Hamilton/Anya, excluded from the scoring inventory).
  'tags',
  'prose',
])

// Array-shaped metadata formats: a PROFILE_SCHEMA array<*> field may declare any
// of these (NOT a scalar format, which is the "shape lie" this audit catches).
const ARRAY_COMPATIBLE_FORMATS = new Set(['string_array', 'tags', 'json'])

// A profile section key is "declared" if it matches a metadata field's
// canonical name OR one of that field's legacy_aliases. Seed fixtures and the
// live DB still carry pre-canonicalisation keys (e.g. `unemployed` →
// `employment_status`, `immigrant_status` → `immigration_status`) that are
// mapped to the canonical key on save — counting only canonical names flags
// those legacy keys as false-positive orphans and breaks CI.
function buildDeclaredFieldIndex(fields = []) {
  const declared = new Set()
  const formats = new Map()

  for (const field of fields) {
    if (!field?.name) continue
    declared.add(field.name)
    formats.set(field.name, field.format)

    for (const alias of field.legacy_aliases ?? []) {
      declared.add(alias)
      formats.set(alias, field.format)
    }
  }

  return { declared, formats }
}

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
    const demoProfilePath = path.join(process.cwd(), 'backend', 'config', 'profile-demo-tennessee-stem-student.json')
    const demo_stem_student = JSON.parse(readFileSync(demoProfilePath, 'utf8'))
    collectFromProfile(demo_stem_student, observed)
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
    const { declared, formats } = buildDeclaredFieldIndex(declaredFields)
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

  // ── Cross-check metadata `format` vs PROFILE_SCHEMA `type` ─────────────────
  //
  // Backed by the goal-aligned rule: "the metadata format must never lie about
  // the shape." A field declared text/long_text/string in SECTION_METADATA but
  // typed as an array in PROFILE_SCHEMA was the root cause of the recurring
  // [fieldDisplay] "cannot render object Object" warnings on /ProfileDetail.
  // Surfacing every mismatch here prevents the same regression from coming
  // back the way it did across multiple prior fix attempts.
  const SCALAR_FORMATS = new Set(['text', 'long_text', 'string', 'url', 'email', 'phone'])
  for (const [sectionKey, section] of Object.entries(SECTION_METADATA)) {
    const schemaFields = PROFILE_SCHEMA[sectionKey]?.fields
    if (!schemaFields) continue
    for (const field of section.fields ?? []) {
      const schemaField = schemaFields[field.name]
      if (!schemaField) continue
      const schemaType = String(schemaField.type ?? '').toLowerCase()
      const isArrayType = schemaType.startsWith('array')
      if (isArrayType && !ARRAY_COMPATIBLE_FORMATS.has(field.format)) {
        failures.push(
          `${sectionKey}.${field.name}: SECTION_METADATA format="${field.format}" but PROFILE_SCHEMA type="${schemaField.type}" — use "tags" (controlled vocabulary) or "string_array"`,
        )
      }
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
