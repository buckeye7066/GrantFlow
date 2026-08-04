/**
 * ensureApplicationTask — a GRANT-backed task's identity is (profile, grant).
 *
 * The exact-key lookup treated (grant, NULL-opportunity) and (grant,
 * opportunity) as DIFFERENT tasks, so the 2026-07-21 batch minted duplicates
 * for grants whose earlier task predated opportunity linking (prod: one grant
 * carrying a 'completed' 07-21 task AND a 'ready_to_start' 07-01 task at
 * once — two cards for one real application). The fix: when no exact-key row
 * exists, ADOPT a live same-grant task instead of duplicating it, and
 * backfill its opportunity_id when the found row has none. A TERMINAL
 * same-grant task is deliberately NOT adopted so cancel-then-recreate keeps
 * working.
 */

import { describe, it, expect, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const {
  ensureApplicationTask,
  ensureApplicationTaskSchema,
  _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')

const PROFILE = 'p-adopt'

describe('ensureApplicationTask — same-grant adoption', () => {
  let db
  beforeEach(async () => {
    _resetSchemaCache()
    db = new Database(':memory:')
    await ensureApplicationTaskSchema(db)
  })

  const taskCount = () => db.prepare('SELECT COUNT(*) AS n FROM application_tasks').get().n
  const insertLegacyTask = (id, { grantId, opportunityId = null, status = 'ready_to_start' }) =>
    db.prepare(
      `INSERT INTO application_tasks (id, profile_id, grant_id, opportunity_id, status, automation_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'portal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(id, PROFILE, grantId, opportunityId, status)

  it('ADOPTS a live same-grant task instead of minting a duplicate, and backfills its opportunity_id', async () => {
    // The prod shape: a 07-01 task created before opportunity linking.
    insertLegacyTask('t-legacy', { grantId: 'g-1' })

    const task = await ensureApplicationTask(db, {
      profileId: PROFILE,
      grantId: 'g-1',
      opportunityId: 'opp-1', // the later batch supplies the linked catalog row
      automationType: 'portal',
    })

    expect(task.id).toBe('t-legacy')
    expect(task.opportunity_id).toBe('opp-1')
    expect(taskCount()).toBe(1) // no duplicate card
  })

  it('never adopts across grants or profiles — a different grant still creates its own task', async () => {
    insertLegacyTask('t-other', { grantId: 'g-other' })

    const task = await ensureApplicationTask(db, {
      profileId: PROFILE,
      grantId: 'g-1',
      automationType: 'portal',
    })

    expect(task.id).not.toBe('t-other')
    expect(taskCount()).toBe(2)
  })

  it('does NOT adopt a TERMINAL same-grant task — cancel-then-recreate stays possible', async () => {
    insertLegacyTask('t-cancelled', { grantId: 'g-1', status: 'cancelled' })

    // opportunityId present so the exact-key lookup (which matches NULL-opp
    // rows only by exact key, terminal included — long-standing idempotent
    // re-POST behavior) cannot be the path that answers; only the new
    // same-grant adoption path could adopt here, and it must refuse.
    const task = await ensureApplicationTask(db, {
      profileId: PROFILE,
      grantId: 'g-1',
      opportunityId: 'opp-1',
      automationType: 'portal',
    })

    expect(task.id).not.toBe('t-cancelled')
    expect(task.status).toBe('queued')
    expect(taskCount()).toBe(2)
  })

  it("keeps an already-linked live task's opportunity_id when the ensure call carries a different one", async () => {
    insertLegacyTask('t-linked', { grantId: 'g-1', opportunityId: 'opp-original' })

    const task = await ensureApplicationTask(db, {
      profileId: PROFILE,
      grantId: 'g-1',
      opportunityId: 'opp-different',
      automationType: 'portal',
    })

    // Adopted (no duplicate), but the stored link is not clobbered.
    expect(task.id).toBe('t-linked')
    expect(task.opportunity_id).toBe('opp-original')
    expect(taskCount()).toBe(1)
  })

  it('the exact-key idempotent re-POST still resumes the same task (pre-fix behavior intact)', async () => {
    const first = await ensureApplicationTask(db, {
      profileId: PROFILE,
      grantId: 'g-1',
      opportunityId: 'opp-1',
      automationType: 'portal',
    })
    const second = await ensureApplicationTask(db, {
      profileId: PROFILE,
      grantId: 'g-1',
      opportunityId: 'opp-1',
      automationType: 'portal',
    })
    expect(second.id).toBe(first.id)
    expect(taskCount()).toBe(1)
  })
})
