import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'

import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  _internal,
  _resetSubmissionAttemptSchemaCache,
  assessExternalReceiptProof,
  assertSubmissionAttemptFence,
  cancelSubmissionAttemptsForAuthorization,
  claimSubmissionReconciliation,
  createOrClaimSubmissionAttempt,
  getSubmissionAttempt,
  listSubmissionAuditEvents,
  normalizeSubmissionAttemptRow,
  recordExternalReceipt,
  transitionSubmissionAttempt,
} from '../services/hamilton/hamiltonSubmissionAttemptStore.js'
import {
  onboardReviewedSubmissionAdapter,
  SYNTHETIC_REFERENCE_ADAPTER,
} from '../services/hamilton/hamiltonSubmissionAdapterRegistry.js'
import { HAMILTON_SUBMISSION_LIFECYCLE } from '../../shared/hamiltonSubmissionContract.js'
import { contractSha256, stableContractJson } from '../../shared/irreversibleActionContract.js'

const NOW = new Date('2026-08-05T16:00:00.000Z')
const RECEIPT_NOW = new Date('2026-08-05T16:00:20.000Z')
const TEST_ADAPTER = Object.freeze({
  ...SYNTHETIC_REFERENCE_ADAPTER,
  id: 'test-receipt-adapter',
  version: '1.0.0',
  fixture_contract_sha256: 'c'.repeat(64),
})

