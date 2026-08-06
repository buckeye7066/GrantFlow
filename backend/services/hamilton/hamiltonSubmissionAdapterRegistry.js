/**
 * Operator onboarding for portal-specific final-submit adapters.
 *
 * No real host is seeded as reviewed. Schema/fixture validation is only the
 * first gate: a real host also needs an immutable, unexpired sandbox/training
 * execution artifact whose hashes bind the exact adapter definition. Synthetic
 * `.invalid` fixtures exercise the framework but cannot create live real-host
 * coverage.
 */
import {
  contractSha256,
  stableContractJson,
} from '../../../shared/irreversibleActionContract.js'
import { getPolicyFor, listPolicies, upsertPolicy } from './hamiltonPortalPolicyRegistry.js'
import {
  assessAdapterPostClickObservation,
  extractAdapterReceiptFromText,
} from './hamiltonSubmissionAdapterExecutor.js'

export const SUBMISSION_ADAPTER_VALIDATION_VERSION = 'hamilton-adapter-fixtures-v1'
export const SUBMISSION_ADAPTER_OPERATOR_VALIDATION_VERSION = 'hamilton-adapter-operator-validation-v1'

let operatorValidationSchema = new WeakSet()

function isSyntheticFixtureHost(host) {
  return String(host || '').toLowerCase().endsWith('.invalid')
}

