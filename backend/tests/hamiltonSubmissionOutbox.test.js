import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  _resetSubmissionAttemptSchemaCache,
  createOrClaimSubmissionAttempt,
  recordExternalReceipt,
  transitionSubmissionAttempt,
} from '../services/hamilton/hamiltonSubmissionAttemptStore.js'
import {
  drainHamiltonSubmissionOutbox,
} from '../services/hamilton/hamiltonSubmissionReceiptProjector.js'
import {
  _resetSchemaCache as resetTaskSchema,
  ensureApplicationTaskSchema,
} from '../services/hamilton/applicationTaskStore.js'
import { _resetNotificationsSchemaCache } from '../services/hamilton/hamiltonNotifications.js'
import { _resetPortalPolicySchemaCache } from '../services/hamilton/hamiltonPortalPolicyRegistry.js'
import {
  onboardReviewedSubmissionAdapter,
  SYNTHETIC_REFERENCE_ADAPTER,
} from '../services/hamilton/hamiltonSubmissionAdapterRegistry.js'
import { HAMILTON_SUBMISSION_LIFECYCLE } from '../../shared/hamiltonSubmissionContract.js'
import { contractSha256, stableContractJson } from '../../shared/irreversibleActionContract.js'
import { assessTaskSubmissionProof } from '../services/hamilton/submissionProofPredicate.js'

const T0 = new Date('2026-08-05T18:00:00.000Z')
const T1 = new Date('2026-08-05T18:00:20.000Z')

function resetCaches() {
  _resetSubmissionAttemptSchemaCache()
  resetTaskSchema()
  _resetNotificationsSchemaCache()
  _resetPortalPolicySchemaCache()
}

function makeDb() {
  resetCaches()
  return wrapSqlite(new Database(':memory:'))
}

function fixtures(definition) {
  const applicationIdentity = 'fixture-app-123'
  const success = {
    case: 'new_receipt_success', application_identity: applicationIdentity,
    receipt_application_identity: applicationIdentity, receipt_container_count: 1,
    pre_click_text: 'Review application',
    post_click_text: 'Your application has been received. Confirmation Number: CONF-123456',
    form_observation: {
      field_contract_sha256: contractSha256(stableContractJson(definition.field_contract)),
      required_answer_keys: definition.field_contract.fields.filter((field) => field.required).map((field) => field.answer_key),
    },
  }
  return [
    success,
    { case: 'preexisting_application_id_negative', application_identity: applicationIdentity, pre_click_text: 'Application ID: DRAFT-123456', post_click_text: 'Application ID: DRAFT-123456' },
    { case: 'unchanged_spa_negative', application_identity: applicationIdentity, pre_click_text: success.post_click_text, post_click_text: success.post_click_text },
    { case: 'screenshot_only_negative', application_identity: applicationIdentity },
    { case: 'ambiguous_timeout_negative', application_identity: applicationIdentity },
    {
      case: 'unrelated_receipt_negative', application_identity: applicationIdentity,
      receipt_application_identity: 'fixture-app-other', receipt_container_count: 1,
      post_click_text: 'Your application has been received. Confirmation Number: CONF-OTHER-123',
    },
    {
      case: 'multiple_application_receipts_negative', application_identity: applicationIdentity,
      receipt_application_identity: applicationIdentity, receipt_container_count: 2,
      post_click_text: 'Your application has been received. Confirmation Number: CONF-AMBIG-123',
    },
    {
      case: 'exact_status_absence', application_identity: applicationIdentity,
      status_lookup: {
        application_identity: applicationIdentity, outcome: 'absent',
        query_parameter: definition.status_query.query_parameter, response_sha256: 'f'.repeat(64),
        path_prefix: definition.status_query.path_prefix,
        container_selector_sha256: contractSha256(definition.status_query.container_selector),
        identity_container_match: true, matching_container_count: 1,
        identity_match_count: 1, status_match_count: 1,
      },
    },
  ]
}

