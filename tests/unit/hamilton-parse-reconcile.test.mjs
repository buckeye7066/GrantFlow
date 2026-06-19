/**
 * reconcileProfileAfterParse — once a document is parsed into profile_sections,
 * any field Hamilton flagged that the document just filled is resolved and the
 * task auto-resumes. This is the "parse the doc → Hamilton knows what to place
 * where → Hamilton continues" link.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  ensureApplicationTaskSchema, ensureApplicationTask, updateApplicationTask,
  getApplicationTask, setMissingInfo, listMissingInfo,
  reconcileProfileAfterParse, _resetSchemaCache,
} from '../../backend/services/hamilton/applicationTaskStore.js'

before(() => {
  if (!process.env.RUNTIME_SECRETS_KEY && !process.env.AUTH_JWT_SECRET && !process.env.JWT_SECRET) {
    process.env.AUTH_JWT_SECRET = 'unit-test-jwt-secret-do-not-use-in-prod'
  }
})

function makeDb() {
  _resetSchemaCache()
  const db = wrapSqlite(new Database(':memory:'))
  db.exec('CREATE TABLE IF NOT EXISTS profile_sections (profile_id TEXT, section_key TEXT, data TEXT, updated_by TEXT, PRIMARY KEY (profile_id, section_key));')
  return db
}

function setSection(db, profileId, sectionKey, obj) {
  db.prepare('INSERT OR REPLACE INTO profile_sections (profile_id, section_key, data) VALUES (?,?,?)')
    .run(profileId, sectionKey, JSON.stringify(obj))
}

async function blockedTask(db, { profileId = 'p1', opp = 'opp1', fields = [], docs = [] } = {}) {
  await ensureApplicationTaskSchema(db)
  const t = await ensureApplicationTask(db, { profileId, opportunityId: opp, userId: 'u1' })
  await updateApplicationTask(db, t.id, { status: 'blocked' })
  await setMissingInfo(db, t.id, [
    ...fields.map((key) => ({ kind: 'field', key, label: key })),
    ...docs.map((label, i) => ({ kind: 'document', key: `doc${i}`, label })),
  ])
  return t.id
}

describe('reconcileProfileAfterParse', () => {
  it('resolves a flagged field the parsed doc populated and resumes (leaf-key match)', async () => {
    const db = makeDb()
    const id = await blockedTask(db, { fields: ['ein'] })
    setSection(db, 'p1', 'organization_details', { ein: '12-3456789' })
    const r = await reconcileProfileAfterParse(db, { profileId: 'p1' })
    assert.equal(r.fieldsResolved, 1)
    assert.equal(r.tasksResumed, 1)
    assert.equal((await getApplicationTask(db, id)).status, 'ready')
  })

  it('matches a dotted field key against the section path', async () => {
    const db = makeDb()
    const id = await blockedTask(db, { fields: ['financial_information.household_income'] })
    setSection(db, 'p1', 'financial_information', { household_income: '45000' })
    const r = await reconcileProfileAfterParse(db, { profileId: 'p1' })
    assert.equal(r.tasksResumed, 1)
    assert.equal((await getApplicationTask(db, id)).status, 'ready')
  })

  it('does NOT resolve a field the document did not provide', async () => {
    const db = makeDb()
    const id = await blockedTask(db, { fields: ['ein'] })
    setSection(db, 'p1', 'basic_information', { first_name: 'John' }) // no ein
    const r = await reconcileProfileAfterParse(db, { profileId: 'p1' })
    assert.equal(r.fieldsResolved, 0)
    assert.equal((await getApplicationTask(db, id)).status, 'blocked')
  })

  it('does NOT resume while another flagged field is still missing', async () => {
    const db = makeDb()
    const id = await blockedTask(db, { fields: ['ein', 'annual_budget'] })
    setSection(db, 'p1', 'organization_details', { ein: '12-3456789' }) // budget still absent
    const r = await reconcileProfileAfterParse(db, { profileId: 'p1' })
    assert.equal(r.fieldsResolved, 1)
    assert.equal(r.tasksResumed, 0)
    assert.equal((await getApplicationTask(db, id)).status, 'blocked')
    assert.equal((await listMissingInfo(db, id, { includeResolved: false })).length, 1)
  })

  it('ignores empty values in profile_sections', async () => {
    const db = makeDb()
    const id = await blockedTask(db, { fields: ['ein'] })
    setSection(db, 'p1', 'organization_details', { ein: '   ' })
    const r = await reconcileProfileAfterParse(db, { profileId: 'p1' })
    assert.equal(r.fieldsResolved, 0)
    assert.equal((await getApplicationTask(db, id)).status, 'blocked')
  })

  it('only touches the parsed profile', async () => {
    const db = makeDb()
    const mine = await blockedTask(db, { profileId: 'p1', opp: 'a', fields: ['ein'] })
    const other = await blockedTask(db, { profileId: 'p2', opp: 'b', fields: ['ein'] })
    setSection(db, 'p1', 'organization_details', { ein: '12-3456789' })
    await reconcileProfileAfterParse(db, { profileId: 'p1' })
    assert.equal((await getApplicationTask(db, mine)).status, 'ready')
    assert.equal((await getApplicationTask(db, other)).status, 'blocked')
  })
})
