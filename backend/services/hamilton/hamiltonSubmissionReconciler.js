/** Read-only reconciliation for ambiguous Hamilton portal submissions. */
import crypto from 'node:crypto'
import { launchGuardedPortalBrowser, launchPortalBrowser, REALISTIC_PORTAL_UA } from './browserLaunch.js'
import { findValidSession, getSessionStorageState } from './hamiltonCredentialSessionService.js'
import { isAuthorizationActive } from './hamiltonAuthorizationStore.js'
import { getPolicyFor, getReviewedSubmissionAdapter } from './hamiltonPortalPolicyRegistry.js'
import { adapterAllowsUrl, extractIdentityBoundAdapterReceipt } from './hamiltonSubmissionAdapterExecutor.js'
import {
  assertHamiltonLivePageAllowed,
  installHamiltonBrowserNetworkGuard,
  navigateHamiltonPortalPage,
  prepareHamiltonBrowserEgress,
} from './hamiltonBrowserNetworkGuard.js'
import {
  buildReconciliationResponseBinding,
  buildReconciliationResponseDigest,
  buildReconciliationStatusArtifactHash,
  claimSubmissionReconciliation,
  getSubmissionAttemptExecutableTarget,
  listSubmissionAttemptsNeedingReconciliation,
  recoverExpiredSubmissionInflightAttempts,
  recordReconciliationObservation,
  releaseSubmissionReconciliationLease,
} from './hamiltonSubmissionAttemptStore.js'
import { HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION } from '../../../shared/hamiltonSubmissionContract.js'

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex')
}

const STATUS_TEXT_LIMIT = 1_024

function hasUnsafeStatusControl(value) {
  for (const character of String(value ?? '')) {
    const code = character.charCodeAt(0)
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true
  }
  return false
}

