import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  _resetAuthSchemaCache,
  ensureHamiltonAuthorizationSchema,
  isAuthorizationActive,
  recordAuthorizations,
} from '../services/hamilton/hamiltonAuthorizationStore.js'
import { readAuthorizations } from '../services/hamilton/hamiltonPreflight.js'
import {
  HAMILTON_AUTOPILOT_AUTHORIZATION_TEXT,
  HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION,
} from '../../shared/hamiltonSubmissionContract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function makeDb() {
  _resetAuthSchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

beforeEach(() => _resetAuthSchemaCache())

describe('Hamilton irreversible authorization scope', () => {
  it('rejects profile/funding standing submit and forged human-review combinations', async () => {
    const db = makeDb()
    await expect(recordAuthorizations(db, {
      userId: 'user-1', profileId: 'profile-1', scope: 'profile',
      authorizationTypes: ['submit_applications'],
      options: { allow_auto_submit: true, require_human_review: false },
    })).rejects.toThrow(/exact_task_scope/)

    await expect(recordAuthorizations(db, {
      userId: 'user-1', profileId: 'profile-1', scope: 'task', taskIds: ['task-1'],
      authorizationTypes: ['submit_applications'],
      options: { allow_auto_submit: true, require_human_review: true },
    })).rejects.toThrow(/explicit_no-review_task_consent/)
  })

  it('quarantines a forged/stale onboarding submit row even when its version and booleans look current', async () => {
    const db = makeDb()
    await ensureHamiltonAuthorizationSchema(db)
    await db.prepare(
      `INSERT INTO hamilton_authorizations
        (id, user_id, profile_id, scope, authorization_type, authorization_text,
         authorization_version, options_json, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'forged-onboarding-submit', 'user-1', 'profile-1', 'profile', 'submit_applications',
      HAMILTON_AUTOPILOT_AUTHORIZATION_TEXT, HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION,
      JSON.stringify({ allow_auto_submit: true, require_human_review: false }),
      JSON.stringify({ source: 'onboarding_legacy' }),
    )

    const active = await isAuthorizationActive(db, {
      userId: 'user-1', profileId: 'profile-1', taskId: 'task-1',
      fundingSourceId: 'opp-1', authorizationType: 'submit_applications',
    })
    expect(active).toBe(false)
    const resolved = await readAuthorizations(db, {
      userId: 'user-1', profileId: 'profile-1', taskId: 'task-1', fundingSourceId: 'opp-1',
    })
    expect(resolved.submit_applications).toBe(false)
    expect(resolved.require_human_review).toBe(true)
  })

  it('recognizes only current exact-task no-review consent and fails closed if its options drift', async () => {
    const db = makeDb()
    const [id] = await recordAuthorizations(db, {
      userId: 'user-1', profileId: 'profile-1', scope: 'task', taskIds: ['task-1'],
      authorizationTypes: ['submit_applications'],
      options: { allow_auto_submit: true, require_human_review: false },
      metadata: { source: 'exact_task_approval_endpoint' },
    })
    let resolved = await readAuthorizations(db, {
      userId: 'user-1', profileId: 'profile-1', taskId: 'task-1', fundingSourceId: 'opp-1',
    })
    expect(resolved.submit_applications).toBe(true)
    expect(resolved.require_human_review).toBe(false)

    await db.prepare('UPDATE hamilton_authorizations SET options_json = ? WHERE id = ?')
      .run(JSON.stringify({ allow_auto_submit: true, require_human_review: true }), id)
    resolved = await readAuthorizations(db, {
      userId: 'user-1', profileId: 'profile-1', taskId: 'task-1', fundingSourceId: 'opp-1',
    })
    expect(resolved.submit_applications).toBe(false)
    expect(resolved.require_human_review).toBe(true)
  })

  it('keeps onboarding and the batch launcher preparation-only in source', () => {
    const onboarding = fs.readFileSync(path.join(__dirname, '../../src/components/onboarding/AutomationChoiceBody.jsx'), 'utf8')
    const launcher = fs.readFileSync(path.join(__dirname, '../../src/components/hamilton/HamiltonAutopilotAuthorization.jsx'), 'utf8')
    expect(onboarding).not.toMatch(/authorizationTypes:[\s\S]{0,200}submit_applications/)
    expect(onboarding).not.toMatch(/authorizationTypes:[\s\S]{0,200}use_standing_attestation/)
    expect(onboarding).not.toContain('submitted without waiting on you')
    expect(onboarding).toContain('never authorizes a real portal submission')
    expect(launcher).not.toContain("types.push('submit_applications')")
    expect(launcher).toContain('Final Submit and new-account creation are not standing permissions')
  })
})
