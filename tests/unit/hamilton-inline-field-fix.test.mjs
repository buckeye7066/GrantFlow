/**
 * Inline hard-stop field fix — "bring the fix to the banner."
 *
 * When Hamilton stops on a missing/ambiguous scalar profile field, the operator
 * types the value right in the hard-stop banner. These tests lock in the core
 * backend behavior that powers that:
 *   - setProfileSectionField writes the value back into the profile section it
 *     was missing from (merging, not clobbering), via the same guard the editor
 *     uses, and rejects fields the section doesn't accept.
 *   - resolveProfileFieldTarget / inlineFieldForBlocker only mark genuinely
 *     inline-fixable fields (and map blocker keys to guard-accepted columns,
 *     e.g. zip → zip_code), so the UI never offers an input the save rejects.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import { setProfileSectionField } from '../../backend/services/profileFieldWriter.js'
import {
  resolveProfileFieldTarget,
  inlineFieldForBlocker,
} from '../../backend/services/hamilton/profileFieldTargets.js'

before(() => {
  if (!process.env.AUTH_JWT_SECRET) process.env.AUTH_JWT_SECRET = 'unit-test-jwt-secret'
})

function makeDb() {
  const db = wrapSqlite(new Database(':memory:'))
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, state TEXT, zip TEXT, city TEXT, county TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT, section_key TEXT, data TEXT, updated_by TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, section_key)
    );
  `)
  db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p1', 'Demo Tennessee STEM Student')
  return db
}

async function sectionData(db, profileId, sectionKey) {
  const row = await db
    .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?')
    .get(profileId, sectionKey)
  return row ? JSON.parse(row.data) : null
}

describe('setProfileSectionField', () => {
  it('writes a missing field back into its section', async () => {
    const db = makeDb()
    const res = await setProfileSectionField(db, {
      profileId: 'p1', sectionKey: 'basic_information', field: 'first_name', value: 'Demo Student',
    })
    assert.equal(res.accepted, true)
    const data = await sectionData(db, 'p1', 'basic_information')
    assert.equal(data.first_name, 'Demo Student')
  })

  it('merges rather than clobbering sibling fields', async () => {
    const db = makeDb()
    await setProfileSectionField(db, { profileId: 'p1', sectionKey: 'basic_information', field: 'first_name', value: 'Demo Student' })
    await setProfileSectionField(db, { profileId: 'p1', sectionKey: 'basic_information', field: 'last_name', value: 'White' })
    const data = await sectionData(db, 'p1', 'basic_information')
    assert.equal(data.first_name, 'Demo Student')
    assert.equal(data.last_name, 'White')
  })

  it('maps the blocker key zip → the guard-accepted zip_code column', async () => {
    const db = makeDb()
    const target = resolveProfileFieldTarget('zip')
    await setProfileSectionField(db, { profileId: 'p1', sectionKey: target.section, field: target.field, value: '37130' })
    const data = await sectionData(db, 'p1', 'basic_information')
    assert.equal(data.zip_code, '37130')
  })

  it('throws field_rejected when the section guard does not accept the field', async () => {
    const db = makeDb()
    await assert.rejects(
      () => setProfileSectionField(db, { profileId: 'p1', sectionKey: 'basic_information', field: 'not_a_real_field', value: 'x' }),
      (err) => err.code === 'field_rejected',
    )
  })
})

describe('inlineFieldForBlocker', () => {
  it('returns a descriptor for a missing scalar field', () => {
    const inline = inlineFieldForBlocker({ blocker_type: 'missing_required_information', metadata: { key: 'first_name' } })
    assert.deepEqual(inline, { fieldKey: 'first_name', sectionKey: 'basic_information', field: 'first_name', label: 'First name' })
  })

  it('maps zip → zip_code so the save lands in the right column', () => {
    const inline = inlineFieldForBlocker({ blocker_type: 'missing_required_information', metadata: { key: 'zip' } })
    assert.equal(inline.field, 'zip_code')
  })

  it('returns null for non-inline-fixable stops (documents, logins, unknown fields)', () => {
    assert.equal(inlineFieldForBlocker({ blocker_type: 'missing_required_document', metadata: { kind: 'transcript' } }), null)
    assert.equal(inlineFieldForBlocker({ blocker_type: 'login_required', metadata: { portal_host: 'tn.gov' } }), null)
    assert.equal(inlineFieldForBlocker({ blocker_type: 'missing_required_information', metadata: { key: 'fafsa_efc' } }), null)
  })
})