function normalizeStatus(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

function exactQueryValue(url, expectedKey) {
  const parsed = new URL(url)
  for (const [key, value] of parsed.searchParams.entries()) {
    if (key.toLowerCase() === String(expectedKey).toLowerCase() && String(value).trim()) {
      return { key, value: String(value) }
    }
  }
  return null
}

function queryIdentityMatches(attempt, query) {
  if (!query) return false
  const kind = ({
    applicationid: 'application',
    workspaceid: 'workspace',
    submissionid: 'submission',
    opportunityid: 'opportunity',
  })[String(query.key || '').toLowerCase().replace(/[_-]/g, '')]
  if (!kind || !attempt?.application_identity?.startsWith(`v2:portal-${kind}:`)) return false
  const digest = sha256(query.value)
  return attempt.application_identity.endsWith(`:${digest}`)
}

function pathMatchesPrefix(pathname, rawPrefix) {
  const path = String(pathname || '/')
  const prefix = String(rawPrefix || '').replace(/\/+$/, '') || '/'
  return prefix !== '/' && (path === prefix || path.startsWith(`${prefix}/`))
}

function statusQueryAllowsUrl(adapter, value) {
  try {
    const parsed = new URL(String(value))
    return parsed.protocol === 'https:'
      && !parsed.username && !parsed.password
      && (!parsed.port || parsed.port === '443')
      && parsed.hostname.toLowerCase() === String(adapter?.portal_host || '').toLowerCase()
      && pathMatchesPrefix(parsed.pathname, adapter?.status_query?.path_prefix)
  } catch { return false }
}

async function readExactStatus(page, adapter, query) {
  if (!adapterAllowsUrl(adapter, page.url()) || !statusQueryAllowsUrl(adapter, page.url())) {
    return { outcome: 'inconclusive', reason: 'status_path_changed' }
  }
  const containers = page.locator(adapter.status_query.container_selector)
  if (typeof containers?.evaluateAll !== 'function') {
    return { outcome: 'inconclusive', reason: 'status_atomic_snapshot_unavailable' }
  }
  let snapshot
  try {
    snapshot = await containers.evaluateAll((nodes, contract) => {
      if (nodes.length < 1 || nodes.length > contract.maxContainerCount) {
        return { container_count: nodes.length, matching_containers: [] }
      }
      const matching = []
      for (const node of nodes) {
        const identities = node.querySelectorAll(contract.identitySelector)
        if (identities.length !== 1) continue
        const identityValue = identities[0].getAttribute(contract.identityAttribute)
        if (String(identityValue || '') !== contract.expectedIdentity) continue
        const statuses = node.querySelectorAll(contract.statusSelector)
        const rawStatus = statuses.length === 1 ? String(statuses[0].textContent || '') : ''
        matching.push({
          identity_match_count: identities.length,
          status_match_count: statuses.length,
          status_text_too_large: rawStatus.length > contract.maxStatusTextLength,
          status_text: rawStatus.length <= contract.maxStatusTextLength ? rawStatus : '',
        })
      }
      return { container_count: nodes.length, matching_containers: matching }
    }, {
      identitySelector: adapter.status_query.identity_selector,
      identityAttribute: adapter.status_query.identity_attribute,
      statusSelector: adapter.status_query.status_selector,
      expectedIdentity: query.value,
      maxStatusTextLength: STATUS_TEXT_LIMIT,
      maxContainerCount: 100,
    })
  } catch {
    return { outcome: 'inconclusive', reason: 'status_atomic_snapshot_failed' }
  }
  const containerCount = Number(snapshot?.container_count || 0)
  if (containerCount < 1 || containerCount > 100) {
    return { outcome: 'inconclusive', reason: 'status_container_missing_or_excessive' }
  }
  const matchingContainers = Array.isArray(snapshot?.matching_containers)
    ? snapshot.matching_containers
    : []
  if (matchingContainers.length === 0) {
    return { outcome: 'inconclusive', reason: 'status_application_identity_mismatch' }
  }
  if (matchingContainers.length !== 1) {
    return { outcome: 'inconclusive', reason: 'status_application_identity_ambiguous' }
  }
  const matched = matchingContainers[0]
  if (Number(matched?.identity_match_count || 0) !== 1
      || Number(matched?.status_match_count || 0) !== 1) {
    return { outcome: 'inconclusive', reason: 'status_contract_ambiguous' }
  }
  if (matched?.status_text_too_large === true) {
    return { outcome: 'inconclusive', reason: 'status_value_oversized' }
  }
  if (hasUnsafeStatusControl(matched?.status_text)) {
    return { outcome: 'inconclusive', reason: 'status_value_unsafe' }
  }
  const statusText = normalizeStatus(matched.status_text)
  if (!statusText) return { outcome: 'inconclusive', reason: 'status_value_missing' }
  const received = adapter.status_query.received_states.map(normalizeStatus).includes(statusText)
  const absent = adapter.status_query.absent_states.map(normalizeStatus).includes(statusText)
  return {
    outcome: received ? 'received' : absent ? 'absent' : 'inconclusive',
    status_sha256: sha256(statusText),
    identity_sha256: sha256(query.value),
  }
}

async function hasCurrentSessionAuthorization(db, attempt) {
  for (const authorizationId of attempt.authorization_ids || []) {
    const active = await isAuthorizationActive(db, {
      userId: attempt.user_id,
      profileId: attempt.profile_id,
      authorizationType: 'use_saved_session',
      fundingSourceId: attempt.authorization_target_id,
      taskId: attempt.task_id,
      expectedVersion: HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION,
      authorizationId,
    })
    if (active) return true
  }
  return false
}

export async function reconcileHamiltonSubmissionAttempt(db, attempt, {
  now = null,
  clock = () => new Date(),
  leaseOwner = `hamilton-reconciler:${process.pid}`,
  chromiumOverride = null,
  hasSessionAuthorization = hasCurrentSessionAuthorization,
  findSession = findValidSession,
  loadStorageState = getSessionStorageState,
  loadPolicy = getPolicyFor,
  resolveReviewedAdapter = getReviewedSubmissionAdapter,
  launchBrowser = launchPortalBrowser,
  prepareBrowserEgress = prepareHamiltonBrowserEgress,
  installNetworkGuard = installHamiltonBrowserNetworkGuard,
  launchGuardedBrowser = launchGuardedPortalBrowser,
} = {}) {
  const startedAt = now ? new Date(now) : new Date(clock())
  if (!attempt || !attempt.integrity_valid || !(await hasSessionAuthorization(db, attempt))) {
    return { reconciled: false, reason: 'saved_session_authorization_inactive' }
  }
  const session = await findSession(db, { profileId: attempt.profile_id, portalHost: attempt.portal_host })
  if (!session?.has_storage_state) return { reconciled: false, reason: 'authenticated_session_unavailable' }
  const claim = await claimSubmissionReconciliation(db, {
    attemptId: attempt.id,
    taskId: attempt.task_id,
    profileId: attempt.profile_id,
    userId: attempt.user_id,
    leaseOwner,
    now: startedAt,
  })
  if (!claim.claimed) return { reconciled: false, reason: claim.reason }
  const current = claim.attempt
  let browser
  try {
    const policy = await loadPolicy(db, current.portal_host)
    const adapter = resolveReviewedAdapter(policy, { portalUrl: current.target_url })
    if (!adapter
        || adapter.id !== current.submission_adapter?.id
        || adapter.version !== current.submission_adapter?.version
        || adapter.fixture_contract_sha256 !== current.submission_adapter?.fixture_contract_sha256) {
      throw new Error('reviewed_reconciliation_adapter_changed')
    }
    const exactTarget = await getSubmissionAttemptExecutableTarget(db, {
      attemptId: current.id,
      fenceToken: current.fence_token,
      profileId: current.profile_id,
      userId: current.user_id,
      taskId: current.task_id,
    })
    const query = exactQueryValue(exactTarget, adapter.status_query.query_parameter)
    if (!queryIdentityMatches(current, query)) throw new Error('exact_application_query_binding_mismatch')
    const browserEgress = await prepareBrowserEgress({ targetUrl: exactTarget, submissionAdapter: adapter })
    const storageState = await loadStorageState(db, session.id)
    let chromium = chromiumOverride
    if (!chromium) ({ chromium } = await import('playwright'))
    const launched = await launchGuardedBrowser(chromium, {
      targetUrl: exactTarget,
      submissionAdapter: adapter,
      headless: true,
      contextOptions: { storageState, userAgent: REALISTIC_PORTAL_UA },
      prepareEgress: async () => browserEgress,
      installGuard: installNetworkGuard,
      launchBrowser,
    })
    browser = launched.browser
    const context = launched.context
    const page = await context.newPage()
    await navigateHamiltonPortalPage(page, exactTarget, browserEgress, {
      waitUntil: 'domcontentloaded', timeout: 25_000,
    })
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => null)
    assertHamiltonLivePageAllowed(page, browserEgress)
    const status = await readExactStatus(page, adapter, query)
    const checkedDate = new Date(clock())
    const dispatchedMs = Date.parse(current.submit_dispatched_at || '')
    if (!Number.isFinite(checkedDate.getTime()) || !Number.isFinite(dispatchedMs)
        || checkedDate.getTime() <= dispatchedMs) {
      await releaseSubmissionReconciliationLease(db, {
        attemptId: current.id,
        fenceToken: current.fence_token,
        fenceGeneration: current.fence_generation,
        reason: 'reconciliation_clock_skew',
        now: Number.isFinite(checkedDate.getTime()) ? checkedDate : startedAt,
      })
      return { reconciled: true, outcome: 'inconclusive', reason: 'clock_skew' }
    }
    const checkedAt = checkedDate.toISOString()
    const baseObservation = {
      outcome: status.outcome,
      source: 'authenticated_portal',
      checked_at: checkedAt,
      query_kind: 'exact_application_status',
      portal_url: page.url(),
      application_identity: current.application_identity,
      status_observation: {
        status_sha256: status.status_sha256 || null,
        identity_sha256: status.identity_sha256 || null,
      },
      observation_id: `internal-observation:${crypto.randomUUID()}`,
      portal_correlation_id: null,
      adapter_id: adapter.id,
      adapter_version: adapter.version,
      fixture_contract_sha256: adapter.fixture_contract_sha256,
    }
    baseObservation.status_artifact_sha256 = buildReconciliationStatusArtifactHash(current, adapter, baseObservation)
    baseObservation.response_sha256 = buildReconciliationResponseDigest(current, baseObservation)
    baseObservation.response_binding_sha256 = buildReconciliationResponseBinding(current, baseObservation)
    if (status.outcome === 'received') {
      const receipt = await extractIdentityBoundAdapterReceipt(page, adapter, query.value)
      if (!receipt?.reference || receipt.received_acknowledgement !== true) {
        baseObservation.outcome = 'inconclusive'
        baseObservation.status_artifact_sha256 = buildReconciliationStatusArtifactHash(current, adapter, baseObservation)
        baseObservation.response_sha256 = buildReconciliationResponseDigest(current, baseObservation)
        baseObservation.response_binding_sha256 = buildReconciliationResponseBinding(current, baseObservation)
      } else {
        baseObservation.proof = {
          evidence_type: receipt.reference_kind === 'tracking' ? 'portal_tracking_number' : 'portal_confirmation_reference',
          source: 'authenticated_portal',
          attempt_id: current.id,
          task_id: current.task_id,
          profile_id: current.profile_id,
          user_id: current.user_id,
          funding_source_id: current.funding_source_id,
          application_identity: current.application_identity,
          target_locator_sha256: current.target_locator_sha256,
          portal_url: page.url(),
          captured_at: checkedAt,
          confirmation_reference: receipt.reference,
          reference_kind: receipt.reference_kind,
          received_acknowledgement: true,
          extraction_rule: receipt.extraction_rule,
          portal_policy_version: `${adapter.id}@${adapter.version}:${adapter.fixture_contract_sha256}`,
          portal_adapter: {
            id: adapter.id,
            version: adapter.version,
            fixture_contract_sha256: adapter.fixture_contract_sha256,
          },
          independent_verification: {
            outcome: 'received',
            source: 'authenticated_portal',
            query_kind: 'exact_application_status',
            checked_at: checkedAt,
            response_sha256: baseObservation.response_sha256,
            status_artifact_sha256: baseObservation.status_artifact_sha256,
            observation_id: baseObservation.observation_id,
            portal_correlation_id: null,
            response_binding_sha256: baseObservation.response_binding_sha256,
          },
        }
      }
    }
    const recorded = await recordReconciliationObservation(db, {
      attemptId: current.id,
      fenceToken: current.fence_token,
      fenceGeneration: current.fence_generation,
      observation: baseObservation,
      now: checkedDate,
    })
    return { reconciled: true, outcome: baseObservation.outcome, attempt: recorded.attempt }
  } catch (error) {
    await releaseSubmissionReconciliationLease(db, {
      attemptId: current.id,
      fenceToken: current.fence_token,
      fenceGeneration: current.fence_generation,
      reason: error?.message || 'reconciliation_failed',
      now: new Date(clock()),
    }).catch(() => {})
    return { reconciled: false, reason: 'reconciliation_deferred' }
  } finally {
    await browser?.close?.().catch(() => {})
  }
}

