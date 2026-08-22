/**
 * hamiltonCustomFieldRegistry.js
 *
 * Owner doctrine 2026-08-22, condition 2: when a portal asks for a required
 * field Hamilton genuinely cannot fill from the profile (or its website), he
 * asks the profile owner — with a deep link to the EXACT place to enter it. If
 * the profile has no appropriate home for that fact (e.g. "are you the oldest
 * sibling?" and there is no sibling-order field anywhere), Hamilton has Anya
 * CREATE the field GLOBALLY — it then exists for every current AND future
 * profile — and the owner is asked to fill it there. Once obtained, the task
 * resumes and Hamilton completes the submission.
 *
 * This module is the "Anya creates the field globally" mechanism, done as a
 * DATA registry (`profile_custom_fields`) rather than a code/schema edit, so it
 * is safe, reversible, and automatically inherited by all profiles: every
 * profile's form reads this registry, and values are stored per-profile in the
 * `custom_fields` profile section. Nothing here fabricates a value — it only
 * creates the QUESTION and routes the owner to answer it.
 */

import crypto from 'node:crypto'
import { PROFILE_SCHEMA } from '../../config/profileSchema.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-custom-fields')

// Words that carry no matching signal — dropped from field-home matching so a
// stopword can never make two unrelated fields look related (the #937 class).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'your', 'you',
  'is', 'are', 'please', 'enter', 'provide', 'applicant', 'primary', 'this',
  'that', 'with', 'if', 'any', 'name', 'number', 'info', 'information', 'field',
  'value', 'details', 'detail', 'used', 'when', 'available',
])

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
}

/** Normalize a human label to a stable snake_case field key. */
export function normalizeFieldKey(label) {
  const base = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  return base || `field_${crypto.randomUUID().slice(0, 8)}`
}

/** Human label from a snake_case key. */
export function labelFromKey(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

// Flatten the canonical schema into matchable entries ONCE. Only real,
// user-answerable fields — skip deprecated, prose-only drafting fields, and
// structured blobs that are never a single portal answer.
let FLAT_CACHE = null
function flatSchemaFields() {
  if (FLAT_CACHE) return FLAT_CACHE
  const out = []
  for (const [sectionKey, section] of Object.entries(PROFILE_SCHEMA || {})) {
    const fields = section?.fields || {}
    for (const [field, meta] of Object.entries(fields)) {
      if (meta?.deprecated) continue
      if (meta?.format === 'prose') continue
      const label = labelFromKey(field)
      const nameTokens = new Set([...tokens(field), ...tokens(label)])
      const tset = new Set([...nameTokens, ...tokens(meta?.description)])
      out.push({
        section_key: sectionKey,
        section_title: section?.title || labelFromKey(sectionKey),
        field,
        label,
        nameTokens,
        tokens: tset,
      })
    }
  }
  FLAT_CACHE = out
  return out
}

// A few high-value synonyms where the portal's wording and the schema key
// diverge but the meaning is unambiguous. Conservative on purpose.
const HOME_SYNONYMS = Object.freeze({
  dob: { section_key: 'basic_information', field: 'date_of_birth' },
  birthdate: { section_key: 'basic_information', field: 'date_of_birth' },
  birthday: { section_key: 'basic_information', field: 'date_of_birth' },
  zipcode: { section_key: 'basic_information', field: 'zip' },
  postal: { section_key: 'basic_information', field: 'zip' },
  gpa: { section_key: 'education', field: 'gpa' },
  major: { section_key: 'education', field: 'intended_major' },
  income: { section_key: 'financial_information', field: 'household_income' },
})

/**
 * Resolve a required portal-field label to an EXISTING profile schema field.
 * Returns { section_key, section_title, field, label, confidence } or null.
 *
 * Precision over recall: a WRONG home sends the owner to the wrong place, so a
 * match requires that EVERY distinctive token of the query is present in the
 * candidate field (subset match), or an exact key/synonym hit. A query with no
 * distinctive tokens never matches (it goes to a custom field instead).
 */
export function resolveFieldHome(label) {
  const qTokens = tokens(label)
  if (qTokens.length === 0) return null

  // Exact synonym on any single distinctive token.
  for (const t of qTokens) {
    if (HOME_SYNONYMS[t]) {
      const hit = HOME_SYNONYMS[t]
      const entry = flatSchemaFields().find((e) => e.section_key === hit.section_key && e.field === hit.field)
      if (entry) return { section_key: entry.section_key, section_title: entry.section_title, field: entry.field, label: entry.label, confidence: 'synonym' }
    }
  }

  const qSet = new Set(qTokens)
  let best = null
  for (const entry of flatSchemaFields()) {
    // Subset: every distinctive query token appears in the field's token set.
    let allPresent = true
    for (const t of qSet) { if (!entry.tokens.has(t)) { allPresent = false; break } }
    if (!allPresent) continue
    // Rank: a token matching the field's NAME/label beats one matching only its
    // description ("ZIP" → the zip field, not the address field whose blurb
    // mentions ZIP); then prefer the tightest field.
    let missingFromName = 0
    for (const t of qSet) { if (!entry.nameTokens.has(t)) missingFromName += 1 }
    const cand = { entry, missingFromName, size: entry.tokens.size }
    if (!best || cand.missingFromName < best.missingFromName
        || (cand.missingFromName === best.missingFromName && cand.size < best.size)) {
      best = cand
    }
  }
  if (!best) return null
  return {
    section_key: best.entry.section_key,
    section_title: best.entry.section_title,
    field: best.entry.field,
    label: best.entry.label,
    confidence: 'schema_match',
  }
}

// ── The global custom-field registry (Anya's "create the field for everyone") ──

const CUSTOM_FIELDS_SECTION = 'custom_fields'

async function ensureSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  const isPg = db?.dialect === 'postgres'
  const idDefault = isPg ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const ts = isPg ? 'TIMESTAMPTZ' : 'DATETIME'
  const now = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS profile_custom_fields (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      field_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      description TEXT,
      field_type TEXT NOT NULL DEFAULT 'text',
      created_by TEXT,
      origin_task_id TEXT,
      origin_source TEXT,
      created_at ${ts} DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_profile_custom_fields_key ON profile_custom_fields(field_key);
  `)
}

/**
 * Create (idempotently) a GLOBAL custom profile field — it now exists for every
 * current and future profile. Keyed on the normalized field_key so the same
 * question asked by many portals collapses to ONE field. Never overwrites an
 * existing definition. Returns { field_key, label, created }.
 */
export async function ensureGlobalCustomField(db, { label, description = null, fieldType = 'text', createdBy = 'hamilton', originTaskId = null, originSource = null } = {}) {
  await ensureSchema(db)
  const fieldKey = normalizeFieldKey(label)
  const cleanLabel = String(label || labelFromKey(fieldKey)).slice(0, 200)
  const existing = await db.prepare('SELECT field_key, label FROM profile_custom_fields WHERE field_key = ? LIMIT 1').get(fieldKey)
  if (existing) return { field_key: existing.field_key, label: existing.label, created: false }
  try {
    await db
      .prepare(
        `INSERT INTO profile_custom_fields (id, field_key, label, description, field_type, created_by, origin_task_id, origin_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), fieldKey, cleanLabel, description ? String(description).slice(0, 500) : null, String(fieldType || 'text'), createdBy, originTaskId, originSource)
    log.info('global_custom_field_created', { field_key: fieldKey, origin_source: originSource })
    return { field_key: fieldKey, label: cleanLabel, created: true }
  } catch (err) {
    // A concurrent create raced us to the UNIQUE key — treat as existing.
    const row = await db.prepare('SELECT field_key, label FROM profile_custom_fields WHERE field_key = ? LIMIT 1').get(fieldKey).catch(() => null)
    if (row) return { field_key: row.field_key, label: row.label, created: false }
    throw err
  }
}

