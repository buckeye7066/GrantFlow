import crypto from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  _resetSubmissionAttemptSchemaCache,
  createOrClaimSubmissionAttempt,
  getSubmissionAttempt,
  listSubmissionAttemptsNeedingReconciliation,
  recoverExpiredSubmissionInflightAttempts,
  transitionSubmissionAttempt,
} from '../services/hamilton/hamiltonSubmissionAttemptStore.js'
import {
  _internal as reconciliationInternal,
  drainHamiltonSubmissionReconciliations,
  reconcileHamiltonSubmissionAttempt,
} from '../services/hamilton/hamiltonSubmissionReconciler.js'
import {
  onboardReviewedSubmissionAdapter,
  SYNTHETIC_REFERENCE_ADAPTER,
} from '../services/hamilton/hamiltonSubmissionAdapterRegistry.js'
import { _resetPortalPolicySchemaCache } from '../services/hamilton/hamiltonPortalPolicyRegistry.js'
import { contractSha256, stableContractJson } from '../../shared/irreversibleActionContract.js'
import { HAMILTON_SUBMISSION_LIFECYCLE } from '../../shared/hamiltonSubmissionContract.js'

const T0 = new Date('2026-08-05T19:00:00.000Z')
const T1 = new Date('2026-08-05T19:00:10.000Z')

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function makeDb() {
  _resetSubmissionAttemptSchemaCache()
  _resetPortalPolicySchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

function fixtures(definition) {
  const applicationIdentity = 'fixture-app-123'
  const successText = 'Your application has been received. Confirmation Number: CONF-123456'
  return [
    {
      case: 'new_receipt_success', application_identity: applicationIdentity,
      pre_click_text: 'Review application', post_click_text: successText,
      receipt_application_identity: applicationIdentity, receipt_container_count: 1,
      form_observation: {
        field_contract_sha256: contractSha256(stableContractJson(definition.field_contract)),
        required_answer_keys: definition.field_contract.fields.filter((field) => field.required).map((field) => field.answer_key),
      },
    },
    { case: 'preexisting_application_id_negative', application_identity: applicationIdentity, pre_click_text: 'Application ID: DRAFT-123456', post_click_text: 'Application ID: DRAFT-123456' },
    { case: 'unchanged_spa_negative', application_identity: applicationIdentity, pre_click_text: successText, post_click_text: successText },
    { case: 'screenshot_only_negative', application_identity: applicationIdentity },
    { case: 'ambiguous_timeout_negative', application_identity: applicationIdentity },
    { case: 'unrelated_receipt_negative', application_identity: applicationIdentity, receipt_application_identity: 'other-app', receipt_container_count: 1, post_click_text: successText },
    { case: 'multiple_application_receipts_negative', application_identity: applicationIdentity, receipt_application_identity: applicationIdentity, receipt_container_count: 2, post_click_text: successText },
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

async function seedAmbiguousAttempt(db, {
  taskId = 'task-1',
  applicationId = 'APP-123',
  stopAtInFlight = false,
  leaseMs,
} = {}) {
  const onboarded = await onboardReviewedSubmissionAdapter(db, {
    portalHost: SYNTHETIC_REFERENCE_ADAPTER.portal_host,
    definition: SYNTHETIC_REFERENCE_ADAPTER,
    fixtures: fixtures(SYNTHETIC_REFERENCE_ADAPTER),
    reviewedByUserId: 'operator-1', now: T0,
  })
  expect(onboarded.onboarded, JSON.stringify(onboarded.report?.errors)).toBe(true)
  const targetUrl = `https://fixture.hamilton.invalid/apply?applicationId=${applicationId}&resume=secret`
  const applicationIdentity = `v2:portal-application:fixture.hamilton.invalid:${digest(applicationId)}`
  const claim = await createOrClaimSubmissionAttempt(db, {
    taskId, profileId: 'profile-1', userId: 'user-1',
    fundingSourceId: 'funding_opportunity:opp-1', authorizationTargetId: 'opp-1',
    portalHost: SYNTHETIC_REFERENCE_ADAPTER.portal_host,
    targetUrl, executableTargetUrl: targetUrl, applicationIdentity,
    authorizationVersion: 'hamilton-external-submit-v2', authorizationIds: ['auth-session', 'auth-submit'],
    consentSnapshot: { version: 'hamilton-external-submit-v2', submit: true },
    answerSnapshotHash: 'a'.repeat(64), submissionAdapter: onboarded.submission_adapter,
    now: T0, leaseMs,
  })
  await transitionSubmissionAttempt(db, {
    attemptId: claim.attempt.id, fenceToken: claim.attempt.fence_token,
    toState: HAMILTON_SUBMISSION_LIFECYCLE.READY_FOR_FINAL_SUBMIT, now: T0,
  })
  await transitionSubmissionAttempt(db, {
    attemptId: claim.attempt.id, fenceToken: claim.attempt.fence_token,
    toState: HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT, now: T0,
  })
  if (stopAtInFlight) return getSubmissionAttempt(db, claim.attempt.id)
  await transitionSubmissionAttempt(db, {
    attemptId: claim.attempt.id, fenceToken: claim.attempt.fence_token,
    toState: HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED,
    details: { reason: 'timeout_after_dispatch' }, now: T0, releaseLease: true,
  })
  return getSubmissionAttempt(db, claim.attempt.id)
}

function makeStatusContainerLocator(statusRows) {
  return {
    count: async () => statusRows.length,
    evaluateAll: async (fn, contract) => fn(statusRows.map((row) => ({
      querySelectorAll(selector) {
        if (selector === '[data-fixture-application-id]') {
          const count = row.applicationId === null || row.applicationId === undefined
            ? 0 : Number(row.identityCount ?? 1)
          return Array.from({ length: count }, () => ({
            getAttribute: () => row.applicationId,
          }))
        }
        if (selector === '[data-fixture-status]') {
          const count = row.statusText === null || row.statusText === undefined
            ? 0 : Number(row.statusCount ?? 1)
          return Array.from({ length: count }, () => ({ textContent: row.statusText || '' }))
        }
        return []
      },
    })), contract),
    nth: (index) => {
      const row = statusRows[index] || {}
      return {
        locator: (selector) => {
          if (selector === '[data-fixture-application-id]') {
            return {
              count: async () => row.applicationId === null ? 0 : Number(row.identityCount ?? 1),
              first() { return this },
              getAttribute: async () => row.applicationId,
            }
          }
          if (selector === '[data-fixture-status]') {
            return {
              count: async () => row.statusText === null ? 0 : Number(row.statusCount ?? 1),
              first() { return this },
              textContent: async () => row.statusText || '',
            }
          }
          return { count: async () => 0, first() { return this } }
        },
      }
    },
  }
}

function makeReceiptContainerLocator(receiptRows, tracker = { nthCalls: 0 }) {
  return {
    count: async () => receiptRows.length,
    evaluateAll: async (fn, contract) => fn(receiptRows.map((row) => ({
      innerText: row.text || '',
      textContent: row.text || '',
      querySelectorAll(selector) {
        if (selector !== '[data-fixture-receipt-application-id]') return []
        const count = row.applicationId === null || row.applicationId === undefined
          ? 0
          : Number(row.identityCount ?? 1)
        return Array.from({ length: count }, () => ({
          getAttribute: () => row.applicationId,
        }))
      },
    })), contract),
    // This deliberately models the unsafe legacy path: if production ever
    // returns to nth() re-resolution, tests observe the call and the row can be
    // replaced between identity and receipt reads.
    nth: (index) => {
      tracker.nthCalls += 1
      const row = receiptRows[index] || {}
      return {
        locator: () => ({
          count: async () => row.applicationId === null ? 0 : 1,
          first() { return this },
          getAttribute: async () => row.applicationId,
        }),
        innerText: async () => row.unsafeReResolvedText || row.text || '',
      }
    },
  }
}

function fakeBrowser({
  targetUrl,
  applicationId,
  statusText,
  statusRows = null,
  bodyText,
  receiptRows = null,
  receiptTracker = { nthCalls: 0 },
}) {
  const exactStatusRows = statusRows || [{ applicationId, statusText }]
  const exactReceiptRows = receiptRows || (/confirmation\s+number/i.test(bodyText || '')
    ? [{ applicationId, text: bodyText }]
    : [])
  const locatorFor = (selector) => {
    if (selector === '[data-fixture-status-row]') return makeStatusContainerLocator(exactStatusRows)
    if (selector === '[data-fixture-application-id]') {
      return {
        count: async () => 1,
        first() { return this },
        getAttribute: async () => applicationId,
      }
    }
    if (selector === '[data-fixture-status]') {
      return {
        count: async () => statusText === null ? 0 : 1,
        first() { return this },
        textContent: async () => statusText || '',
      }
    }
    if (selector === '[data-fixture-receipt-row]') {
      return makeReceiptContainerLocator(exactReceiptRows, receiptTracker)
    }
    if (selector === 'body') return { innerText: async () => bodyText || '' }
    return { count: async () => 0, first() { return this } }
  }
  const page = {
    goto: async (url) => { expect(url).toBe(targetUrl) },
    waitForLoadState: async () => {},
    url: () => targetUrl,
    locator: locatorFor,
  }
  const browser = {
    newContext: async () => ({ route: async () => {}, newPage: async () => page }),
    close: async () => {},
  }
  return async () => ({ browser })
}

function reconciliationIo({
  targetUrl,
  applicationId,
  statusText,
  statusRows = null,
  bodyText,
  receiptRows = null,
  receiptTracker = { nthCalls: 0 },
  clock = () => T1,
}) {
  return {
    clock,
    chromiumOverride: {},
    hasSessionAuthorization: async () => true,
    findSession: async () => ({ id: 'session-1', has_storage_state: true }),
    loadStorageState: async () => ({ cookies: [], origins: [] }),
    launchBrowser: fakeBrowser({
      targetUrl, applicationId, statusText, statusRows, bodyText, receiptRows, receiptTracker,
    }),
    prepareBrowserEgress: async () => ({
      target_origin: 'https://fixture.hamilton.invalid',
      allowed_origins: ['https://fixture.hamilton.invalid'],
      pinned_hosts: { 'fixture.hamilton.invalid': '203.0.113.10' },
      path_contract: {
        navigation: ['/apply', '/login'],
        application: ['/apply'],
        authentication: ['/login'],
        status: ['/apply'],
        interactive: [],
      },
      extra_args: ['--host-resolver-rules=MAP fixture.hamilton.invalid 203.0.113.10'],
      context_options: { serviceWorkers: 'block' },
    }),
    installNetworkGuard: async () => {},
  }
}

beforeEach(() => {
  _resetSubmissionAttemptSchemaCache()
  _resetPortalPolicySchemaCache()
})

describe('Hamilton exact-application reconciliation', () => {
  it('requires identity and status in one exact application container on the reviewed status path', async () => {
    const query = { key: 'applicationId', value: 'APP-TARGET' }
    const pageFor = (rows, url = 'https://fixture.hamilton.invalid/apply?applicationId=APP-TARGET') => ({
      url: () => url,
      locator: (selector) => selector === '[data-fixture-status-row]'
        ? makeStatusContainerLocator(rows)
        : { count: async () => 0, first() { return this } },
    })

    const wrongRow = await reconciliationInternal.readExactStatus(pageFor([
      { applicationId: 'APP-OTHER', statusText: 'received' },
    ]), SYNTHETIC_REFERENCE_ADAPTER, query)
    expect(wrongRow).toMatchObject({ outcome: 'inconclusive', reason: 'status_application_identity_mismatch' })

    const duplicateRows = await reconciliationInternal.readExactStatus(pageFor([
      { applicationId: 'APP-TARGET', statusText: 'received' },
      { applicationId: 'APP-TARGET', statusText: 'not found' },
    ]), SYNTHETIC_REFERENCE_ADAPTER, query)
    expect(duplicateRows).toMatchObject({ outcome: 'inconclusive', reason: 'status_application_identity_ambiguous' })

    const splitContainers = await reconciliationInternal.readExactStatus(pageFor([
      { applicationId: 'APP-TARGET', statusText: null },
      { applicationId: 'APP-OTHER', statusText: 'received' },
    ]), SYNTHETIC_REFERENCE_ADAPTER, query)
    expect(splitContainers).toMatchObject({ outcome: 'inconclusive', reason: 'status_contract_ambiguous' })

    const statusPathAdapter = {
      ...SYNTHETIC_REFERENCE_ADAPTER,
      allowed_path_prefixes: ['/apply', '/status'],
      status_query: { ...SYNTHETIC_REFERENCE_ADAPTER.status_query, path_prefix: '/status' },
    }
    const wrongPath = await reconciliationInternal.readExactStatus(pageFor([
      { applicationId: 'APP-TARGET', statusText: 'received' },
    ]), statusPathAdapter, query)
    expect(wrongPath).toMatchObject({ outcome: 'inconclusive', reason: 'status_path_changed' })
  })

  it('takes one atomic container snapshot so a dynamic row replacement cannot splice identity and status', async () => {
    let nthCalls = 0
    const statusLocator = {
      // If the implementation re-resolves by index after reading identity, the
      // portal swaps the row under that index to an unrelated received record.
      nth: () => {
        nthCalls += 1
        return {
          locator: () => ({
            count: async () => 1,
            first() { return this },
            getAttribute: async () => 'APP-TARGET',
            textContent: async () => 'received',
          }),
        }
      },
      evaluateAll: async () => ({
        container_count: 2,
        // The single browser-task snapshot sees the replacement/duplicate and
        // therefore refuses to bind either status to the target.
        matching_containers: [
          { identity_match_count: 1, status_match_count: 1, status_text: 'received' },
          { identity_match_count: 1, status_match_count: 1, status_text: 'not found' },
        ],
      }),
    }
    const page = {
      url: () => 'https://fixture.hamilton.invalid/apply?applicationId=APP-TARGET',
      locator: (selector) => selector === '[data-fixture-status-row]'
        ? statusLocator
        : { count: async () => 0 },
    }
    const result = await reconciliationInternal.readExactStatus(
      page,
      SYNTHETIC_REFERENCE_ADAPTER,
      { key: 'applicationId', value: 'APP-TARGET' },
    )
    expect(result).toMatchObject({
      outcome: 'inconclusive', reason: 'status_application_identity_ambiguous',
    })
    expect(nthCalls).toBe(0)
  })

  it.each([
    ['is unavailable', { count: async () => 1 }, 'status_atomic_snapshot_unavailable'],
    ['fails in the browser task', {
      count: async () => 1,
      evaluateAll: async () => { throw new Error('synthetic DOM snapshot failure') },
    }, 'status_atomic_snapshot_failed'],
  ])('fails closed when the atomic status snapshot %s', async (_label, locator, reason) => {
    const page = {
      url: () => 'https://fixture.hamilton.invalid/apply?applicationId=APP-TARGET',
      locator: () => locator,
    }
    await expect(reconciliationInternal.readExactStatus(
      page,
      SYNTHETIC_REFERENCE_ADAPTER,
      { key: 'applicationId', value: 'APP-TARGET' },
    )).resolves.toMatchObject({ outcome: 'inconclusive', reason })
  })

  it('rejects excessive status containers inside the atomic browser task', async () => {
    const page = {
      url: () => 'https://fixture.hamilton.invalid/apply?applicationId=APP-TARGET',
      locator: () => makeStatusContainerLocator(Array.from({ length: 101 }, (_, index) => ({
        applicationId: index === 0 ? 'APP-TARGET' : `APP-${index}`,
        statusText: 'received',
      }))),
    }
    await expect(reconciliationInternal.readExactStatus(
      page,
      SYNTHETIC_REFERENCE_ADAPTER,
      { key: 'applicationId', value: 'APP-TARGET' },
    )).resolves.toMatchObject({
      outcome: 'inconclusive', reason: 'status_container_missing_or_excessive',
    })
  })

  it.each([
    ['oversized', 'received'.padEnd(1_025, 'x'), 'status_value_oversized'],
    ['control-bearing', 'received\u0000', 'status_value_unsafe'],
  ])('rejects %s status evidence inside the identity-bound container', async (_label, statusText, reason) => {
    const page = {
      url: () => 'https://fixture.hamilton.invalid/apply?applicationId=APP-TARGET',
      locator: () => makeStatusContainerLocator([
        { applicationId: 'APP-TARGET', statusText },
      ]),
    }
    await expect(reconciliationInternal.readExactStatus(
      page,
      SYNTHETIC_REFERENCE_ADAPTER,
      { key: 'applicationId', value: 'APP-TARGET' },
    )).resolves.toMatchObject({ outcome: 'inconclusive', reason })
  })

  it('sweeps an expired committed dispatch into reconciliation without a duplicate task or second click', async () => {
    const db = makeDb()
    const inFlight = await seedAmbiguousAttempt(db, {
      taskId: 'task-crashed-worker',
      applicationId: 'APP-CRASHED-1',
      stopAtInFlight: true,
      leaseMs: 10_000,
    })
    expect(inFlight.state).toBe(HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT)
    expect(inFlight.submit_dispatched_at).toBe(T0.toISOString())

    const early = await recoverExpiredSubmissionInflightAttempts(db, {
      now: new Date(T0.getTime() + 9_999),
    })
    expect(early).toEqual([])

    const seen = []
    const summary = await drainHamiltonSubmissionReconciliations(db, {
      now: T1,
      reconcileAttempt: async (_db, attempt) => {
        seen.push(attempt)
        return { reconciled: false, reason: 'synthetic_no_browser' }
      },
    })
    expect(summary.recovered_in_flight).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      id: inFlight.id,
      state: HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED,
      submit_dispatched_at: T0.toISOString(),
    })
    expect(seen[0].reconciliation).toMatchObject({ no_retry: true })

    // A concurrent/later sweeper cannot recover or audit the row twice.
    expect(await recoverExpiredSubmissionInflightAttempts(db, { now: T1 })).toEqual([])
    const audits = await db.prepare(
      `SELECT event_type FROM hamilton_submission_audit_events
        WHERE attempt_id = ? AND event_type = 'in_flight_worker_expired_to_reconciliation'`,
    ).all(inFlight.id)
    expect(audits).toHaveLength(1)
  })

  it('promotes a selector-bound received status plus typed receipt without a second click', async () => {
    const db = makeDb()
    const applicationId = 'APP-RECEIVED-1'
    const attempt = await seedAmbiguousAttempt(db, { applicationId })
    const exactTarget = `https://fixture.hamilton.invalid/apply?applicationId=${applicationId}&resume=secret`
    const result = await reconcileHamiltonSubmissionAttempt(db, attempt, reconciliationIo({
      targetUrl: exactTarget,
      applicationId,
      statusText: 'received',
      bodyText: 'Your application has been received. Confirmation Number: CONF-998877',
    }))
    expect(result).toMatchObject({ reconciled: true, outcome: 'received' })
    const current = await getSubmissionAttempt(db, attempt.id)
    expect(current.state).toBe(HAMILTON_SUBMISSION_LIFECYCLE.EXTERNALLY_RECEIVED)
    expect(current.proof.portal_url).toBe('https://fixture.hamilton.invalid/apply')
    expect(JSON.stringify(current)).not.toContain('resume=secret')
  })

  it.each([
    ['wrong application row', (applicationId) => [
      { applicationId: 'APP-OTHER', text: 'Application received. Confirmation Number: CONF-OTHER01' },
    ]],
    ['duplicate target rows', (applicationId) => [
      { applicationId, text: 'Application received. Confirmation Number: CONF-FIRST1' },
      { applicationId, text: 'Application received. Confirmation Number: CONF-SECOND2' },
    ]],
    ['identity and receipt split across rows', (applicationId) => [
      { applicationId, text: 'Review application' },
      { applicationId: 'APP-OTHER', text: 'Application received. Confirmation Number: CONF-OTHER01' },
    ]],
  ])('keeps a received status in reconciliation when receipt proof is bound to the %s', async (_label, rowsFor) => {
    const db = makeDb()
    const applicationId = `APP-RECEIPT-NEG-${_label.replace(/\W+/g, '-').toUpperCase()}`
    const attempt = await seedAmbiguousAttempt(db, {
      taskId: `task-${applicationId}`,
      applicationId,
    })
    const result = await reconcileHamiltonSubmissionAttempt(db, attempt, reconciliationIo({
      targetUrl: `https://fixture.hamilton.invalid/apply?applicationId=${applicationId}&resume=secret`,
      applicationId,
      statusText: 'received',
      receiptRows: rowsFor(applicationId),
      bodyText: 'dashboard',
    }))
    expect(result).toMatchObject({ reconciled: true, outcome: 'inconclusive' })
    const current = await getSubmissionAttempt(db, attempt.id)
    expect(current.state).toBe(HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED)
    expect(current.external_received_at).toBeNull()
  })

  it('uses one atomic receipt snapshot during reconciliation so dynamic row replacement cannot create proof', async () => {
    const db = makeDb()
    const applicationId = 'APP-RECEIPT-TOCTOU'
    const attempt = await seedAmbiguousAttempt(db, {
      taskId: 'task-receipt-toctou', applicationId,
    })
    const receiptTracker = { nthCalls: 0 }
    const result = await reconcileHamiltonSubmissionAttempt(db, attempt, reconciliationIo({
      targetUrl: `https://fixture.hamilton.invalid/apply?applicationId=${applicationId}&resume=secret`,
      applicationId,
      statusText: 'received',
      bodyText: 'dashboard',
      receiptTracker,
      receiptRows: [
        {
          applicationId,
          text: 'Review application',
          unsafeReResolvedText: 'Application received. Confirmation Number: CONF-SPLICED1',
        },
        { applicationId: 'APP-OTHER', text: 'Application received. Confirmation Number: CONF-OTHER01' },
      ],
    }))
    expect(result).toMatchObject({ reconciled: true, outcome: 'inconclusive' })
    expect(receiptTracker.nthCalls).toBe(0)
    const current = await getSubmissionAttempt(db, attempt.id)
    expect(current.state).toBe(HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED)
  })

  it('records exact browser absence for manual review without re-arming, while login/error/unknown DOM stays inconclusive', async () => {
    const db = makeDb()
    const absentId = 'APP-ABSENT-1'
    const absent = await seedAmbiguousAttempt(db, { taskId: 'task-absent', applicationId: absentId })
    const absentResult = await reconcileHamiltonSubmissionAttempt(db, absent, reconciliationIo({
      targetUrl: `https://fixture.hamilton.invalid/apply?applicationId=${absentId}&resume=secret`,
      applicationId: absentId, statusText: 'not found', bodyText: 'No application found',
    }))
    expect(absentResult).toMatchObject({ reconciled: true, outcome: 'absent' })
    const absentCurrent = await getSubmissionAttempt(db, absent.id)
    expect(absentCurrent.state).toBe(HAMILTON_SUBMISSION_LIFECYCLE.HUMAN_ACTION_REQUIRED)
    expect(absentCurrent.human_action_kind).toBe('final_review_submit')
    expect(absentCurrent.submit_dispatched_at).toBeTruthy()
    expect(absentCurrent.reconciliation.no_retry).toBe(true)

    const unknownId = 'APP-UNKNOWN-1'
    const unknown = await seedAmbiguousAttempt(db, { taskId: 'task-unknown', applicationId: unknownId })
    const unknownResult = await reconcileHamiltonSubmissionAttempt(db, unknown, reconciliationIo({
      targetUrl: `https://fixture.hamilton.invalid/apply?applicationId=${unknownId}&resume=secret`,
      applicationId: unknownId, statusText: null, bodyText: 'Sign in again',
    }))
    expect(unknownResult).toMatchObject({ reconciled: true, outcome: 'inconclusive' })
    const stillAmbiguous = await getSubmissionAttempt(db, unknown.id)
    expect(stillAmbiguous.state).toBe(HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED)
    expect(stillAmbiguous.next_reconcile_at).not.toBeNull()
  })

  it('does not manufacture a future observation timestamp when the dispatch clock is ahead', async () => {
    const db = makeDb()
    const applicationId = 'APP-SKEW-1'
    const attempt = await seedAmbiguousAttempt(db, { applicationId })
    const result = await reconcileHamiltonSubmissionAttempt(db, attempt, reconciliationIo({
      targetUrl: `https://fixture.hamilton.invalid/apply?applicationId=${applicationId}&resume=secret`,
      applicationId, statusText: 'received',
      bodyText: 'Your application has been received. Confirmation Number: CONF-998877',
      clock: () => T0,
    }))
    expect(result).toMatchObject({ reconciled: true, outcome: 'inconclusive', reason: 'clock_skew' })
    const current = await getSubmissionAttempt(db, attempt.id)
    expect(current.state).toBe(HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED)
    expect(current.external_received_at).toBeNull()
  })

  it('filters live/not-due oldest rows so a bounded queue can reach later due work', async () => {
    const db = makeDb()
    const dueIds = []
    for (let index = 0; index < 12; index += 1) {
      const applicationId = `APP-QUEUE-${index}`
      const attempt = await seedAmbiguousAttempt(db, { taskId: `task-${index}`, applicationId })
      if (index < 10) {
        await db.prepare(
          `UPDATE hamilton_submission_attempts SET next_reconcile_at = ? WHERE id = ?`,
        ).run('2026-08-06T19:00:00.000Z', attempt.id)
      } else {
        dueIds.push(attempt.id)
      }
    }
    const due = await listSubmissionAttemptsNeedingReconciliation(db, { limit: 2, now: T1 })
    expect(due.map((attempt) => attempt.id).sort()).toEqual(dueIds.sort())
  })
})