function makeDb() {
  _resetSubmissionAttemptSchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

function claimArgs(overrides = {}) {
  return {
    taskId: 'task-1',
    profileId: 'profile-1',
    userId: 'user-1',
    fundingSourceId: 'opp-1',
    portalHost: 'portal.example.org',
    targetUrl: 'https://portal.example.org/application/abc',
    applicationIdentity: 'portal-app-abc',
    authorizationVersion: 'hamilton-external-submit-v2',
    authorizationIds: ['auth-fill', 'auth-submit'],
    consentSnapshot: { autopilot: true, auto_submit: true, version: 'hamilton-external-submit-v2' },
    answerSnapshotHash: 'a'.repeat(64),
    answerProvenance: { school: { source: 'target-scoped-application:app-1' } },
    documentIds: ['doc-1'],
    submissionAdapter: TEST_ADAPTER,
    leaseOwner: 'worker-a',
    leaseMs: 60_000,
    now: NOW,
    ...overrides,
  }
}

function receiptProof(attempt, overrides = {}) {
  const adapter = attempt.submission_adapter
  return {
    evidence_type: 'portal_confirmation_reference',
    source: 'portal_response',
    attempt_id: attempt.id,
    task_id: attempt.task_id,
    profile_id: attempt.profile_id,
    user_id: attempt.user_id,
    funding_source_id: attempt.funding_source_id,
    application_identity: attempt.application_identity,
    target_locator_sha256: attempt.target_locator_sha256,
    portal_url: 'https://portal.example.org/confirmation/abc',
    captured_at: '2026-08-05T16:00:10.000Z',
    confirmation_reference: 'APP-8675309',
    reference_kind: 'confirmation',
    received_acknowledgement: true,
    pre_click_page_fingerprint: 'd'.repeat(64),
    post_click_page_fingerprint: 'e'.repeat(64),
    extraction_rule: 'label: Confirmation Number',
    portal_policy_version: `${adapter.id}@${adapter.version}:${adapter.fixture_contract_sha256}`,
    portal_adapter: {
      id: adapter.id,
      version: adapter.version,
      fixture_contract_sha256: adapter.fixture_contract_sha256,
    },
    ...overrides,
  }
}

function artifactOnlyProof(attempt, overrides = {}) {
  const artifactSha256 = '8'.repeat(64)
  const proof = receiptProof(attempt, {
    evidence_type: 'confirmation_pdf',
    confirmation_reference: null,
    reference_kind: null,
    received_acknowledgement: false,
    proof_document_id: 'proof-doc-fabricated',
    artifact_sha256: artifactSha256,
    artifact_manifest_sha256: '9'.repeat(64),
    ...overrides,
  })
  proof.artifact_binding_sha256 = _internal.sha256(_internal.stableJson({
    attempt_id: attempt.id,
    task_id: String(proof.task_id),
    profile_id: attempt.profile_id,
    funding_source_id: attempt.funding_source_id,
    application_identity: attempt.application_identity,
    portal_host: attempt.portal_host,
    target_locator_sha256: attempt.target_locator_sha256,
    artifact_sha256: artifactSha256,
    confirmation_reference: null,
  }))
  return proof
}

function reviewedFixtures(definition) {
  const applicationIdentity = 'fixture-app-123'
  const formObservation = {
    field_contract_sha256: contractSha256(stableContractJson(definition.field_contract)),
    required_answer_keys: definition.field_contract.fields
      .filter((field) => field.required)
      .map((field) => field.answer_key),
  }
  return [
    {
      case: 'new_receipt_success', application_identity: applicationIdentity,
      pre_click_text: 'Review application',
      post_click_text: 'Your application has been received. Confirmation Number: CONF-123456',
      receipt_application_identity: applicationIdentity, receipt_container_count: 1,
      form_observation: formObservation,
    },
    {
      case: 'preexisting_application_id_negative', application_identity: applicationIdentity,
      pre_click_text: 'Application ID: DRAFT-123456',
      post_click_text: 'Application ID: DRAFT-123456',
    },
    {
      case: 'unchanged_spa_negative', application_identity: applicationIdentity,
      pre_click_text: 'Your application has been received. Confirmation Number: CONF-123456',
      post_click_text: 'Your application has been received. Confirmation Number: CONF-123456',
    },
    { case: 'screenshot_only_negative', application_identity: applicationIdentity },
    { case: 'ambiguous_timeout_negative', application_identity: applicationIdentity },
    {
      case: 'unrelated_receipt_negative', application_identity: applicationIdentity,
      receipt_application_identity: 'other-application', receipt_container_count: 1,
      post_click_text: 'Your application has been received. Confirmation Number: CONF-OTHER-123',
    },
    {
      case: 'multiple_application_receipts_negative', application_identity: applicationIdentity,
      receipt_application_identity: applicationIdentity, receipt_container_count: 2,
      post_click_text: 'Your application has been received. Confirmation Number: CONF-MULTI-123',
    },
    {
      case: 'exact_status_absence', application_identity: applicationIdentity,
      status_lookup: {
        application_identity: applicationIdentity,
        outcome: 'absent',
        query_parameter: definition.status_query.query_parameter,
        response_sha256: 'f'.repeat(64),
        path_prefix: definition.status_query.path_prefix,
        container_selector_sha256: contractSha256(definition.status_query.container_selector),
        identity_container_match: true, matching_container_count: 1,
        identity_match_count: 1, status_match_count: 1,
      },
    },
  ]
}

async function onboardFixtureAdapter(db) {
  const result = await onboardReviewedSubmissionAdapter(db, {
    portalHost: SYNTHETIC_REFERENCE_ADAPTER.portal_host,
    definition: SYNTHETIC_REFERENCE_ADAPTER,
    fixtures: reviewedFixtures(SYNTHETIC_REFERENCE_ADAPTER),
    reviewedByUserId: 'operator-1',
    now: NOW,
  })
  expect(result.onboarded, JSON.stringify(result.report?.errors)).toBe(true)
  return result.submission_adapter
}

beforeEach(() => _resetSubmissionAttemptSchemaCache())

describe('Hamilton external-submission attempt fencing', () => {
  it('concurrent duplicate starts converge on one leased attempt', async () => {
    const db = makeDb()
    const [a, b] = await Promise.all([
      createOrClaimSubmissionAttempt(db, claimArgs()),
      createOrClaimSubmissionAttempt(db, claimArgs({ leaseOwner: 'worker-b' })),
    ])

    expect([a.claimed, b.claimed].sort()).toEqual([false, true])
    expect(a.attempt.id).toBe(b.attempt.id)
    expect([a.reason, b.reason]).toContain('active_lease')
    const rows = await db.prepare('SELECT id FROM hamilton_submission_attempts').all()
    expect(rows).toHaveLength(1)
  })

  it('converges the same portal application across different internal funding rows', async () => {
    const db = makeDb()
    const first = await createOrClaimSubmissionAttempt(db, claimArgs())
    const duplicate = await createOrClaimSubmissionAttempt(db, claimArgs({
      taskId: 'task-duplicate-source',
      fundingSourceId: 'opp-alias-row',
      authorizationTargetId: 'opp-alias-row',
      authorizationIds: ['auth-other-row'],
      leaseOwner: 'worker-b',
    }))

    expect(first.claimed).toBe(true)
    expect(duplicate).toMatchObject({ claimed: false, reason: 'snapshot_changed' })
    expect(duplicate.attempt.id).toBe(first.attempt.id)
    expect(await db.prepare('SELECT COUNT(*) AS count FROM hamilton_submission_attempts').get())
      .toMatchObject({ count: 1 })
  })

  it('recovers an expired lease with a new fence and rejects the stale worker', async () => {
    const db = makeDb()
    const first = await createOrClaimSubmissionAttempt(db, claimArgs())
    await db.prepare('UPDATE hamilton_submission_attempts SET lease_expires_at = ? WHERE id = ?')
      .run('2026-08-05T15:59:59.000Z', first.attempt.id)
    const second = await createOrClaimSubmissionAttempt(db, claimArgs({ leaseOwner: 'worker-b' }))

    expect(second.claimed).toBe(true)
    expect(second.reason).toBe('stale_lease_recovered')
    expect(second.attempt.fence_token).not.toBe(first.attempt.fence_token)
    await expect(assertSubmissionAttemptFence(db, {
      attemptId: first.attempt.id,
      fenceToken: first.attempt.fence_token,
      taskId: 'task-1',
      profileId: 'profile-1',
      userId: 'user-1',
      fundingSourceId: 'opp-1',
      portalHost: 'portal.example.org',
      at: NOW,
    })).rejects.toThrow('submission_attempt_fenced')
  })

  it('rejects cross-profile or cross-user fence reuse', async () => {
    const db = makeDb()
    const { attempt } = await createOrClaimSubmissionAttempt(db, claimArgs())
    await expect(assertSubmissionAttemptFence(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      taskId: 'task-1',
      profileId: 'profile-other',
      userId: 'user-1',
      fundingSourceId: 'opp-1',
      portalHost: 'portal.example.org',
      at: NOW,
    })).rejects.toThrow('submission_attempt_profile_id_mismatch')
  })

  it('never permits a second click after submission becomes ambiguous', async () => {
    const db = makeDb()
    const { attempt } = await createOrClaimSubmissionAttempt(db, claimArgs())
    await transitionSubmissionAttempt(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.READY_FOR_FINAL_SUBMIT,
      now: NOW,
    })
    await transitionSubmissionAttempt(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT,
      now: NOW,
    })
    await transitionSubmissionAttempt(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED,
      details: { reason: 'timeout_after_click' },
      now: NOW,
    })

    await expect(transitionSubmissionAttempt(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.READY_FOR_FINAL_SUBMIT,
      now: NOW,
    })).rejects.toThrow('invalid_submission_transition')
    const duplicate = await createOrClaimSubmissionAttempt(db, claimArgs({
      now: new Date('2026-08-05T16:02:00.000Z'),
    }))
    expect(duplicate).toMatchObject({ claimed: false, reason: 'reconciliation_required' })
  })
})