async function ensureOperatorValidationSchema(db) {
  if (operatorValidationSchema.has(db)) return
  const isPostgres = db?.dialect === 'postgres'
  const ts = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const now = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_submission_adapter_validations (
      id TEXT PRIMARY KEY,
      portal_host TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      fixture_contract_sha256 TEXT NOT NULL,
      validation_version TEXT NOT NULL,
      validation_environment TEXT NOT NULL,
      execution_run_id TEXT NOT NULL,
      evidence_manifest_sha256 TEXT NOT NULL,
      reviewer_user_id TEXT NOT NULL,
      validated_at ${ts} NOT NULL,
      expires_at ${ts} NOT NULL,
      revoked_at ${ts},
      created_at ${ts} NOT NULL DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_adapter_validation_host
      ON hamilton_submission_adapter_validations(portal_host, adapter_id, adapter_version);
  `)
  operatorValidationSchema.add(db)
}

async function loadLiveOperatorValidation(db, {
  artifactId,
  host,
  definition,
  fixtureContractSha256,
  now,
} = {}) {
  if (!artifactId) return { valid: false, reason: 'live_operator_validation_artifact_required' }
  await ensureOperatorValidationSchema(db)
  const row = await db.prepare(
    'SELECT * FROM hamilton_submission_adapter_validations WHERE id = ? LIMIT 1',
  ).get(String(artifactId))
  if (!row || row.revoked_at) return { valid: false, reason: 'live_operator_validation_artifact_missing_or_revoked' }
  const exact = row.portal_host === host
    && row.adapter_id === String(definition.id)
    && row.adapter_version === String(definition.version)
    && row.fixture_contract_sha256 === String(fixtureContractSha256)
    && row.validation_version === SUBMISSION_ADAPTER_OPERATOR_VALIDATION_VERSION
    && ['sandbox', 'training'].includes(String(row.validation_environment))
    && /^[a-f0-9]{64}$/i.test(String(row.evidence_manifest_sha256 || ''))
    && Boolean(String(row.execution_run_id || '').trim())
    && Boolean(String(row.reviewer_user_id || '').trim())
    && Number.isFinite(Date.parse(row.validated_at))
    && Number.isFinite(Date.parse(row.expires_at))
    && Date.parse(row.expires_at) > new Date(now).getTime()
  if (!exact) return { valid: false, reason: 'live_operator_validation_artifact_mismatch_or_expired' }
  return { valid: true, artifact: row }
}

const REQUIRED_FIXTURE_CASES = Object.freeze([
  'new_receipt_success',
  'preexisting_application_id_negative',
  'unchanged_spa_negative',
  'screenshot_only_negative',
  'ambiguous_timeout_negative',
  'unrelated_receipt_negative',
  'multiple_application_receipts_negative',
  'exact_status_absence',
])

const REVIEWED_ANSWER_KEYS = new Set([
  'first_name', 'last_name', 'full_name', 'email', 'phone', 'address1', 'address2',
  'city', 'state', 'zip', 'country', 'gpa', 'act_score', 'sat_score',
  'household_income', 'household_size', 'fafsa_efc', 'school', 'major',
  'degree_level', 'student_id', 'expected_graduation', 'essay', 'goals',
])
const REVIEWED_CONTROL_TYPES = new Set(['text', 'email', 'tel', 'number', 'date', 'textarea', 'select'])
const REVIEWED_TRANSFORMS = new Set(['identity', 'trim', 'iso_date'])
const REVIEWED_IDENTITY_KINDS = new Set(['application', 'workspace', 'submission'])

function normalizeHost(input) {
  try { return new URL(/^https?:\/\//i.test(String(input)) ? String(input) : `https://${input}`).hostname.toLowerCase() } catch { return null }
}

function validateDefinition(portalHost, definition) {
  const errors = []
  if (!definition || typeof definition !== 'object') return ['definition_required']
  if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(String(definition.id || ''))) errors.push('adapter_id_invalid')
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(String(definition.version || ''))) errors.push('adapter_version_invalid')
  if (definition.mode !== 'typed_receipt_v1') errors.push('mode_must_be_typed_receipt_v1')
  if (!REVIEWED_IDENTITY_KINDS.has(String(definition.application_identity_kind || ''))) {
    errors.push('application_identity_kind_required')
  }
  if (definition.enabled !== true || definition.kill_switch === true) errors.push('adapter_must_be_enabled')
  const portalOrigin = normalizeHost(definition.portal_host)
    ? `https://${normalizeHost(definition.portal_host)}`
    : null
  if (!portalOrigin
      || !Array.isArray(definition.allowed_origins)
      || !definition.allowed_origins.includes(portalOrigin)
      || definition.allowed_origins.some((origin) => {
        try {
          const parsed = new URL(String(origin))
          return parsed.protocol !== 'https:' || Boolean(parsed.username || parsed.password)
            || Boolean(parsed.port && parsed.port !== '443') || parsed.pathname !== '/'
            || Boolean(parsed.search || parsed.hash)
        } catch { return true }
      })) errors.push('exact_https_allowed_origins_required')
  const validBoundedPathPrefix = (path) => {
    const value = String(path || '').replace(/\/+$/, '') || '/'
    return value.startsWith('/') && value !== '/' && !value.includes('?') && !value.includes('#')
  }
  if (!Array.isArray(definition.allowed_path_prefixes) || definition.allowed_path_prefixes.length === 0
      || definition.allowed_path_prefixes.some((path) => !validBoundedPathPrefix(path))) errors.push('allowed_paths_required')
  if (!Array.isArray(definition.auth_path_prefixes)
      || definition.auth_path_prefixes.some((path) => !validBoundedPathPrefix(path))) {
    errors.push('bounded_auth_paths_required')
  }
  if (!definition.submit_control?.selector || !/^[a-f0-9]{64}$/i.test(String(definition.submit_control?.exact_text_sha256 || ''))) {
    errors.push('exact_submit_control_required')
  }
  const fieldContract = definition.field_contract
  if (fieldContract?.version !== 'exact-fields-v1'
      || !Array.isArray(fieldContract?.fields)
      || fieldContract.fields.length === 0) {
    errors.push('exact_field_contract_required')
  } else {
    const identities = new Set()
    for (const field of fieldContract.fields) {
      const identity = `${field?.path_prefix || ''}\n${field?.selector || ''}`
      if (identities.has(identity)) errors.push('field_contract_duplicate_selector')
      identities.add(identity)
      if (!String(field?.path_prefix || '').startsWith('/') || !field?.selector) errors.push('field_contract_selector_invalid')
      if (!REVIEWED_ANSWER_KEYS.has(String(field?.answer_key || ''))) errors.push('field_contract_answer_key_invalid')
      if (!REVIEWED_CONTROL_TYPES.has(String(field?.control_type || ''))) errors.push('field_contract_control_type_invalid')
      if (!REVIEWED_TRANSFORMS.has(String(field?.transform || ''))) errors.push('field_contract_transform_invalid')
      if (typeof field?.required !== 'boolean') errors.push('field_contract_required_flag_invalid')
      const allowedByPrefix = (definition.allowed_path_prefixes || []).some((allowed) => {
        const base = String(allowed).replace(/\/+$/, '') || '/'
        const fieldPath = String(field?.path_prefix || '').replace(/\/+$/, '') || '/'
        return base === '/' || fieldPath === base || fieldPath.startsWith(`${base}/`)
      })
      if (!allowedByPrefix) errors.push('field_contract_path_outside_adapter_scope')
    }
  }
  const labels = definition.receipt?.exact_labels
  if (!Array.isArray(labels) || labels.length === 0
      || labels.some((label) => /application/i.test(String(label)) || !/^(confirmation|receipt|tracking|submission)$/i.test(String(label)))) {
    errors.push('receipt_labels_invalid')
  }
  if (!definition.receipt?.container_selector
      || !definition.receipt?.identity_selector
      || !definition.receipt?.identity_attribute) errors.push('identity_bound_receipt_contract_required')
  if (definition.reconciliation_mode !== 'authenticated_exact_application_lookup_v1') errors.push('exact_reconciliation_required')
  if (definition.status_query?.mode !== 'authenticated_dom_exact_query_v1'
      || !definition.status_query?.query_parameter
      || !validBoundedPathPrefix(definition.status_query?.path_prefix)
      || !definition.status_query?.container_selector
      || !definition.status_query?.status_selector
      || !definition.status_query?.identity_selector
      || !definition.status_query?.identity_attribute
      || !definition.status_query?.received_states?.length
      || !definition.status_query?.absent_states?.length) {
    errors.push('status_query_contract_required')
  }
  const statusIdentityKind = ({
    applicationid: 'application', workspaceid: 'workspace',
    submissionid: 'submission',
  })[String(definition.status_query?.query_parameter || '').toLowerCase().replace(/[_-]/g, '')]
  if (statusIdentityKind !== definition.application_identity_kind) errors.push('status_query_identity_kind_mismatch')
  if (!/^https:\/\//i.test(String(definition.policy_source_url || ''))) errors.push('policy_source_url_required')
  if (!Number.isFinite(Date.parse(definition.policy_checked_at))) errors.push('policy_checked_at_required')
  if (normalizeHost(portalHost) !== normalizeHost(definition.portal_host || portalHost)) errors.push('portal_host_mismatch')
  return errors
}

