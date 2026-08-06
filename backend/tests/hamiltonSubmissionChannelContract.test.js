import { describe, expect, it } from 'vitest'

import {
  classifyGrantsGovWorkspaceAction,
  GRANTS_GOV_S2S_CONTRACT_VERSION,
  HAMILTON_SUBMISSION_CHANNELS,
  selectHamiltonSubmissionChannel,
  validateOfficialS2SContract,
} from '../../shared/hamiltonSubmissionChannelContract.js'

function s2sContract(overrides = {}) {
  return {
    version: GRANTS_GOV_S2S_CONTRACT_VERSION,
    transport: 'soap_s2s',
    environment: 'training',
    wsdl_url: 'https://training.grants.gov/applicant-s2s.wsdl',
    wsdl_sha256: 'a'.repeat(64),
    fixture_contract_sha256: 'b'.repeat(64),
    client_certificate_ref: 'vault://grants-gov/training/client-cert',
    client_certificate_fingerprint_sha256: 'c'.repeat(64),
    aor_role: 'expanded_aor',
    aor_authorization_id: 'auth-expanded-aor-1',
    operations: ['SubmitApplication', 'GetSubmissionList', 'GetApplicationInfo'],
    idempotency_mode: 'exact_workspace_round_payload_v1',
    receipt_type: 'grants_gov_tracking_number',
    reviewed: true,
    kill_switch: false,
    ...overrides,
  }
}

const browserAdapter = {
  id: 'fixture-browser', version: '1.0.0', fixture_contract_sha256: 'd'.repeat(64),
}

describe('ranked Hamilton submission channels', () => {
  it('ranks an executable reviewed official SOAP S2S channel ahead of browser', () => {
    const selected = selectHamiltonSubmissionChannel({
      officialS2SContract: s2sContract(),
      officialS2SExecutorAvailable: true,
      reviewedBrowserAdapter: browserAdapter,
    })
    expect(selected.channel).toBe(HAMILTON_SUBMISSION_CHANNELS.OFFICIAL_S2S)
  })

  it('never treats REST/search metadata, missing Expanded AOR, or a missing certificate/executor as submit capability', () => {
    expect(validateOfficialS2SContract(s2sContract({
      transport: 'rest', aor_role: 'workspace_manager', client_certificate_ref: null,
    }), { executorAvailable: true }).valid).toBe(false)
    expect(selectHamiltonSubmissionChannel({
      officialS2SContract: s2sContract(),
      officialS2SExecutorAvailable: false,
      reviewedBrowserAdapter: browserAdapter,
    }).channel).toBe(HAMILTON_SUBMISSION_CHANNELS.REVIEWED_BROWSER)
    expect(selectHamiltonSubmissionChannel({
      officialS2SContract: s2sContract(),
      officialS2SExecutorAvailable: false,
      reviewedBrowserAdapter: null,
    }).channel).toBe(HAMILTON_SUBMISSION_CHANNELS.HUMAN_HANDOFF)
  })

  it('requires tracking-number/status operations in the official sandbox contract', () => {
    const report = validateOfficialS2SContract(s2sContract({
      operations: ['SubmitApplication'], receipt_type: 'generic_success_page',
    }), { executorAvailable: true })
    expect(report.errors).toEqual(expect.arrayContaining([
      'submit_and_status_operations_required',
      'tracking_number_receipt_required',
    ]))
  })

  it('never counts Complete and Notify AOR or Sign and Submit as externally received', () => {
    expect(classifyGrantsGovWorkspaceAction('Complete and Notify AOR')).toEqual({
      submitted: false, state: 'ready_for_submission', human_action_kind: 'role_aor',
    })
    expect(classifyGrantsGovWorkspaceAction('Sign and Submit')).toEqual({
      submitted: false, state: 'human_action_required', human_action_kind: 'role_aor',
    })
  })
})