describe('external-receipt proof boundary', () => {
  it('rejects screenshot-only, generic text, URL-only, and mismatched proof', async () => {
    const db = makeDb()
    const { attempt } = await createOrClaimSubmissionAttempt(db, claimArgs())
    const dispatchedAttempt = { ...attempt, submit_dispatched_at: NOW.toISOString() }

    expect(assessExternalReceiptProof(dispatchedAttempt, receiptProof(dispatchedAttempt, {
      evidence_type: 'screenshot',
      confirmation_reference: null,
      proof_document_id: 'doc-shot',
      artifact_sha256: 'b'.repeat(64),
    }), { now: RECEIPT_NOW }).reason).toBe('unsupported_evidence_type')
    expect(assessExternalReceiptProof(dispatchedAttempt, receiptProof(dispatchedAttempt, {
      confirmation_reference: null,
      portal_url: 'https://portal.example.org/status',
    }), { now: RECEIPT_NOW }).reason).toBe('no_durable_external_receipt')
    expect(assessExternalReceiptProof(dispatchedAttempt, receiptProof(dispatchedAttempt, {
      profile_id: 'profile-other',
    }), { now: RECEIPT_NOW }).reason).toBe('proof_profile_id_mismatch')
  })

  it('records only typed portal evidence after the one fenced click', async () => {
    const db = makeDb()
    const submissionAdapter = await onboardFixtureAdapter(db)
    const { attempt } = await createOrClaimSubmissionAttempt(db, claimArgs({
      portalHost: SYNTHETIC_REFERENCE_ADAPTER.portal_host,
      targetUrl: 'https://fixture.hamilton.invalid/apply?applicationId=abc',
      executableTargetUrl: 'https://fixture.hamilton.invalid/apply?applicationId=abc',
      applicationIdentity: 'fixture-app-abc',
      submissionAdapter,
    }))
    await transitionSubmissionAttempt(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.READY_FOR_FINAL_SUBMIT,
      now: NOW,
    })
    await transitionSubmissionAttempt(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT,
      now: NOW,
    })
    const current = await getSubmissionAttempt(db, attempt.id)
    const artifactOnly = await recordExternalReceipt(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      proof: artifactOnlyProof(current, {
        portal_url: 'https://fixture.hamilton.invalid/apply/confirmation',
      }),
      now: RECEIPT_NOW,
    })
    expect(artifactOnly).toMatchObject({
      recorded: false,
      reason: 'durable_artifact_verification_unavailable',
      attempt: { state: HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT },
    })
    expect((await db.prepare('SELECT COUNT(*) AS count FROM hamilton_submission_outbox').get()).count).toBe(0)

    const recorded = await recordExternalReceipt(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      proof: receiptProof(current, {
        portal_url: 'https://fixture.hamilton.invalid/apply/confirmation?token=secret',
      }),
      now: RECEIPT_NOW,
    })

    expect(recorded.recorded, recorded.reason).toBe(true)
    expect(recorded.attempt.state).toBe(HAMILTON_SUBMISSION_LIFECYCLE.EXTERNALLY_RECEIVED)
    expect(recorded.attempt.fence_token).toBeNull()
    expect(recorded.attempt.proof).toMatchObject({
      confirmation_reference: 'APP-8675309',
      proof_policy_version: _internal.PROOF_POLICY_VERSION,
    })
    expect(recorded.attempt.proof.portal_url).toBe('https://fixture.hamilton.invalid/apply')
    expect(JSON.stringify(recorded.attempt)).not.toContain('token=secret')
  })

  it('treats Grants.gov Ready for Submission as unsubmitted and requires tracking evidence', async () => {
    const db = makeDb()
    const { attempt } = await createOrClaimSubmissionAttempt(db, claimArgs({
      portalHost: 'grants.gov',
      targetUrl: 'https://grants.gov/workspace/abc',
      applicationIdentity: 'workspace-abc',
    }))
    const dispatchedAttempt = { ...attempt, submit_dispatched_at: NOW.toISOString() }
    const generic = receiptProof(dispatchedAttempt, {
      portal_url: 'https://grants.gov/workspace/abc/status',
      confirmation_reference: 'READY-123456',
      extraction_rule: 'text: Complete and Notify AOR — Ready for Submission',
    })
    expect(assessExternalReceiptProof(dispatchedAttempt, generic, { now: RECEIPT_NOW }).reason)
      .toBe('grants_gov_tracking_or_confirmation_required')

    const tracked = receiptProof(dispatchedAttempt, {
      evidence_type: 'portal_tracking_number',
      portal_url: 'https://grants.gov/workspace/abc/details',
      confirmation_reference: 'GRANT12345678',
      extraction_rule: 'label: Grants.gov Tracking Number',
    })
    expect(assessExternalReceiptProof(dispatchedAttempt, tracked, { now: RECEIPT_NOW }).verified).toBe(true)
  })
})

