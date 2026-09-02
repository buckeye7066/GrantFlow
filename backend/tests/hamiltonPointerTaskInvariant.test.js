import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import {
  _resetSchemaCache,
  ensureApplicationTask,
  ensureApplicationTaskSchema,
} from '../services/hamilton/applicationTaskStore.js'
import { repairLegacyPointerApplicationTasks } from '../services/hamilton/pointerTaskRepair.js'

const PROFILE_ID = 'profile-pointer-test'

async function makeDb() {
  _resetSchemaCache()
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      title TEXT,
      opportunity_kind TEXT,
      is_national INTEGER,
      application_url TEXT,
      apply_url TEXT,
      source_url TEXT,
      url TEXT,
      evidence_url TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      application_url TEXT,
      apply_url TEXT,
      source_url TEXT,
      url TEXT,
      evidence_url TEXT
    );
  `)
  await ensureApplicationTaskSchema(db)
  return db
}

describe('ensureApplicationTask pointer creation choke point', () => {
  let db

  beforeEach(async () => {
    db = await makeDb()
  })

  it('refuses a URL-less pointer before creating or reviving any task', async () => {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, opportunity_kind)
       VALUES ('pointer-no-url', 'County Assistance Directory', 'directory')`,
    ).run()

    await expect(ensureApplicationTask(db, {
      profileId: PROFILE_ID,
      opportunityId: 'pointer-no-url',
      automationType: 'portal',
    })).rejects.toMatchObject({
      code: 'pointer_research_lead',
      status: 422,
      handoff: expect.objectContaining({ kind: 'directory' }),
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM application_tasks').get().count).toBe(0)
  })

  it('refuses a URL-carrying pointer because a discovery page is not a leaf application', async () => {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, opportunity_kind, source_url)
       VALUES ('pointer-with-url', 'Official Scholarship Directory', 'directory', 'https://www.tn.gov/collegepays/')`,
    ).run()

    await expect(ensureApplicationTask(db, {
      profileId: PROFILE_ID,
      opportunityId: 'pointer-with-url',
      automationType: 'portal',
    })).rejects.toMatchObject({ code: 'pointer_research_lead' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM application_tasks').get().count).toBe(0)
  })

  it('preserves direct, kindless, and manual grant behavior', async () => {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, opportunity_kind)
       VALUES ('direct-no-url', 'Manual Direct Grant', 'direct_grant')`,
    ).run()
    db.prepare(
      `INSERT INTO grants (id, profile_id, title)
       VALUES ('manual-grant', ?, 'Owner-entered manual grant')`,
    ).run(PROFILE_ID)

    const direct = await ensureApplicationTask(db, {
      profileId: PROFILE_ID,
      opportunityId: 'direct-no-url',
      automationType: 'pdf_docx',
    })
    const manual = await ensureApplicationTask(db, {
      profileId: PROFILE_ID,
      grantId: 'manual-grant',
      automationType: 'pdf_docx',
    })
    expect(direct.id).toBeTruthy()
    expect(manual.id).toBeTruthy()
    expect(db.prepare('SELECT COUNT(*) AS count FROM application_tasks').get().count).toBe(2)
  })

  it('uses the grant-linked catalog kind even when the grant copied a directory URL', async () => {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, opportunity_kind)
       VALUES ('linked-pointer', 'Referral Locator', 'referral')`,
    ).run()
    db.prepare(
      `INSERT INTO grants (id, profile_id, funding_opportunity_id, title)
       VALUES ('grant-pointer', ?, 'linked-pointer', 'Referral Locator')`,
    ).run(PROFILE_ID)

    await expect(ensureApplicationTask(db, {
      profileId: PROFILE_ID,
      grantId: 'grant-pointer',
      automationType: 'portal',
    })).rejects.toMatchObject({ code: 'pointer_research_lead' })

    db.prepare(
      `UPDATE grants SET application_url = 'https://www.tn.gov/apply' WHERE id = 'grant-pointer'`,
    ).run()
    await expect(ensureApplicationTask(db, {
      profileId: PROFILE_ID,
      grantId: 'grant-pointer',
      automationType: 'portal',
    })).rejects.toMatchObject({ code: 'pointer_research_lead' })
  })

  it('fails closed when an existing grant belongs to another profile', async () => {
    db.prepare(
      `INSERT INTO grants (id, profile_id, title)
       VALUES ('other-profile-grant', 'profile-other', 'Other profile grant')`,
    ).run()

    await expect(ensureApplicationTask(db, {
      profileId: PROFILE_ID,
      grantId: 'other-profile-grant',
    })).rejects.toMatchObject({
      code: 'application_task_source_scope_mismatch',
      status: 403,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM application_tasks').get().count).toBe(0)
  })

  it('admits a same-profile grant whose opportunity carries ANOTHER profile\'s discovery provenance (provenance != ownership)', async () => {
    // A real local source ("Family Promise of Bradley County") discovered FOR one
    // Bradley County family is legitimately applicable to another. The grant is
    // the ownership authority; the opportunity's profile_id is only provenance.
    // Refusing here was the cross-profile false-403 that blocked John White.
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, opportunity_kind, is_national, profile_id, application_url)
       VALUES ('shared-local-opp', 'Family Promise of Bradley County', 'benefit', 0, 'profile-other', 'https://familypromisebradleytn.org/apply')`,
    ).run()
    db.prepare(
      `INSERT INTO grants (id, profile_id, funding_opportunity_id, title, application_url)
       VALUES ('my-grant-on-shared', ?, 'shared-local-opp', 'Family Promise', 'https://familypromisebradleytn.org/apply')`,
    ).run(PROFILE_ID)
    const task = await ensureApplicationTask(db, {
      profileId: PROFILE_ID, grantId: 'my-grant-on-shared', automationType: 'portal',
    })
    expect(task.id).toBeTruthy()
  })

  it('still fails closed for a BARE non-national opportunity discovered for another profile', async () => {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, opportunity_kind, is_national, profile_id, application_url)
       VALUES ('bare-other-opp', 'Local Fund', 'direct_grant', 0, 'profile-other', 'https://x.org/apply')`,
    ).run()
    await expect(ensureApplicationTask(db, {
      profileId: PROFILE_ID, opportunityId: 'bare-other-opp',
    })).rejects.toMatchObject({ code: 'application_task_source_scope_mismatch' })
  })

  it('admits a BARE national opportunity even when its provenance names another profile (shareable)', async () => {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, opportunity_kind, is_national, profile_id, application_url)
       VALUES ('nat-other-opp', 'National Grant', 'direct_grant', 1, 'profile-other', 'https://nat.org/apply')`,
    ).run()
    const task = await ensureApplicationTask(db, {
      profileId: PROFILE_ID, opportunityId: 'nat-other-opp', automationType: 'portal',
    })
    expect(task.id).toBeTruthy()
  })
})