export async function drainHamiltonSubmissionReconciliations(db, {
  limit = 10,
  now = new Date(),
  reconcileAttempt = reconcileHamiltonSubmissionAttempt,
} = {}) {
  const recovered = await recoverExpiredSubmissionInflightAttempts(db, {
    limit: Math.max(10, Number(limit) * 5),
    now,
  })
  const attempts = await listSubmissionAttemptsNeedingReconciliation(db, { limit, now })
  const summary = {
    recovered_in_flight: recovered.length,
    considered: attempts.length,
    received: 0,
    absent: 0,
    inconclusive: 0,
    deferred: 0,
  }
  for (const attempt of attempts) {
    const result = await reconcileAttempt(db, attempt)
    if (!result.reconciled) summary.deferred += 1
    else if (result.outcome === 'received') summary.received += 1
    else if (result.outcome === 'absent') summary.absent += 1
    else summary.inconclusive += 1
  }
  return summary
}

export function startHamiltonSubmissionReconciler(db, {
  intervalMs = 60_000,
  setIntervalFn = setInterval,
  setTimeoutFn = setTimeout,
  logger = console,
} = {}) {
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try { await drainHamiltonSubmissionReconciliations(db) }
    catch (error) { logger?.warn?.('[hamilton-reconciler] cycle failed:', error?.message || 'reconciliation_failed') }
    finally { running = false }
  }
  const startupTimer = setTimeoutFn(run, 5_000)
  const intervalTimer = setIntervalFn(run, Math.max(15_000, Number(intervalMs) || 60_000))
  return { run, stop: () => { clearTimeout(startupTimer); clearInterval(intervalTimer) } }
}

export const _internal = Object.freeze({
  exactQueryValue, queryIdentityMatches, normalizeStatus, pathMatchesPrefix, statusQueryAllowsUrl, readExactStatus,
})
