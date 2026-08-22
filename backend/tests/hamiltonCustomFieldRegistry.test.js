/**
 * Condition 2 (owner doctrine 2026-08-22): a required portal field Hamilton
 * can't fill either has a home in the profile schema (deep-link the owner
 * there) or gets a GLOBAL custom field created (exists for every profile),
 * then the owner is asked. Never fabricates a value.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  resolveFieldHome, normalizeFieldKey, ensureGlobalCustomField,
  listGlobalCustomFields, setCustomFieldValue, getCustomFieldValues,
  resolveOrCreateFieldHome,
} from '../services/hamilton/hamiltonCustomFieldRegistry.js'

describe('resolveFieldHome — map a portal field to an existing profile field', () => {
  it('finds obvious homes', () => {
    expect(resolveFieldHome('Email Address')).toMatchObject({ section_key: 'basic_information', field: 'email' })
    expect(resolveFieldHome('Date of Birth')).toMatchObject({ section_key: 'basic_information', field: 'date_of_birth' })
    expect(resolveFieldHome('DOB')).toMatchObject({ field: 'date_of_birth' }) // synonym
    expect(resolveFieldHome('ZIP')).toMatchObject({ field: 'zip' })
  })
  it('returns null when nothing in the schema fits (→ needs a custom field)', () => {
    expect(resolveFieldHome('Are you the oldest sibling?')).toBeNull()
    expect(resolveFieldHome('Favorite marine mammal')).toBeNull()
  })
  it('a label with no distinctive tokens never matches', () => {
    expect(resolveFieldHome('please provide the information')).toBeNull()
  })
})

describe('normalizeFieldKey', () => {
  it('is stable snake_case', () => {
    expect(normalizeFieldKey('Are you the OLDEST sibling?')).toBe('are_you_the_oldest_sibling')
    expect(normalizeFieldKey('Sibling order')).toBe('sibling_order')
  })
})

describe('global custom field registry', () => {
  let db
  beforeEach(async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT, updated_by TEXT, updated_at DATETIME);
    `)
    db = wrapSqlite(sqlite)
  })

  it('creates a global field idempotently (same question collapses to one)', async () => {
    const a = await ensureGlobalCustomField(db, { label: 'Sibling order', originSource: 'portal_required_field' })
    expect(a).toMatchObject({ field_key: 'sibling_order', created: true })
    const b = await ensureGlobalCustomField(db, { label: 'sibling ORDER' })
    expect(b.created).toBe(false) // same normalized key → not created twice
    const all = await listGlobalCustomFields(db)
    expect(all).toHaveLength(1)
    expect(all[0].field_key).toBe('sibling_order')
  })

  it('stores a per-profile value in the custom_fields section', async () => {
    await ensureGlobalCustomField(db, { label: 'Sibling order' })
    await setCustomFieldValue(db, 'p1', 'sibling_order', 'oldest')
    expect(await getCustomFieldValues(db, 'p1')).toEqual({ sibling_order: 'oldest' })
    expect(await getCustomFieldValues(db, 'p2')).toEqual({}) // per-profile, not global
  })

  it('resolveOrCreateFieldHome: existing field → no custom field; novel field → global create', async () => {
    const known = await resolveOrCreateFieldHome(db, { label: 'Email Address' })
    expect(known).toMatchObject({ custom: false, section_key: 'basic_information', field: 'email' })
    expect(await listGlobalCustomFields(db)).toHaveLength(0) // nothing created for a known field

    const novel = await resolveOrCreateFieldHome(db, { taskId: 't1', label: 'Are you the oldest sibling?' })
    expect(novel).toMatchObject({ custom: true, created: true, section_key: 'custom_fields' })
    expect(novel.field_key).toBe('custom_fields.are_you_the_oldest_sibling')
    expect(await listGlobalCustomFields(db)).toHaveLength(1)
  })
})