async function seedTask(db, {
  id, opportunityId = 'opp-1', grantId = null, profileId = 'profile-1', userId = 'user-1',
}) {
  await ensureApplicationTaskSchema(db)
  await db.prepare(
    `INSERT INTO application_tasks
      (id, user_id, profile_id, opportunity_id, grant_id, assigned_agent, automation_type, status)
     VALUES (?, ?, ?, ?, ?, 'hamilton', 'portal', 'ready')`,
  ).run(id, userId, profileId, opportunityId, grantId)
}

async function seedReceivedAttempt(db, { taskIds = ['task-a'] } = {}) {
  const onboarded = await onboardReviewedSubmissionAdapter(db, {
    portalHost: SYNTHETIC_REFERENCE_ADAPTER.portal_host,
    definition: SYNTHETIC_REFERENCE_ADAPTER,
    fixtures: fixtures(SYNTHETIC_REFERENCE_ADAPTER),
    reviewedByUserId: 'operator-1',
    now: T0,
  })
  expect(onboarded.onboarded, JSON.stringify(onboarded.report?.errors)).toBe(true)
  const targetUrl = 'https://fixture.hamilton.invalid/apply?applicationId=receipt-1&resume=secret'
  const baseArgs = {
    profileId: 'profile-1', userId: 'user-1',
    fundingSourceId: 'funding_opportunity:opp-1', authorizationTargetId: 'opp-1',
    portalHost: SYNTHETIC_REFERENCE_ADAPTER.portal_host,
    targetUrl, executableTargetUrl: targetUrl,
    applicationIdentity: 'fixture-receipt-1',
    authorizationVersion: 'hamilton-external-submit-v2',
    authorizationIds: ['auth-submit'],
    consentSnapshot: { version: 'hamilton-external-submit-v2', submit: true },
    answerSnapshotHash: 'a'.repeat(64),
    submissionAdapter: onboarded.submission_adapter,
    now: T0,
  }
  let claim
  for (const taskId of taskIds) {
    claim = await createOrClaimSubmissionAttempt(db, { ...baseArgs, taskId })
  }
  const attempt = claim.attempt
  await transitionSubmissionAttempt(db, {
    attemptId: attempt.id, fenceToken: attempt.fence_token,
    toState: HAMILTON_SUBMISSION_LIFECYCLE.READY_FOR_FINAL_SUBMIT, now: T0,
  })
  await transitionSubmissionAttempt(db, {
    attemptId: attempt.id, fenceToken: attempt.fence_token,
    toState: HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT, now: T0,
  })
  const current = await db.prepare('SELECT * FROM hamilton_submission_attempts WHERE id = ?').get(attempt.id)
  const adapter = onboarded.submission_adapter
  const receipt = await recordExternalReceipt(db, {
    attemptId: attempt.id,
    fenceToken: attempt.fence_token,
    proof: {
      evidence_type: 'portal_confirmation_reference', source: 'portal_response',
      attempt_id: attempt.id, task_id: taskIds[0], profile_id: 'profile-1', user_id: 'user-1',
      funding_source_id: 'funding_opportunity:opp-1', application_identity: 'fixture-receipt-1',
      target_locator_sha256: current.target_locator_sha256,
      portal_url: 'https://fixture.hamilton.invalid/apply/receipt/secret-path?token=secret',
      captured_at: '2026-08-05T18:00:10.000Z', confirmation_reference: 'CONF-8675309',
      reference_kind: 'confirmation', received_acknowledgement: true,
      pre_click_page_fingerprint: 'b'.repeat(64), post_click_page_fingerprint: 'c'.repeat(64),
      extraction_rule: 'adapter_exact_label:confirmation',
      portal_policy_version: `${adapter.id}@${adapter.version}:${adapter.fixture_contract_sha256}`,
      portal_adapter: { id: adapter.id, version: adapter.version, fixture_contract_sha256: adapter.fixture_contract_sha256 },
    },
    now: T1,
  })
  expect(receipt.recorded, receipt.reason).toBe(true)
  return receipt.attempt
}

beforeEach(resetCaches)

