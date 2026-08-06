import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

import migrateSubmissionAttemptStates, {
  APPLICATION_TASK_STATUSES as SQLITE_MIGRATION_STATUSES,
} from '../db/migrations/163_hamilton_submission_attempt_states.mjs'
import {
  _resetSchemaCache,
  beginSubmissionAttempt,
  cancelApplicationTask,
  ensureApplicationTask,
  ensureApplicationTaskSchema,
  getApplicationTask,
  listTaskEvents,
  TASK_STATUSES,
  updateApplicationTask,
} from '../services/hamilton/applicationTaskStore.js'

function makeDb() {
  _resetSchemaCache()
  return new Database(':memory:')
}

async function makePortalTask(db, {
  opportunityId,
  allowAutoSubmit = true,
  status = 'filling_portal',
} = {}) {
  const task = await ensureApplicationTask(db, {
    profileId: 'profile-lease',
    opportunityId,
    automationType: 'portal',
    allowAutoSubmit,
  })
  return updateApplicationTask(db, task.id, { status })
}

describe('durable Hamilton submission lease', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureApplicationTaskSchema(db)
  })

  it('refreshes both stored submit-intent columns when intent is explicit', async () => {
    const task = await ensureApplicationTask(db, {
      profileId: 'profile-lease',
      opportunityId: 'intent-sync',
      allowAutoSubmit: true,
    })
    expect(task.allow_auto_submit).toBe(true)
    expect(task.auto_submit_enabled).toBe(true)

    const disabled = await ensureApplicationTask(db, {
      profileId: 'profile-lease',
      opportunityId: 'intent-sync',
      allowAutoSubmit: false,
    })
    expect(disabled.id).toBe(task.id)
    expect(disabled.allow_auto_submit).toBe(false)
    expect(disabled.auto_submit_enabled).toBe(false)

    // Omission means no new owner decision; it must not revive either flag.
    const unchanged = await ensureApplicationTask(db, {
      profileId: 'profile-lease',
      opportunityId: 'intent-sync',
    })
    expect(unchanged.allow_auto_submit).toBe(false)
    expect(unchanged.auto_submit_enabled).toBe(false)
  })

  it('lets Disable win durably and refuses to revive intent across an uncertain boundary', async () => {
    const task = await makePortalTask(db, { opportunityId: 'intent-veto-after-boundary' })
    await updateApplicationTask(db, task.id, { status: 'submit_attempt_started' })

    const disabled = await ensureApplicationTask(db, {
      profileId: 'profile-lease',
      opportunityId: 'intent-veto-after-boundary',
      allowAutoSubmit: false,
    })
    expect(disabled.status).toBe('submit_attempt_started')
    expect(disabled.allow_auto_submit).toBe(false)
    expect(disabled.auto_submit_enabled).toBe(false)

    const replayedEnable = await ensureApplicationTask(db, {
      profileId: 'profile-lease',
      opportunityId: 'intent-veto-after-boundary',
      allowAutoSubmit: true,
    })
    expect(replayedEnable.status).toBe('submit_attempt_started')
    expect(replayedEnable.allow_auto_submit).toBe(false)
    expect(replayedEnable.auto_submit_enabled).toBe(false)
  })

  it('acquires exactly once from filling_portal with live durable intent', async () => {
    const task = await makePortalTask(db, { opportunityId: 'cas-once' })

    const first = await beginSubmissionAttempt(db, task.id, { actorRole: 'agent' })
    const second = await beginSubmissionAttempt(db, task.id, { actorRole: 'agent' })

    expect(first.acquired).toBe(true)
    expect(first.task.status).toBe('submit_attempt_started')
    expect(second.acquired).toBe(false)
    expect(second.reason).toBe('invalid_status:submit_attempt_started')
    const events = (await listTaskEvents(db, task.id))
      .filter((event) => event.step === 'submit_attempt_started')
    expect(events).toHaveLength(1)
    expect(events[0].details).toMatchObject({
      irreversible_boundary: true,
      submission_evidence_required: true,
    })
  })

  it('prevents a stale concurrent runner from overwriting the durable lease or final outcome', async () => {
    const task = await makePortalTask(db, { opportunityId: 'stale-run-guard' })
    const lease = await beginSubmissionAttempt(db, task.id)
    expect(lease.acquired).toBe(true)

    const staleDraft = await updateApplicationTask(db, task.id, {
      status: 'waiting_for_review',
      lastAgentMessage: 'stale worker finished a draft',
      unlessCancelled: true,
    })
    expect(staleDraft.status).toBe('submit_attempt_started')

    const pending = await updateApplicationTask(db, task.id, {
      status: 'submit_evidence_pending',
      onlyIfStatuses: ['submit_attempt_started'],
    })
    expect(pending.status).toBe('submit_evidence_pending')

    const staleFailure = await updateApplicationTask(db, task.id, {
      status: 'failed',
      unlessCancelled: true,
    })
    expect(staleFailure.status).toBe('submit_evidence_pending')

    const submitted = await updateApplicationTask(db, task.id, {
      status: 'submitted',
      onlyIfStatuses: ['submit_evidence_pending'],
    })
    expect(submitted.status).toBe('submitted')

    const staleBlocked = await updateApplicationTask(db, task.id, {
      status: 'blocked',
      unlessCancelled: true,
    })
    expect(staleBlocked.status).toBe('submitted')
  })

  it('refuses the boundary when intent is off, status is wrong, or cancellation already exists', async () => {
    const disabled = await makePortalTask(db, {
      opportunityId: 'disabled',
      allowAutoSubmit: false,
    })
    expect(await beginSubmissionAttempt(db, disabled.id)).toMatchObject({
      acquired: false,
      reason: 'auto_submit_disabled',
    })

    const wrongStatus = await makePortalTask(db, {
      opportunityId: 'wrong-status',
      status: 'ready_to_start',
    })
    expect(await beginSubmissionAttempt(db, wrongStatus.id)).toMatchObject({
      acquired: false,
      reason: 'invalid_status:ready_to_start',
    })

    const cancelledStamp = await makePortalTask(db, { opportunityId: 'cancelled-stamp' })
    await updateApplicationTask(db, cancelledStamp.id, { cancelledAt: new Date().toISOString() })
    expect(await beginSubmissionAttempt(db, cancelledStamp.id)).toMatchObject({
      acquired: false,
      reason: 'task_cancelled',
    })
  })

  it.each(['submit_attempt_started', 'submit_evidence_pending'])(
    'turns cancellation during %s into an honest verification quarantine',
    async (status) => {
      const task = await makePortalTask(db, { opportunityId: `cancel-${status}` })
      await updateApplicationTask(db, task.id, {
        status,
        allowAutoSubmit: true,
        autoSubmitEnabled: true,
      })

      const cancelled = await cancelApplicationTask(db, task.id, { reason: 'owner requested stop' })
      expect(cancelled.status).toBe('submission_verification_required')
      expect(cancelled.current_step).toBe('submission_verification_required')
      expect(cancelled.allow_auto_submit).toBe(false)
      expect(cancelled.auto_submit_enabled).toBe(false)
      expect(cancelled.cancelled_at).toBeNull()
      expect(cancelled.last_agent_message).toMatch(/may already be in progress/i)

      const staleRunUpdate = await updateApplicationTask(db, task.id, {
        status: 'submitted',
        lastAgentMessage: 'stale browser run claimed success',
        unlessCancelled: true,
      })
      expect(staleRunUpdate.status).toBe('submission_verification_required')
      expect(staleRunUpdate.last_agent_message).toMatch(/may already be in progress/i)

      // A repeated click on Cancel must not erase the already-recorded ambiguity.
      const repeated = await cancelApplicationTask(db, task.id, { reason: 'owner repeated stop' })
      expect(repeated.status).toBe('submission_verification_required')
      expect(repeated.last_agent_message).toMatch(/confirmation must be verified/i)
    },
  )

  it('still cancels normally before the irreversible boundary', async () => {
    const task = await makePortalTask(db, { opportunityId: 'cancel-before-boundary' })
    const cancelled = await cancelApplicationTask(db, task.id, { reason: 'owner requested stop' })
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.allow_auto_submit).toBe(false)
    expect(cancelled.auto_submit_enabled).toBe(false)
    expect(cancelled.cancelled_at).toBeTruthy()
  })
})