export function validateSubmissionAdapterFixtures({ portalHost, definition, fixtures } = {}) {
  const errors = validateDefinition(portalHost, definition)
  const cases = new Map((Array.isArray(fixtures) ? fixtures : []).map((fixture) => [fixture?.case, fixture]))
  for (const required of REQUIRED_FIXTURE_CASES) if (!cases.has(required)) errors.push(`missing_fixture:${required}`)
  const outcomes = []
  for (const caseName of REQUIRED_FIXTURE_CASES) {
    const fixture = cases.get(caseName)
    if (!fixture) continue
    const identityBound = fixture.receipt_application_identity === fixture.application_identity
      && Number(fixture.receipt_container_count || 0) === 1
    const pre = (identityBound ? extractAdapterReceiptFromText(fixture.pre_click_text, definition) : null)
      || { reference: null, received_acknowledgement: false, page_fingerprint: contractSha256(fixture.pre_click_text || '') }
    const post = (identityBound ? extractAdapterReceiptFromText(fixture.post_click_text, definition) : null)
      || { reference: null, received_acknowledgement: false, page_fingerprint: contractSha256(fixture.post_click_text || '') }
    const received = assessAdapterPostClickObservation(pre, post).received
    const expected = caseName === 'new_receipt_success' ? 'externally_received'
      : caseName === 'exact_status_absence' ? 'absence_verified'
        : 'reconciliation_required'
    const actual = caseName === 'exact_status_absence'
      ? (fixture.status_lookup?.application_identity === fixture.application_identity
          && fixture.status_lookup?.outcome === 'absent'
          && fixture.status_lookup?.query_parameter === definition.status_query?.query_parameter
          && fixture.status_lookup?.path_prefix === definition.status_query?.path_prefix
          && fixture.status_lookup?.container_selector_sha256
            === contractSha256(String(definition.status_query?.container_selector || ''))
          && fixture.status_lookup?.identity_container_match === true
          && Number(fixture.status_lookup?.matching_container_count || 0) === 1
          && Number(fixture.status_lookup?.identity_match_count || 0) === 1
          && Number(fixture.status_lookup?.status_match_count || 0) === 1
          && /^[a-f0-9]{64}$/i.test(String(fixture.status_lookup?.response_sha256 || ''))
          ? 'absence_verified' : 'reconciliation_required')
      : received ? 'externally_received' : 'reconciliation_required'
    if (actual !== expected) errors.push(`fixture_failed:${caseName}:${actual}`)
    outcomes.push({ case: caseName, expected, actual, passed: actual === expected })
  }
  const successFixture = cases.get('new_receipt_success')
  const expectedFieldHash = contractSha256(stableContractJson(definition?.field_contract || null))
  if (successFixture?.form_observation?.field_contract_sha256 !== expectedFieldHash) {
    errors.push('fixture_failed:new_receipt_success:field_contract_not_executed')
  }
  const requiredKeys = (definition?.field_contract?.fields || [])
    .filter((field) => field.required === true)
    .map((field) => String(field.answer_key))
    .sort()
  const observedRequiredKeys = [...new Set((successFixture?.form_observation?.required_answer_keys || []).map(String))].sort()
  if (stableContractJson(requiredKeys) !== stableContractJson(observedRequiredKeys)) {
    errors.push('fixture_failed:new_receipt_success:required_field_schema_mismatch')
  }
  const fixtureContract = {
    validation_version: SUBMISSION_ADAPTER_VALIDATION_VERSION,
    portal_host: normalizeHost(portalHost),
    definition,
    fixtures: (fixtures || []).map((fixture) => ({
      case: fixture.case,
      application_identity: fixture.application_identity || null,
      pre_click_sha256: contractSha256(fixture.pre_click_text || ''),
      post_click_sha256: contractSha256(fixture.post_click_text || ''),
      status_response_sha256: fixture.status_lookup?.response_sha256 || null,
      status_container_observation_sha256: contractSha256(stableContractJson({
        path_prefix: fixture.status_lookup?.path_prefix || null,
        container_selector_sha256: fixture.status_lookup?.container_selector_sha256 || null,
        identity_container_match: fixture.status_lookup?.identity_container_match === true,
        matching_container_count: Number(fixture.status_lookup?.matching_container_count || 0),
        identity_match_count: Number(fixture.status_lookup?.identity_match_count || 0),
        status_match_count: Number(fixture.status_lookup?.status_match_count || 0),
      })),
      form_observation_sha256: contractSha256(stableContractJson(fixture.form_observation || null)),
    })).sort((a, b) => String(a.case).localeCompare(String(b.case))),
  }
  return {
    valid: errors.length === 0,
    errors,
    outcomes,
    fixture_contract_sha256: contractSha256(stableContractJson(fixtureContract)),
  }
}