/** Every global custom field (rendered by every profile's form). */
export async function listGlobalCustomFields(db) {
  await ensureSchema(db)
  const rows = await db.prepare('SELECT field_key, label, description, field_type, origin_source, created_at FROM profile_custom_fields ORDER BY created_at ASC').all()
  return rows || []
}

/** This profile's answers to the custom fields, stored in the custom_fields section. */
export async function getCustomFieldValues(db, profileId) {
  if (!db || !profileId) return {}
  try {
    const row = await db.prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ? LIMIT 1').get(String(profileId), CUSTOM_FIELDS_SECTION)
    if (!row?.data) return {}
    const parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/** Set one custom-field value for a profile (merges into the custom_fields section). */
export async function setCustomFieldValue(db, profileId, fieldKey, value, { updatedBy = null } = {}) {
  if (!db || !profileId || !fieldKey) return false
  const key = normalizeFieldKey(fieldKey)
  const current = await getCustomFieldValues(db, profileId)
  const next = { ...current, [key]: value }
  const data = JSON.stringify(next)
  const now = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await db.prepare('SELECT 1 AS x FROM profile_sections WHERE profile_id = ? AND section_key = ?').get(String(profileId), CUSTOM_FIELDS_SECTION).catch(() => null)
  if (existing) {
    await db.prepare(`UPDATE profile_sections SET data = ?, updated_by = ?, updated_at = ${now} WHERE profile_id = ? AND section_key = ?`).run(data, updatedBy, String(profileId), CUSTOM_FIELDS_SECTION)
  } else {
    await db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data, updated_by, updated_at) VALUES (?, ?, ?, ?, ${now})`).run(String(profileId), CUSTOM_FIELDS_SECTION, data, updatedBy)
  }
  return true
}

/**
 * The orchestration entry point Hamilton calls when he CANNOT fill a required
 * field from the profile. Resolves where the answer belongs:
 *   - an existing schema field  → { home, custom:false }
 *   - nowhere it fits           → create a GLOBAL custom field, { home, custom:true, created }
 * Never fabricates a value. The caller records the missing-info ask (kind
 * 'field', key = "<section>.<field>") so it surfaces on the profile with a
 * deep link to exactly where the owner should answer it.
 */
export async function resolveOrCreateFieldHome(db, { taskId = null, label, description = null, fieldType = 'text', originSource = 'portal_required_field' } = {}) {
  const home = resolveFieldHome(label)
  if (home) {
    return {
      custom: false,
      created: false,
      section_key: home.section_key,
      section_title: home.section_title,
      field: home.field,
      field_key: `${home.section_key}.${home.field}`,
      label: home.label,
    }
  }
  const created = await ensureGlobalCustomField(db, { label, description, fieldType, originTaskId: taskId, originSource })
  return {
    custom: true,
    created: created.created,
    section_key: CUSTOM_FIELDS_SECTION,
    section_title: 'Additional details Hamilton needs',
    field: created.field_key,
    field_key: `${CUSTOM_FIELDS_SECTION}.${created.field_key}`,
    label: created.label,
  }
}

export const _internal = { tokens, flatSchemaFields, CUSTOM_FIELDS_SECTION }
