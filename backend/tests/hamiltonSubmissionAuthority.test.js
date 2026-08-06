import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  _resetAuthSchemaCache,
  recordAuthorizations,
  resolveSubmissionDecision,
} from '../services/hamilton/hamiltonAuthorizationStore.js'
import {
  _resetAttestationSchemaCache,
  ATTESTATION_SEED_PATTERNS,
  authorizeAttestation,
  isAttestationAllowed,
} from '../services/hamilton/hamiltonAttestationStore.js'
import {
  _resetSchemaCache,
  cancelApplicationTask,
  ensureApplicationTask,
  updateApplicationTask,
} from '../services/hamilton/applicationTaskStore.js'
import {
  beginHamiltonTaskRun,
  cancelActiveHamiltonTaskRun,
  finishHamiltonTaskRun,
  hasActiveHamiltonTaskRun,
} from '../services/hamilton/hamiltonRunCancellation.js'
import { _internal as engineInternal } from '../services/hamilton/hamiltonAutopilotEngine.js'

const PROFILE = 'profile-authority'
const SOURCE = 'opportunity-authority'
const tempDirs = []
let priorUploads

function makeDb() {
  const db = wrapSqlite(new Database(':memory:'))
  _resetAuthSchemaCache()
  _resetAttestationSchemaCache()
  _resetSchemaCache()
  return db
}

async function authorize(db, {
  types = ['complete_forms', 'submit_applications'],
  requireHumanReview = false,
} = {}) {
  return recordAuthorizations(db, {
    userId: 'user-1',
    profileId: PROFILE,
    scope: 'funding_source',
    fundingSourceIds: [SOURCE],
    authorizationTypes: types,
    authorizationText: 'Versioned test authorization',
    authorizationVersion: 'hamilton-autopilot-test-v1',
    options: { require_human_review: requireHumanReview },
    replaceOmittedTypes: true,
  })
}

beforeEach(() => {
  priorUploads = process.env.UPLOADS_DIR
})

afterEach(() => {
  if (priorUploads === undefined) delete process.env.UPLOADS_DIR
  else process.env.UPLOADS_DIR = priorUploads
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true })
})

describe('canonical Hamilton submission authority', () => {
  it('treats request and task booleans as intent, never authority', async () => {
    const db = makeDb()
    await authorize(db, { types: ['complete_forms'] })

    const decision = await resolveSubmissionDecision(db, {
      profileId: PROFILE,
      fundingSourceId: SOURCE,
      taskId: 'task-1',
      requestAllowAutoSubmit: true,
      taskAllowAutoSubmit: true,
      taskAutoSubmitEnabled: true,
    })

    expect(decision.allow_auto_submit).toBe(false)
    expect(decision.reason).toBe('missing_submit_authorization')
    expect(decision.authorization_id).toBeNull()
  })

  it('treats the live task intent as a durable veto despite a stale request and profile-wide grant', async () => {
    const db = makeDb()
    await recordAuthorizations(db, {
      userId: 'user-1',
      profileId: PROFILE,
      scope: 'profile',
      authorizationTypes: ['submit_applications'],
      authorizationText: 'Profile-wide test authorization',
      authorizationVersion: 'hamilton-autopilot-test-v1',
      options: { require_human_review: false },
    })

    const disabled = await resolveSubmissionDecision(db, {
      profileId: PROFILE,
      fundingSourceId: SOURCE,
      taskId: 'task-1',
      requestAllowAutoSubmit: true,
      taskAllowAutoSubmit: false,
      taskAutoSubmitEnabled: true,
    })
    expect(disabled.authorized).toBe(true)
    expect(disabled.requested).toBe(false)
    expect(disabled.allow_auto_submit).toBe(false)
    expect(disabled.reason).toBe('not_requested')

    const enabled = await resolveSubmissionDecision(db, {
      profileId: PROFILE,
      fundingSourceId: SOURCE,
      taskId: 'task-1',
      requestAllowAutoSubmit: false,
      taskAllowAutoSubmit: true,
      taskAutoSubmitEnabled: false,
    })
    expect(enabled.requested).toBe(true)
    expect(enabled.allow_auto_submit).toBe(true)
  })

  it('uses the stored versioned grant and revokes it when the next full selection omits submit', async () => {
    const db = makeDb()
    await authorize(db)
    const granted = await resolveSubmissionDecision(db, {
      profileId: PROFILE,
      fundingSourceId: SOURCE,
      taskAllowAutoSubmit: true,
    })
    expect(granted.allow_auto_submit).toBe(true)
    expect(granted.authorization_id).toBeTruthy()
    expect(granted.authorization_version).toBe('hamilton-autopilot-test-v1')

    await authorize(db, { types: ['complete_forms'] })
    const replaced = await resolveSubmissionDecision(db, {
      profileId: PROFILE,
      fundingSourceId: SOURCE,
      taskAllowAutoSubmit: true,
    })
    expect(replaced.allow_auto_submit).toBe(false)
    expect(replaced.reason).toBe('missing_submit_authorization')
  })

  it('enforces the persisted final-human-review preference as a veto', async () => {
    const db = makeDb()
    await authorize(db, { requireHumanReview: true })
    const decision = await resolveSubmissionDecision(db, {
      profileId: PROFILE,
      fundingSourceId: SOURCE,
      taskAllowAutoSubmit: true,
    })
    expect(decision.authorized).toBe(true)
    expect(decision.require_human_review).toBe(true)
    expect(decision.allow_auto_submit).toBe(false)
    expect(decision.reason).toBe('human_review_required')
  })
})