export async function onboardReviewedSubmissionAdapter(db, {
  portalHost,
  definition,
  fixtures,
  reviewedByUserId,
  operatorValidationArtifactId = null,
  now = new Date(),
} = {}) {
  const host = normalizeHost(portalHost)
  if (!db || !host || !reviewedByUserId) throw new Error('db, portalHost, and reviewedByUserId required')
  const report = validateSubmissionAdapterFixtures({ portalHost: host, definition, fixtures })
  if (!report.valid) return { onboarded: false, report }
  const syntheticFixtureOnly = isSyntheticFixtureHost(host)
  const liveValidation = syntheticFixtureOnly
    ? { valid: true, artifact: null }
    : await loadLiveOperatorValidation(db, {
        artifactId: operatorValidationArtifactId,
        host,
        definition,
        fixtureContractSha256: report.fixture_contract_sha256,
        now,
      })
  if (!liveValidation.valid) {
    return {
      onboarded: false,
      report: {
        ...report,
        valid: false,
        errors: [...report.errors, liveValidation.reason],
        live_enablement_allowed: false,
      },
    }
  }
  const current = await getPolicyFor(db, host)
  const submissionAdapter = {
    id: definition.id,
    version: definition.version,
    portal_host: host,
    mode: definition.mode,
    application_identity_kind: definition.application_identity_kind,
    enabled: true,
    kill_switch: false,
    allowed_path_prefixes: definition.allowed_path_prefixes,
    auth_path_prefixes: definition.auth_path_prefixes,
    allowed_origins: definition.allowed_origins,
    submit_control: definition.submit_control,
    field_contract: definition.field_contract,
    receipt: definition.receipt,
    reconciliation_mode: definition.reconciliation_mode,
    status_query: definition.status_query,
    fixture_contract_sha256: report.fixture_contract_sha256,
    operator_validation_version: syntheticFixtureOnly
      ? SUBMISSION_ADAPTER_VALIDATION_VERSION
      : SUBMISSION_ADAPTER_OPERATOR_VALIDATION_VERSION,
    synthetic_fixture_only: syntheticFixtureOnly,
    operator_validation_artifact_id: liveValidation.artifact?.id || null,
    operator_validation_evidence_sha256: liveValidation.artifact?.evidence_manifest_sha256 || null,
    operator_validation_environment: liveValidation.artifact?.validation_environment || null,
    operator_validation_expires_at: liveValidation.artifact?.expires_at || null,
    reviewed: true,
    reviewed_at: new Date(now).toISOString(),
    reviewed_by_user_id: String(reviewedByUserId),
    policy_source_url: definition.policy_source_url,
    policy_checked_at: definition.policy_checked_at,
  }
  const policy = await upsertPolicy(db, {
    portalHost: host,
    automationAllowed: current?.automation_allowed !== false,
    agentSubmissionAllowed: true,
    scrapingAllowed: current?.scraping_allowed === true,
    apiAvailable: current?.api_available === true,
    manualOnly: false,
    fallbackPath: current?.fallback_path || 'pdf_docx',
    sourceOfPolicy: definition.policy_source_url,
    notes: current?.notes || `Reviewed submission adapter ${definition.id}@${definition.version}`,
    metadata: { ...(current?.metadata || {}), submission_adapter: submissionAdapter },
  })
  return { onboarded: true, report, policy, submission_adapter: submissionAdapter }
}

