/** Ranked, fail-closed channels for Hamilton external submission. */
export const HAMILTON_SUBMISSION_CHANNELS = Object.freeze({
  OFFICIAL_S2S: 'official_s2s',
  REVIEWED_BROWSER: 'reviewed_browser',
  HUMAN_HANDOFF: 'human_handoff',
})

export const GRANTS_GOV_S2S_CONTRACT_VERSION = 'grants-gov-applicant-soap-s2s-v1'

function hexDigest(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''))
}

/**
 * Grants.gov submission is the Applicant SOAP S2S interface, not the public
 * search/fetch REST API. A config is executable only with a reviewed WSDL/
 * fixture, Expanded AOR authority, certificate reference, idempotency, and an
 * installed executor. Secret certificate bytes never belong in this object.
 */
export function validateOfficialS2SContract(contract, { executorAvailable = false } = {}) {
  const errors = []
  if (!contract || typeof contract !== 'object') return { valid: false, errors: ['contract_required'] }
  if (contract.version !== GRANTS_GOV_S2S_CONTRACT_VERSION) errors.push('contract_version_mismatch')
  if (contract.transport !== 'soap_s2s') errors.push('soap_s2s_transport_required')
  if (!['training', 'production'].includes(contract.environment)) errors.push('environment_invalid')
  if (!contract.wsdl_url || !/^https:\/\//i.test(String(contract.wsdl_url))) errors.push('https_wsdl_required')
  if (!hexDigest(contract.wsdl_sha256)) errors.push('wsdl_hash_required')
  if (!hexDigest(contract.fixture_contract_sha256)) errors.push('fixture_contract_hash_required')
  if (!contract.client_certificate_ref || !hexDigest(contract.client_certificate_fingerprint_sha256)) {
    errors.push('client_certificate_reference_required')
  }
  if (contract.aor_role !== 'expanded_aor' || !contract.aor_authorization_id) {
    errors.push('expanded_aor_authorization_required')
  }
  if (!Array.isArray(contract.operations)
      || !['SubmitApplication', 'GetSubmissionList', 'GetApplicationInfo'].every((op) => contract.operations.includes(op))) {
    errors.push('submit_and_status_operations_required')
  }
  if (contract.idempotency_mode !== 'exact_workspace_round_payload_v1') errors.push('idempotency_contract_required')
  if (contract.receipt_type !== 'grants_gov_tracking_number') errors.push('tracking_number_receipt_required')
  if (contract.reviewed !== true || contract.kill_switch === true) errors.push('reviewed_enabled_contract_required')
  if (executorAvailable !== true) errors.push('official_s2s_executor_unavailable')
  return { valid: errors.length === 0, errors }
}

export function selectHamiltonSubmissionChannel({
  officialS2SContract = null,
  officialS2SExecutorAvailable = false,
  reviewedBrowserAdapter = null,
} = {}) {
  const official = validateOfficialS2SContract(officialS2SContract, {
    executorAvailable: officialS2SExecutorAvailable,
  })
  if (official.valid) {
    return {
      channel: HAMILTON_SUBMISSION_CHANNELS.OFFICIAL_S2S,
      reason: 'reviewed_official_s2s_available',
      contract_version: officialS2SContract.version,
    }
  }
  if (reviewedBrowserAdapter?.id
      && reviewedBrowserAdapter?.version
      && hexDigest(reviewedBrowserAdapter?.fixture_contract_sha256)) {
    return {
      channel: HAMILTON_SUBMISSION_CHANNELS.REVIEWED_BROWSER,
      reason: 'reviewed_fixture_backed_browser_adapter',
      contract_version: `${reviewedBrowserAdapter.id}@${reviewedBrowserAdapter.version}`,
      official_s2s_unavailable_reasons: official.errors,
    }
  }
  return {
    channel: HAMILTON_SUBMISSION_CHANNELS.HUMAN_HANDOFF,
    reason: 'no_executable_reviewed_submission_channel',
    contract_version: null,
    official_s2s_unavailable_reasons: official.errors,
  }
}

export function classifyGrantsGovWorkspaceAction(label) {
  const normalized = String(label || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
  if (normalized === 'complete and notify aor') {
    return { submitted: false, state: 'ready_for_submission', human_action_kind: 'role_aor' }
  }
  if (normalized === 'sign and submit') {
    return { submitted: false, state: 'human_action_required', human_action_kind: 'role_aor' }
  }
  return { submitted: false, state: 'unknown', human_action_kind: 'unknown_portal_state' }
}