describe('Hamilton receipt outbox projection', () => {
  it('recovers after receipt commit/restart and projects exactly once under concurrent drainers', async () => {
    const db = makeDb()
    await seedTask(db, { id: 'task-a' })
    await seedReceivedAttempt(db)
    expect((await db.prepare('SELECT status FROM application_tasks WHERE id = ?').get('task-a')).status).toBe('ready')

    const [a, b] = await Promise.all([
      drainHamiltonSubmissionOutbox(db, { leaseOwner: 'projector-a', now: T1 }),
      drainHamiltonSubmissionOutbox(db, { leaseOwner: 'projector-b', now: T1 }),
    ])
    expect(a.projected + b.projected).toBe(1)
    expect((await db.prepare('SELECT status FROM application_tasks WHERE id = ?').get('task-a')).status).toBe('externally_received')
    expect((await db.prepare('SELECT COUNT(*) AS count FROM application_task_events WHERE task_id = ?').get('task-a')).count).toBe(1)
    expect((await db.prepare('SELECT COUNT(*) AS count FROM notifications').get()).count).toBe(1)
    const replay = await drainHamiltonSubmissionOutbox(db, { leaseOwner: 'projector-c', now: T1 })
    expect(replay.projected).toBe(0)
  })

  it('maps one verified portal receipt across duplicate tasks backed by different internal funding rows', async () => {
    const db = makeDb()
    await seedTask(db, { id: 'task-a', opportunityId: 'opp-1' })
    await seedTask(db, { id: 'task-b', opportunityId: 'opp-2' })
    const received = await seedReceivedAttempt(db, { taskIds: ['task-a'] })

    const adapter = await onboardReviewedSubmissionAdapter(db, {
      portalHost: SYNTHETIC_REFERENCE_ADAPTER.portal_host,
      definition: SYNTHETIC_REFERENCE_ADAPTER,
      fixtures: fixtures(SYNTHETIC_REFERENCE_ADAPTER),
      reviewedByUserId: 'operator-1', now: T0,
    })
    expect(adapter.onboarded).toBe(true)
    const targetUrl = 'https://fixture.hamilton.invalid/apply?applicationId=receipt-1&resume=another-secret'
    const duplicate = await createOrClaimSubmissionAttempt(db, {
      taskId: 'task-b', profileId: 'profile-1', userId: 'user-1',
      fundingSourceId: 'funding_opportunity:opp-2', authorizationTargetId: 'opp-2',
      portalHost: SYNTHETIC_REFERENCE_ADAPTER.portal_host,
      targetUrl, executableTargetUrl: targetUrl,
      applicationIdentity: 'fixture-receipt-1',
      authorizationVersion: 'hamilton-external-submit-v2',
      authorizationIds: ['auth-submit-other-source'],
      consentSnapshot: { version: 'hamilton-external-submit-v2', submit: true },
      answerSnapshotHash: 'a'.repeat(64), submissionAdapter: adapter.submission_adapter,
      mapTerminalReceiptToDuplicateTask: true, now: T1,
    })
    expect(duplicate).toMatchObject({ claimed: false, reason: 'already_received' })
    expect(duplicate.attempt.id).toBe(received.id)
    expect(duplicate.attempt.task_scopes['task-b']).toMatchObject({
      funding_source_id: 'funding_opportunity:opp-2',
    })

    const projected = await drainHamiltonSubmissionOutbox(db, { now: T1 })
    expect(projected).toMatchObject({ projected: 1, failed: 0 })
    const states = await db.prepare('SELECT id, status FROM application_tasks ORDER BY id').all()
    expect(states).toEqual([
      expect.objectContaining({ id: 'task-a', status: 'externally_received' }),
      expect.objectContaining({ id: 'task-b', status: 'externally_received' }),
    ])
    expect((await db.prepare('SELECT COUNT(*) AS count FROM application_task_events').get()).count).toBe(2)
    expect((await db.prepare('SELECT COUNT(*) AS count FROM notifications').get()).count).toBe(1)
  })

  it('rejects injected payload references before mutating any task', async () => {
    const db = makeDb()
    await seedTask(db, { id: 'task-a' })
    await seedTask(db, { id: 'task-injected', opportunityId: 'opp-2' })
    const attempt = await seedReceivedAttempt(db)
    const row = await db.prepare(
      `SELECT id, payload_json FROM hamilton_submission_outbox WHERE attempt_id = ?`,
    ).get(attempt.id)
    const payload = JSON.parse(row.payload_json)
    payload.task_references.push('task-injected')
    await db.prepare('UPDATE hamilton_submission_outbox SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(payload), row.id)
    const result = await drainHamiltonSubmissionOutbox(db, { now: T1 })
    expect(result.failed).toBe(1)
    const states = await db.prepare('SELECT id, status FROM application_tasks ORDER BY id').all()
    expect(states).toEqual([
      expect.objectContaining({ id: 'task-a', status: 'ready' }),
      expect.objectContaining({ id: 'task-injected', status: 'ready' }),
    ])
  })

  it('prevalidates every authoritative task funding identity and replays atomically after repair', async () => {
    const db = makeDb()
    await seedTask(db, { id: 'task-a' })
    await seedTask(db, { id: 'task-b', opportunityId: 'wrong-opp', grantId: 'grant-1' })
    await seedReceivedAttempt(db, { taskIds: ['task-a', 'task-b'] })
    const first = await drainHamiltonSubmissionOutbox(db, { now: T1 })
    expect(first.failed).toBe(1)
    expect((await db.prepare('SELECT status FROM application_tasks WHERE id = ?').get('task-a')).status).toBe('ready')
    expect((await db.prepare('SELECT COUNT(*) AS count FROM hamilton_submission_task_projections').get()).count).toBe(0)

    await db.prepare('UPDATE application_tasks SET opportunity_id = ? WHERE id = ?').run('opp-1', 'task-b')
    const later = new Date('2026-08-05T18:02:00.000Z')
    const replay = await drainHamiltonSubmissionOutbox(db, { now: later })
    expect(replay.projected).toBe(1)
    expect((await db.prepare("SELECT COUNT(*) AS count FROM application_tasks WHERE status = 'externally_received'").get()).count).toBe(2)
    expect((await db.prepare('SELECT COUNT(*) AS count FROM hamilton_submission_task_projections').get()).count).toBe(2)
  })

  it('fails closed when a terminal attempt row has malformed immutable task references', async () => {
    const db = makeDb()
    await seedTask(db, { id: 'task-a' })
    const attempt = await seedReceivedAttempt(db)
    await db.prepare('UPDATE hamilton_submission_attempts SET task_references_json = ? WHERE id = ?')
      .run('{}', attempt.id)
    const result = await drainHamiltonSubmissionOutbox(db, { now: T1 })
    expect(result.failed).toBe(1)
    expect((await db.prepare('SELECT status FROM application_tasks WHERE id = ?').get('task-a')).status).toBe('ready')
  })

  it('assesses genuine v2 proof for primary and duplicate refs but rejects malformed rows', async () => {
    const db = makeDb()
    await seedTask(db, { id: 'task-a' })
    await seedTask(db, { id: 'task-b', opportunityId: 'opp-1', grantId: 'grant-1' })
    const attempt = await seedReceivedAttempt(db, { taskIds: ['task-a', 'task-b'] })
    const raw = await db.prepare('SELECT * FROM hamilton_submission_attempts WHERE id = ?').get(attempt.id)
    for (const taskId of ['task-a', 'task-b']) {
      const assessed = await assessTaskSubmissionProof(db, {
        id: taskId, status: 'externally_received', output_document_id: null,
      }, { attempts: [raw] })
      expect(assessed.verified_external, `${taskId}:${assessed.unverified_reason}`).toBe(true)
    }
    const malformed = { ...raw, task_references_json: '{}' }
    const rejected = await assessTaskSubmissionProof(db, {
      id: 'task-a', status: 'externally_received', output_document_id: null,
    }, { attempts: [malformed] })
    expect(rejected.verified_external).toBe(false)
    expect(rejected.unverified_reason).toBe('externally_received_state_without_valid_bound_proof')
  })
})