describe('submission-state schema parity', () => {
  it('keeps runtime, SQLite migration, SQLite bootstrap, and PostgreSQL migration in sync', () => {
    expect([...SQLITE_MIGRATION_STATUSES]).toEqual([...TASK_STATUSES])
    const schema = fs.readFileSync(path.resolve('backend/db/schema.sql'), 'utf8')
    const pgMigration = fs.readFileSync(
      path.resolve('backend/db/postgres/migrations/0167_hamilton_submission_attempt_states.sql'),
      'utf8',
    )
    for (const status of TASK_STATUSES) {
      expect(schema).toContain(`'${status}'`)
      expect(pgMigration).toContain(`'${status}'`)
    }

    const fresh = makeDb()
    fresh.exec(schema)
    fresh.prepare(`INSERT INTO profiles (id, display_name) VALUES ('profile-schema', 'Schema Test')`).run()
    for (const [index, status] of [
      'submit_attempt_started',
      'submit_evidence_pending',
      'submission_verification_required',
    ].entries()) {
      expect(() => fresh.prepare(`
        INSERT INTO application_tasks (id, profile_id, opportunity_id, status)
        VALUES (?, 'profile-schema', ?, ?)
      `).run(`schema-${index}`, `schema-opportunity-${index}`, status)).not.toThrow()
    }
  })

  it('widens a legacy SQLite CHECK without rebuilding or losing task data', async () => {
    const db = makeDb()
    db.exec(`
      CREATE TABLE application_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('queued','filling_portal')),
        payload TEXT
      );
      INSERT INTO application_tasks (id, status, payload)
      VALUES ('existing', 'queued', 'preserve-me');
    `)

    await migrateSubmissionAttemptStates(db)
    db.prepare(`UPDATE application_tasks SET status = 'submit_attempt_started' WHERE id = 'existing'`).run()
    expect(db.prepare(`SELECT status, payload FROM application_tasks WHERE id = 'existing'`).get())
      .toEqual({ status: 'submit_attempt_started', payload: 'preserve-me' })
    expect(() => db.prepare(`
      INSERT INTO application_tasks (id, status) VALUES ('invalid', 'not-a-real-status')
    `).run()).toThrow(/check constraint/i)

    // The migration is idempotent even outside the normal _migrations guard.
    await expect(migrateSubmissionAttemptStates(db)).resolves.toBeUndefined()
  })
})
