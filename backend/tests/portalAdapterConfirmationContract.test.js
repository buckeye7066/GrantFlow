import { beforeEach, describe, expect, it } from 'vitest'

import {
  _resetForTests,
  listPortalAdapters,
  resolveAdapter,
} from '../services/portalAdapters/portalAdapterRegistry.js'
import { ADAPTER_OUTCOMES } from '../services/portalAdapters/portalAdapterTypes.js'

const PROFILE = Object.freeze({
  basic_information: {
    first_name: 'Avery',
    last_name: 'Applicant',
    email: 'avery@example.test',
    date_of_birth: '2001-02-03',
    state: 'TN',
  },
  household: { fafsa_filed: true },
  university_applications: { applications: [{ name: 'Example University' }] },
})

const DOCUMENTS = Object.freeze([
  { id: 'transcript-1', type: 'transcript' },
  { id: 'essay-1', type: 'personal_statement' },
])

const EXPECTED_PORTAL_TYPES = Object.freeze({
  external_application: ['external_application'],
  university_financial_aid: ['financial_aid', 'student_account', 'bursar', 'graduate_school'],
  scholarship_portal: ['scholarship', 'admissions', 'department', 'program_specific'],
  manual: ['manual_or_offline'],
})

const RETIRED_CHECKPOINT_COPY = /\b(?:approve|approval|sign[- ]?off)\b/i

function contextFor(portalType, allowSubmit = true) {
  return {
    profile: PROFILE,
    opportunity: {
      id: `opportunity-${portalType}`,
      title: 'Example funding opportunity',
      application_url: `https://funding.example.test/${portalType}`,
    },
    portalLink: {
      portal_type: portalType,
      application_url: `https://funding.example.test/${portalType}`,
      portal_name: 'Example portal',
    },
    portal: null,
    task: { id: `task-${portalType}` },
    knownSchool: null,
    documents: DOCUMENTS,
    options: { allowSubmit, browserAutomation: false },
  }
}

function expectResultContract(result, label) {
  expect(Object.values(ADAPTER_OUTCOMES), `${label}: known outcome`).toContain(result.outcome)
  expect(typeof result.message, `${label}: message`).toBe('string')
  expect(Array.isArray(result.requirements), `${label}: requirements`).toBe(true)
  expect(result.filled_fields && typeof result.filled_fields, `${label}: filled fields`).toBe('object')
  expect(typeof result.safe_to_proceed, `${label}: safety decision`).toBe('boolean')
  expect(result.message, `${label}: retired checkpoint copy`).not.toMatch(RETIRED_CHECKPOINT_COPY)

  for (const requirement of result.requirements) {
    expect(`${requirement?.label || ''} ${requirement?.description || ''}`).not.toMatch(
      RETIRED_CHECKPOINT_COPY,
    )
  }

  if (result.outcome === ADAPTER_OUTCOMES.SUBMITTED) {
    expect(String(result.submission_reference || '').trim(), `${label}: confirmation reference`).not.toBe('')
  } else {
    expect(result.submission_reference, `${label}: non-submission cannot carry proof`).toBeNull()
  }
}

describe('built-in portal adapter confirmation contract', () => {
  beforeEach(() => _resetForTests())

  it('keeps the supported adapter and portal-type matrix explicit and exhaustive', () => {
    const adapters = listPortalAdapters()
    expect(adapters.map((adapter) => adapter.name)).toEqual(Object.keys(EXPECTED_PORTAL_TYPES))

    for (const adapter of adapters) {
      expect(adapter.portalTypes).toEqual(EXPECTED_PORTAL_TYPES[adapter.name])
      for (const portalType of adapter.portalTypes) {
        const context = contextFor(portalType)
        expect(resolveAdapter(context.portalLink, context.opportunity, context.profile)).toBe(adapter)
        expect(adapter.canHandle(context.portalLink, context.opportunity, context.profile)).toBe(true)
      }
    }
  })

  it('never lets a legacy adapter manufacture an externally submitted result', () => {
    for (const adapter of listPortalAdapters()) {
      for (const portalType of adapter.portalTypes) {
        for (const allowSubmit of [false, true]) {
          const context = contextFor(portalType, allowSubmit)
          const results = [
            adapter.inspectRequirements(context),
            adapter.prepareApplication(context),
            adapter.fillApplication(context),
            adapter.submitApplication(context),
          ]

          results.forEach((result, index) => {
            expectResultContract(result, `${adapter.name}/${portalType}/step-${index}`)
            expect(result.outcome).not.toBe(ADAPTER_OUTCOMES.SUBMITTED)
          })
        }
      }
    }
  })

  it('preserves real identity and attestation stops for institutional portals', () => {
    const context = contextFor('financial_aid')
    context.profile = {
      ...PROFILE,
      household: { fafsa_filed: false },
    }
    context.opportunity = {
      ...context.opportunity,
      title: 'Need-based FAFSA award',
    }

    const result = resolveAdapter(context.portalLink).inspectRequirements(context)

    expect(result.outcome).toBe(ADAPTER_OUTCOMES.BLOCKED_LOGIN)
    expect(result.requirements.some((item) => item.kind === 'login')).toBe(true)
    expect(result.requirements.some((item) => item.kind === 'attestation' && item.key === 'fafsa_filed')).toBe(true)
    expect(result.safe_to_proceed).toBe(false)
  })

  it('uses the manual adapter as the honest fallback for unknown or absent portal metadata', () => {
    expect(resolveAdapter({ portal_type: 'unknown' }).name).toBe('manual')
    expect(resolveAdapter(null).name).toBe('manual')
  })
})