describe('Hamilton cancellation and containment', () => {
  it('immediately aborts the active local run', () => {
    const controller = beginHamiltonTaskRun('task-cancel')
    expect(hasActiveHamiltonTaskRun('task-cancel')).toBe(true)
    expect(cancelActiveHamiltonTaskRun('task-cancel', 'changed mind')).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(hasActiveHamiltonTaskRun('task-cancel')).toBe(false)
    finishHamiltonTaskRun('task-cancel', controller)
  })

  it('persists cancellation as a durable submit veto', async () => {
    const db = makeDb()
    const task = await ensureApplicationTask(db, {
      profileId: PROFILE,
      opportunityId: SOURCE,
      automationType: 'portal',
    })
    await updateApplicationTask(db, task.id, { allowAutoSubmit: true, autoSubmitEnabled: true })
    const cancelled = await cancelApplicationTask(db, task.id, { reason: 'changed mind' })
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.allow_auto_submit).toBe(false)
    expect(cancelled.auto_submit_enabled).toBe(false)
    expect(cancelled.next_retry_at).toBeNull()
  })

  it('allows uploads only from regular files under the configured uploads root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hamilton-upload-root-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hamilton-upload-outside-'))
    tempDirs.push(root, outside)
    process.env.UPLOADS_DIR = root
    const safe = path.join(root, 'resume.pdf')
    const unsafe = path.join(outside, 'secret.pdf')
    const link = path.join(root, 'linked.pdf')
    fs.writeFileSync(safe, 'safe')
    fs.writeFileSync(unsafe, 'secret')
    fs.symlinkSync(unsafe, link)

    expect(engineInternal.resolveSafeUploadDocument({ path: safe, kind: 'resume' })?.path).toBe(fs.realpathSync(safe))
    expect(engineInternal.resolveSafeUploadDocument({ path: unsafe, kind: 'resume' })).toBeNull()
    expect(engineInternal.resolveSafeUploadDocument({ path: link, kind: 'resume' })).toBeNull()
  })
})

describe('standing attestation policy', () => {
  it('ignores caller regexes and neutralizes legacy broad patterns at match time', async () => {
    const db = makeDb()
    const saved = await authorizeAttestation(db, {
      userId: 'user-1',
      profileId: PROFILE,
      category: 'truthfulness',
      pattern: '.*',
      authorizationText: 'I approve the reviewed truthfulness category.',
    })
    expect(saved.pattern).toBe(ATTESTATION_SEED_PATTERNS.truthfulness)

    await db.prepare('UPDATE hamilton_attestation_authorizations SET pattern = ? WHERE id = ?').run('.*', saved.id)
    const forbidden = await isAttestationAllowed(db, {
      profileId: PROFILE,
      labelText: 'I sign under penalty of perjury.',
    })
    const allowed = await isAttestationAllowed(db, {
      profileId: PROFILE,
      labelText: 'I certify the information is accurate to the best of my knowledge.',
    })
    expect(forbidden.allowed).toBe(false)
    expect(allowed.allowed).toBe(true)
    expect(allowed.authorization.pattern).toBe(ATTESTATION_SEED_PATTERNS.truthfulness)
  })
})