describe('legacy pointer task repair', () => {
  let db

  beforeEach(async () => {
    db = await makeDb()
    db.exec(`
      INSERT INTO funding_opportunities (id, title, opportunity_kind)
        VALUES ('pointer-no-url', 'County Referral Locator', 'referral');
      INSERT INTO funding_opportunities (id, title, opportunity_kind, source_url)
        VALUES ('pointer-with-url', 'Scholarship Listing', 'directory', 'https://www.tn.gov/collegepays/');
      INSERT INTO funding_opportunities (id, title, opportunity_kind)
        VALUES ('direct-opportunity', 'Direct Opportunity', 'direct_grant');

      INSERT INTO grants (id, profile_id, funding_opportunity_id, title)
        VALUES ('terminal-grant', '${PROFILE_ID}', 'pointer-no-url', 'Terminal pointer task');
      INSERT INTO grants (id, profile_id, funding_opportunity_id, title, application_url)
        VALUES ('applyable-grant', '${PROFILE_ID}', 'pointer-no-url', 'Pointer with direct grant link', 'https://www.tn.gov/apply');
      INSERT INTO grants (id, profile_id, funding_opportunity_id, title)
        VALUES ('repaired-grant', '${PROFILE_ID}', 'pointer-no-url', 'Already repaired pointer');

      INSERT INTO application_tasks
        (id, profile_id, opportunity_id, grant_id, automation_type, status, current_step,
         output_document_id, auto_submit_enabled, allow_auto_submit,
         next_retry_at, audit_summary_json, created_at, updated_at)
      VALUES
        ('task-repair', '${PROFILE_ID}', 'pointer-no-url', NULL, 'portal', 'queued', 'queued',
         'document-must-survive', 1, 1, '2026-08-07', '{"existing_receipt":true}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('task-listing', '${PROFILE_ID}', 'pointer-with-url', NULL, 'portal', 'ready_to_start', 'ready_to_start',
         NULL, 0, 0, NULL, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('task-direct', '${PROFILE_ID}', 'direct-opportunity', NULL, 'portal', 'queued', 'queued',
         NULL, 0, 0, NULL, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('task-terminal', '${PROFILE_ID}', NULL, 'terminal-grant', 'portal', 'submitted', 'submitted',
         'submission-proof-must-survive', 0, 0, NULL, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('task-grant-url', '${PROFILE_ID}', NULL, 'applyable-grant', 'portal', 'queued', 'queued',
         NULL, 0, 0, NULL, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('task-already-repaired', '${PROFILE_ID}', NULL, 'repaired-grant', 'research_lead', 'blocked', 'no_application_surface',
         'old-packet-must-survive', 0, 0, NULL, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `)
  })

  it('dry-runs with reconciled exception classes and makes no writes', async () => {
    const report = await repairLegacyPointerApplicationTasks(db, { dryRun: true })

    expect(report).toMatchObject({
      scanned: 5,
      non_applyable: 3,
      applyable: 2,
      would_repair: 1,
      repaired: 0,
      protected_terminal: 1,
      already_repaired: 1,
      deferred_by_limit: 0,
      dry_run: true,
    })
    expect(report.scanned).toBe(report.applyable + report.non_applyable + report.source_scope_errors)
    expect(db.prepare('SELECT status FROM application_tasks WHERE id = ?').get('task-repair').status).toBe('queued')
    expect(db.prepare('SELECT COUNT(*) AS count FROM application_task_events').get().count).toBe(0)
  })

  it('blocks only non-applyable legacy pointers, preserves evidence, and appends an idempotent audit receipt', async () => {
    const report = await repairLegacyPointerApplicationTasks(db, {
      actorUserId: 'audit-owner',
      actorRole: 'admin',
    })

    expect(report).toMatchObject({
      scanned: 5,
      non_applyable: 3,
      applyable: 2,
      would_repair: 1,
      repaired: 1,
      protected_terminal: 1,
      already_repaired: 1,
      conflicts: 0,
      audit_event_failures: 0,
    })

    const repaired = db.prepare('SELECT * FROM application_tasks WHERE id = ?').get('task-repair')
    expect(repaired).toMatchObject({
      automation_type: 'research_lead',
      status: 'blocked',
      current_step: 'no_application_surface',
      output_document_id: 'document-must-survive',
      auto_submit_enabled: 0,
      allow_auto_submit: 0,
      next_retry_at: null,
    })
    const audit = JSON.parse(repaired.audit_summary_json)
    expect(audit.existing_receipt).toBe(true)
    expect(audit.pointer_research_lead_repair).toMatchObject({
      evidence_preserved: true,
      submission_intent_disabled: true,
      previous_status: 'queued',
    })

    const event = db.prepare('SELECT * FROM application_task_events WHERE task_id = ?').get('task-repair')
    expect(event).toMatchObject({
      event_type: 'blocked',
      status: 'blocked',
      step: 'no_application_surface',
      actor_user_id: 'audit-owner',
      actor_role: 'admin',
    })
    expect(JSON.parse(event.details_json)).toMatchObject({
      reason: 'pointer_research_lead',
      evidence_preserved: true,
      output_document_ids: ['document-must-survive'],
    })

    expect(db.prepare('SELECT status, output_document_id FROM application_tasks WHERE id = ?').get('task-terminal'))
      .toMatchObject({ status: 'submitted', output_document_id: 'submission-proof-must-survive' })
    expect(db.prepare('SELECT status FROM application_tasks WHERE id = ?').get('task-listing').status).toBe('ready_to_start')
    expect(db.prepare('SELECT status FROM application_tasks WHERE id = ?').get('task-grant-url').status).toBe('queued')
    expect(db.prepare('SELECT status FROM application_tasks WHERE id = ?').get('task-direct').status).toBe('queued')

    const second = await repairLegacyPointerApplicationTasks(db)
    expect(second).toMatchObject({ would_repair: 0, repaired: 0, already_repaired: 2 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM application_task_events WHERE task_id = ?').get('task-repair').count).toBe(1)
  })
})
