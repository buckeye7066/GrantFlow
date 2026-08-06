import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  getSubmissionAdapterCoverage,
  onboardReviewedSubmissionAdapter,
  SYNTHETIC_REFERENCE_ADAPTER,
  validateSubmissionAdapterFixtures,
} from '../services/hamilton/hamiltonSubmissionAdapterRegistry.js'
import { _resetPortalPolicySchemaCache } from '../services/hamilton/hamiltonPortalPolicyRegistry.js'
import { contractSha256, stableContractJson } from '../../shared/irreversibleActionContract.js'

function makeDb() {
  _resetPortalPolicySchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

function fixtures(definition) {
  const app = 'fixture-app-123'
  const receipt = 'Your application has been received. Confirmation Number: CONF-123456'
  return [
    {
      case: 'new_receipt_success', application_identity: app,
      receipt_application_identity: app, receipt_container_count: 1,
      pre_click_text: 'Review application', post_click_text: receipt,
      form_observation: {
        field_contract_sha256: contractSha256(stableContractJson(definition.field_contract)),
        required_answer_keys: definition.field_contract.fields.filter((field) => field.required).map((field) => field.answer_key),
      },
    },
    { case: 'preexisting_application_id_negative', application_identity: app, pre_click_text: 'Application ID: DRAFT-123456', post_click_text: 'Application ID: DRAFT-123456' },
    { case: 'unchanged_spa_negative', application_identity: app, pre_click_text: receipt, post_click_text: receipt },
    { case: 'screenshot_only_negative', application_identity: app },
    { case: 'ambiguous_timeout_negative', application_identity: app },
    { case: 'unrelated_receipt_negative', application_identity: app, receipt_application_identity: 'other', receipt_container_count: 1, post_click_text: receipt },
    { case: 'multiple_application_receipts_negative', application_identity: app, receipt_application_identity: app, receipt_container_count: 2, post_click_text: receipt },
    {
      case: 'exact_status_absence', application_identity: app,
      status_lookup: {
        application_identity: app, outcome: 'absent',
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

beforeEach(() => _resetPortalPolicySchemaCache())

describe('Hamilton reviewed adapter live coverage truth', () => {
  it('bounds path-prefix normalization before processing attacker-controlled slash runs', () => {
    const oversized = {
      ...SYNTHETIC_REFERENCE_ADAPTER,
      allowed_path_prefixes: [`/apply${'/'.repeat(513)}`],
    }
    const report = validateSubmissionAdapterFixtures({
      portalHost: oversized.portal_host,
      definition: oversized,
      fixtures: fixtures(oversized),
    })
    expect(report.valid).toBe(false)
    expect(report.errors).toContain('allowed_paths_required')
  })

  it('rejects status contracts and fixtures that do not bind identity + status to one exact container', () => {
    const missingContainer = {
      ...SYNTHETIC_REFERENCE_ADAPTER,
      status_query: { ...SYNTHETIC_REFERENCE_ADAPTER.status_query, container_selector: '' },
    }
    const invalidDefinition = validateSubmissionAdapterFixtures({
      portalHost: missingContainer.portal_host,
      definition: missingContainer,
      fixtures: fixtures(missingContainer),
    })
    expect(invalidDefinition.valid).toBe(false)
    expect(invalidDefinition.errors).toContain('status_query_contract_required')

    const unboundFixtures = fixtures(SYNTHETIC_REFERENCE_ADAPTER)
    const absence = unboundFixtures.find((fixture) => fixture.case === 'exact_status_absence')
    absence.status_lookup.identity_container_match = false
    const invalidFixture = validateSubmissionAdapterFixtures({
      portalHost: SYNTHETIC_REFERENCE_ADAPTER.portal_host,
      definition: SYNTHETIC_REFERENCE_ADAPTER,
      fixtures: unboundFixtures,
    })
    expect(invalidFixture.valid).toBe(false)
    expect(invalidFixture.errors).toContain('fixture_failed:exact_status_absence:reconciliation_required')
  })

  it('does not let caller-supplied fixture strings enable a real host', async () => {
    const db = makeDb()
    const realDefinition = {
      ...SYNTHETIC_REFERENCE_ADAPTER,
      id: 'forged-real-fixture',
      portal_host: 'funding.example.org',
      allowed_origins: ['https://funding.example.org'],
      policy_source_url: 'https://funding.example.org/policy',
    }
    const suppliedFixtures = fixtures(realDefinition)
    expect(validateSubmissionAdapterFixtures({
      portalHost: realDefinition.portal_host,
      definition: realDefinition,
      fixtures: suppliedFixtures,
    }).valid).toBe(true)

    const result = await onboardReviewedSubmissionAdapter(db, {
      portalHost: realDefinition.portal_host,
      definition: realDefinition,
      fixtures: suppliedFixtures,
      reviewedByUserId: 'admin-caller',
    })
    expect(result.onboarded).toBe(false)
    expect(result.report.errors).toContain('live_operator_validation_artifact_required')

    const coverage = await getSubmissionAdapterCoverage(db)
    expect(coverage.reviewed_real_adapter_count).toBe(0)
    expect(coverage.reviewed_real_hosts).toEqual([])
    expect(coverage.coverage_truth).toMatch(/No real funding portal/i)
  })

  it('keeps the executable synthetic reference adapter out of real-host coverage', async () => {
    const db = makeDb()
    const result = await onboardReviewedSubmissionAdapter(db, {
      portalHost: SYNTHETIC_REFERENCE_ADAPTER.portal_host,
      definition: SYNTHETIC_REFERENCE_ADAPTER,
      fixtures: fixtures(SYNTHETIC_REFERENCE_ADAPTER),
      reviewedByUserId: 'test-operator',
    })
    expect(result.onboarded).toBe(true)
    expect(result.submission_adapter.synthetic_fixture_only).toBe(true)
    const coverage = await getSubmissionAdapterCoverage(db)
    expect(coverage.reviewed_real_adapter_count).toBe(0)
    expect(coverage.synthetic_reference_adapter_available).toBe(true)
  })
})
