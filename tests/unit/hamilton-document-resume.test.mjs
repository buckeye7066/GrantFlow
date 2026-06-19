/**
 * Document-upload auto-resume: uploading a document that satisfies a flagged
 * requirement resolves it and re-queues the task, so Hamilton continues on her
 * own — the document analogue of the missing-field auto-resume.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  ensureApplicationTaskSchema, ensureApplicationTask, updateApplicationTask,
  getApplicationTask, setMissingInfo, listMissingInfo,
  reconcileProfileDocumentUploads, documentNameMatchesRequirement,
  _resetSchemaCache,
} from '../../backend/services/hamilton/applicationTaskStore.js'

before(() => {
  if (!process.env.RUNTIME_SECRETS_KEY && !process.env.AUTH_JWT_SECRET && !process.env.JWT_SECRET) {
    process.env.AUTH_JWT_SECRET = 'unit-test-jwt-secret-do-not-use-in-prod'
  }
})

function makeDb() {
  _resetSchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

async function blockedTaskNeedingDoc(db, { profileId = 'p1', opp = 'opp1', docs = [], fields = [] } = {}) {
  await ensureApplicationTaskSchema(db)
  const t = await ensureApplicationTask(db, { profileId, opportunityId: opp, userId: 'u1' })
  await updateApplicationTask(db, t.id, { status: 'blocked' })
  await setMissingInfo(db, t.id, [
    ...docs.map((label, i) => ({ kind: 'document', key: `doc${i}`, label })),
    ...fields.map((label, i) => ({ kind: 'field', key: `field${i}`, label })),
  ])
  return t.id
}

describe('documentNameMatchesRequirement', () => {
  it('matches on a shared significant token', () => {
    assert.equal(documentNameMatchesRequirement('irs determination.pdf', 'IRS 501(c)(3) determination letter'), true)
    assert.equal(documentNameMatchesRequirement('Annual Budget 2025.xlsx', 'Most recent annual budget'), true)
  })
  it('does not match unrelated documents', () => {
    assert.equal(documentNameMatchesRequirement('board roster.pdf', 'Most recent tax return'), false)
  })
  it('does not match on generic words alone', () => {
    // "letter.pdf" shares only the stopword "letter" → no match.
    assert.equal(documentNameMatchesRequirement('letter.pdf', 'Letter of recommendation'), false)
  })
})

describe('reconcileProfileDocumentUploads', () => {
  it('resolves the matching doc requirement and resumes the task', async () => {
    const db = makeDb()
    const id = await blockedTaskNeedingDoc(db, { docs: ['IRS 501(c)(3) determination letter'] })
    const r = await reconcileProfileDocumentUploads(db, { profileId: 'p1', documentName: 'IRS determination letter.pdf' })
    assert.equal(r.tasksResumed, 1)
    assert.equal(r.itemsResolved, 1)
    assert.equal((await getApplicationTask(db, id)).status, 'ready')
    assert.equal((await listMissingInfo(db, id, { includeResolved: false })).length, 0)
  })

  it('does NOT resume when an unrelated document is uploaded', async () => {
    const db = makeDb()
    const id = await blockedTaskNeedingDoc(db, { docs: ['Most recent tax return'] })
    const r = await reconcileProfileDocumentUploads(db, { profileId: 'p1', documentName: 'board roster.pdf' })
    assert.equal(r.tasksResumed, 0)
    assert.equal((await getApplicationTask(db, id)).status, 'blocked')
  })

  it('does NOT resume while other items remain (doc resolved, field still missing)', async () => {
    const db = makeDb()
    const id = await blockedTaskNeedingDoc(db, { docs: ['Annual budget'], fields: ['EIN'] })
    const r = await reconcileProfileDocumentUploads(db, { profileId: 'p1', documentName: 'annual budget.pdf' })
    assert.equal(r.itemsResolved, 1)
    assert.equal(r.tasksResumed, 0)
    assert.equal((await getApplicationTask(db, id)).status, 'blocked')
    // The field is still outstanding.
    assert.equal((await listMissingInfo(db, id, { includeResolved: false })).length, 1)
  })

  it('only touches the uploading profile', async () => {
    const db = makeDb()
    const mine = await blockedTaskNeedingDoc(db, { profileId: 'p1', opp: 'a', docs: ['Annual budget'] })
    const other = await blockedTaskNeedingDoc(db, { profileId: 'p2', opp: 'b', docs: ['Annual budget'] })
    await reconcileProfileDocumentUploads(db, { profileId: 'p1', documentName: 'annual budget.pdf' })
    assert.equal((await getApplicationTask(db, mine)).status, 'ready')
    assert.equal((await getApplicationTask(db, other)).status, 'blocked')
  })
})