export async function getSubmissionAdapterCoverage(db, { now = new Date() } = {}) {
  const policies = await listPolicies(db)
  const realPolicies = (policies || []).filter((policy) => !isSyntheticFixtureHost(policy.portal_host))
  const reviewed = realPolicies
    .map((policy) => ({ policy, adapter: policy.submission_adapter || policy.metadata?.submission_adapter || null }))
    .filter(({ policy }) => policy.submission_mode === 'reviewed_auto_submit')
    .map(({ policy, adapter }) => ({
      portal_host: policy.portal_host,
      adapter_id: adapter?.id || null,
      adapter_version: adapter?.version || null,
      last_validated_at: adapter?.reviewed_at || null,
      fixture_contract_sha256: adapter?.fixture_contract_sha256 || null,
      operator_validation_expires_at: adapter?.operator_validation_expires_at || null,
      kill_switch: adapter?.kill_switch === true,
    }))
  return Object.freeze({
    contract: 'hamilton-real-submission-adapter-coverage-v1',
    checked_at: new Date(now).toISOString(),
    reviewed_real_adapter_count: reviewed.length,
    reviewed_real_hosts: reviewed,
    synthetic_reference_adapter_available: true,
    default_submission_mode: 'draft_or_human_handoff',
    coverage_truth: reviewed.length === 0
      ? 'No real funding portal currently has an independently operator-validated auto-submit adapter. Hamilton may prepare drafts, but final submission is human-only.'
      : `Hamilton auto-submit is limited to ${reviewed.length} currently validated real portal adapter(s); every other portal is draft or human handoff only.`,
  })
}