describe('revocation and immutable redaction-safe audit', () => {
  it('revocation cancels only the exact user/profile authorization attempts', async () => {
    const db = makeDb()
    const { attempt } = await createOrClaimSubmissionAttempt(db, claimArgs())
    const cancelled = await cancelSubmissionAttemptsForAuthorization(db, {
      authorizationId: 'auth-submit',
      profileId: 'profile-1',
      userId: 'user-1',
      now: NOW,
    })
    expect(cancelled).toEqual([attempt.id])
    expect((await getSubmissionAttempt(db, attempt.id)).state).toBe('cancelled')
    await expect(assertSubmissionAttemptFence(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      taskId: 'task-1', profileId: 'profile-1', userId: 'user-1', fundingSourceId: 'opp-1',
      portalHost: 'portal.example.org', at: NOW,
    })).rejects.toThrow('submission_attempt_fenced')
  })

  it('preserves dispatched work as reconciliation-required and accepts a later genuine receipt', async () => {
    const db = makeDb()
    const submissionAdapter = await onboardFixtureAdapter(db)
    const { attempt } = await createOrClaimSubmissionAttempt(db, claimArgs({
      portalHost: SYNTHETIC_REFERENCE_ADAPTER.portal_host,
      targetUrl: 'https://fixture.hamilton.invalid/apply',
      executableTargetUrl: 'https://fixture.hamilton.invalid/apply?applicationId=late-1',
      applicationIdentity: 'fixture-late-1',
      submissionAdapter,
    }))
    await transitionSubmissionAttempt(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.READY_FOR_FINAL_SUBMIT,
      now: NOW,
    })
    await transitionSubmissionAttempt(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT,
      now: NOW,
    })
    await cancelSubmissionAttemptsForAuthorization(db, {
      authorizationId: 'auth-submit', profileId: 'profile-1', userId: 'user-1', now: RECEIPT_NOW,
    })
    const ambiguous = await getSubmissionAttempt(db, attempt.id)
    expect(ambiguous).toMatchObject({
      state: HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED,
      fence_token: null,
      reconciliation: { consent_revoked: true, no_retry: true },
    })

    const claimed = await claimSubmissionReconciliation(db, {
      attemptId: attempt.id,
      taskId: attempt.task_id,
      profileId: attempt.profile_id,
      userId: attempt.user_id,
      now: RECEIPT_NOW,
    })
    expect(claimed.claimed).toBe(true)
    const receipt = await recordExternalReceipt(db, {
      attemptId: attempt.id,
      fenceToken: claimed.attempt.fence_token,
      fenceGeneration: claimed.attempt.fence_generation,
      proof: receiptProof(claimed.attempt, {
        source: 'portal_response',
        portal_url: 'https://fixture.hamilton.invalid/apply/receipt?resume=secret',
      }),
      now: RECEIPT_NOW,
    })
    expect(receipt.recorded, receipt.reason).toBe(true)
    expect(receipt.attempt.state).toBe(HAMILTON_SUBMISSION_LIFECYCLE.EXTERNALLY_RECEIVED)
  })

  it('quarantines malformed immutable arrays instead of authorizing through coerced JSON', async () => {
    const db = makeDb()
    const { attempt } = await createOrClaimSubmissionAttempt(db, claimArgs())
    const raw = await db.prepare('SELECT * FROM hamilton_submission_attempts WHERE id = ?').get(attempt.id)
    const postgresLike = normalizeSubmissionAttemptRow({
      ...raw,
      task_references_json: {},
      authorization_ids_json: ['auth-submit'],
      document_ids_json: ['doc-1', 42],
    })
    expect(postgresLike).toMatchObject({
      integrity_valid: false,
      integrity_quarantined: true,
      task_references: [],
      document_ids: [],
    })

    await db.prepare(
      `UPDATE hamilton_submission_attempts
          SET task_references_json = '{}', authorization_ids_json = '{}', document_ids_json = '[42]'
        WHERE id = ?`,
    ).run(attempt.id)
    const malformed = await getSubmissionAttempt(db, attempt.id)
    expect(malformed.integrity_valid).toBe(false)
    expect(malformed.authorization_ids).toEqual([])
    await expect(assertSubmissionAttemptFence(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      taskId: 'task-1', profileId: 'profile-1', userId: 'user-1', fundingSourceId: 'opp-1',
      portalHost: 'portal.example.org', at: NOW,
    })).rejects.toThrow('submission_attempt_integrity_quarantined')

    await cancelSubmissionAttemptsForAuthorization(db, {
      authorizationId: 'auth-submit', profileId: 'profile-1', userId: 'user-1', now: NOW,
    })
    const quarantined = await db.prepare(
      'SELECT state, reconciliation_json, fence_token FROM hamilton_submission_attempts WHERE id = ?',
    ).get(attempt.id)
    expect(quarantined.state).toBe(HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED)
    expect(quarantined.fence_token).toBeNull()
    expect(JSON.parse(quarantined.reconciliation_json)).toMatchObject({
      outcome: 'integrity_quarantined', no_retry: true,
    })
  })

  it('redacts secret-shaped audit details and hash-chains events', async () => {
    const db = makeDb()
    const { attempt } = await createOrClaimSubmissionAttempt(db, claimArgs())
    await transitionSubmissionAttempt(db, {
      attemptId: attempt.id,
      fenceToken: attempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.HUMAN_ACTION_REQUIRED,
      humanActionKind: 'mfa',
      details: { password: 'canary-password', one_time_token: '123456', safe: 'login required' },
      now: NOW,
    })
    const events = await listSubmissionAuditEvents(db, { attemptId: attempt.id })
    expect(events).toHaveLength(2)
    expect(events[1].details).toMatchObject({
      password: '[redacted]',
      one_time_token: '[redacted]',
      safe: 'login required',
    })
    expect(events[1].previous_event_hash).toBe(events[0].event_hash)
    const unhashedBody = _internal.stableJson({
      attempt_id: events[1].attempt_id,
      task_id: events[1].task_id,
      profile_id: events[1].profile_id,
      user_id: events[1].user_id,
      from_state: events[1].from_state,
      to_state: events[1].to_state,
      event_type: events[1].event_type,
      details: events[1].details,
      created_at: events[1].created_at,
    })
    expect(events[1].event_hash).not.toBe(
      _internal.sha256(`${events[1].previous_event_hash}\n${unhashedBody}`),
    )
    expect(JSON.stringify(events)).not.toContain('canary-password')
    expect(JSON.stringify(events)).not.toContain('123456')
  })

  it('owns equivalent SQLite and PostgreSQL migration contracts', () => {
    const sqlite = fs.readFileSync('backend/db/migrations/163_hamilton_submission_attempts.sql', 'utf8')
    const postgres = fs.readFileSync('backend/db/postgres/migrations/0167_hamilton_submission_attempts.sql', 'utf8')
    for (const sql of [sqlite, postgres]) {
      expect(sql).toMatch(/idempotency_key TEXT NOT NULL UNIQUE/i)
      expect(sql).toMatch(/fence_token TEXT/i)
      expect(sql).toMatch(/consent_snapshot_hash TEXT NOT NULL/i)
      expect(sql).toMatch(/answer_snapshot_hash TEXT NOT NULL/i)
      expect(sql).toMatch(/hamilton_submission_audit_events/i)
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS hamilton_submission_adapter_validations/i)
      for (const column of [
        'fixture_contract_sha256', 'validation_version', 'validation_environment',
        'execution_run_id', 'evidence_manifest_sha256', 'reviewer_user_id',
        'validated_at', 'expires_at', 'revoked_at',
      ]) expect(sql).toMatch(new RegExp(`\\b${column}\\b`, 'i'))
    }
  })

  it('applies the canonical SQLite migration twice on a fresh schema with adapter-validation parity', () => {
    const raw = new Database(':memory:')
    const sql = fs.readFileSync('backend/db/migrations/163_hamilton_submission_attempts.sql', 'utf8')
    expect(() => raw.exec(sql)).not.toThrow()
    expect(() => raw.exec(sql)).not.toThrow()
    const tables = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all().map((row) => row.name)
    expect(tables).toEqual(expect.arrayContaining([
      'hamilton_submission_attempts',
      'hamilton_submission_audit_events',
      'hamilton_submission_outbox',
      'hamilton_submission_task_projections',
      'hamilton_submission_adapter_validations',
    ]))
    const columns = raw.prepare('PRAGMA table_info(hamilton_submission_adapter_validations)')
      .all().map((row) => row.name)
    expect(columns).toEqual(expect.arrayContaining([
      'portal_host', 'adapter_id', 'adapter_version', 'fixture_contract_sha256',
      'validation_version', 'validation_environment', 'execution_run_id',
      'evidence_manifest_sha256', 'reviewer_user_id', 'validated_at', 'expires_at',
      'revoked_at',
    ]))
    raw.close()
  })
})