export async function setSubmissionAdapterKillSwitch(db, {
  portalHost,
  killed = true,
  changedByUserId,
  reason = null,
} = {}) {
  const host = normalizeHost(portalHost)
  if (!db || !host || !changedByUserId) throw new Error('db, portalHost, and changedByUserId required')
  const current = await getPolicyFor(db, host)
  const adapter = current?.submission_adapter || current?.metadata?.submission_adapter
  if (!adapter) throw new Error('submission_adapter_not_found')
  const updatedAdapter = {
    ...adapter,
    kill_switch: killed === true,
    kill_switch_changed_at: new Date().toISOString(),
    kill_switch_changed_by_user_id: String(changedByUserId),
    kill_switch_reason: reason ? String(reason).slice(0, 500) : null,
  }
  const policy = await upsertPolicy(db, {
    portalHost: host,
    automationAllowed: current.automation_allowed !== false,
    agentSubmissionAllowed: killed !== true,
    scrapingAllowed: current.scraping_allowed === true,
    apiAvailable: current.api_available === true,
    manualOnly: current.manual_only === true,
    fallbackPath: current.fallback_path,
    sourceOfPolicy: current.source_of_policy,
    notes: current.notes,
    metadata: { ...(current.metadata || {}), submission_adapter: updatedAdapter },
  })
  return { policy, submission_adapter: updatedAdapter }
}

// Reference contract used only by tests/operator dry-runs; never seeded for a
// real funding portal.
export const SYNTHETIC_REFERENCE_ADAPTER = Object.freeze({
  id: 'synthetic-reference',
  version: '1.0.0',
  portal_host: 'fixture.hamilton.invalid',
  mode: 'typed_receipt_v1',
  application_identity_kind: 'application',
  enabled: true,
  kill_switch: false,
  allowed_path_prefixes: ['/apply'],
  auth_path_prefixes: ['/login'],
  allowed_origins: ['https://fixture.hamilton.invalid'],
  submit_control: { selector: '[data-fixture-submit]', exact_text_sha256: contractSha256('Submit application') },
  field_contract: {
    version: 'exact-fields-v1',
    fields: [
      { path_prefix: '/apply', selector: '[name="first_name"]', answer_key: 'first_name', control_type: 'text', transform: 'trim', required: true },
      { path_prefix: '/apply', selector: '[name="email"]', answer_key: 'email', control_type: 'email', transform: 'trim', required: true },
    ],
  },
  receipt: {
    exact_labels: ['Confirmation', 'Receipt', 'Tracking', 'Submission'],
    container_selector: '[data-fixture-receipt-row]',
    identity_selector: '[data-fixture-receipt-application-id]',
    identity_attribute: 'data-fixture-receipt-application-id',
  },
  reconciliation_mode: 'authenticated_exact_application_lookup_v1',
  status_query: {
    mode: 'authenticated_dom_exact_query_v1',
    path_prefix: '/apply',
    query_parameter: 'applicationId',
    container_selector: '[data-fixture-status-row]',
    status_selector: '[data-fixture-status]',
    identity_selector: '[data-fixture-application-id]',
    identity_attribute: 'data-fixture-application-id',
    received_states: ['received', 'validated'],
    absent_states: ['not found'],
  },
  policy_source_url: 'https://fixture.hamilton.invalid/policy',
  policy_checked_at: '2026-08-05T00:00:00.000Z',
})
