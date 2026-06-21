/**
 * Clinical-trials connector tests.
 *
 * Pins the behavior the medical-needs feature depends on, with the
 * ClinicalTrials.gov fetch fully mocked (no network):
 *   1. condition/diagnosis → query mapping (real field names)
 *   2. RECRUITING-only + early/Phase-1 boosting/filtering
 *   3. normalization to a clinical_trial-typed opportunity with a real NCT URL
 *   4. NOTHING is surfaced when the profile has not opted in
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock node-fetch BEFORE importing the connector (the connector imports it at
// module load). Each test sets fetchMock's implementation.
const fetchMock = vi.fn()
vi.mock('node-fetch', () => ({ default: (...args) => fetchMock(...args) }))

const {
  isOptedIntoClinicalTrials,
  extractConditionTerms,
  buildStudyQueryUrl,
  normalizeStudy,
  searchClinicalTrials,
} = await import('../services/connectors/clinicalTrialsConnector.js')

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

// A realistic ClinicalTrials.gov v2 study object (trimmed to the fields we read).
function makeStudy({
  nctId,
  status = 'RECRUITING',
  phases = ['PHASE1'],
  title = 'A Study of Something',
  sponsor = 'Acme Research Institute',
  conditions = ['Epilepsy'],
  state = 'TN',
  city = 'Nashville',
} = {}) {
  return {
    protocolSection: {
      identificationModule: { nctId, briefTitle: title },
      statusModule: { overallStatus: status },
      designModule: { phases },
      conditionsModule: { conditions },
      sponsorCollaboratorsModule: { leadSponsor: { name: sponsor } },
      eligibilityModule: { sex: 'ALL', minimumAge: '18 Years', maximumAge: '65 Years' },
      contactsLocationsModule: { locations: [{ city, state, country: 'United States' }] },
    },
  }
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('isOptedIntoClinicalTrials (opt-in gate)', () => {
  it('is false when the health section is missing or not opted in', () => {
    expect(isOptedIntoClinicalTrials(undefined)).toBe(false)
    expect(isOptedIntoClinicalTrials({})).toBe(false)
    expect(isOptedIntoClinicalTrials({ consent_for_studies: false })).toBe(false)
    expect(isOptedIntoClinicalTrials({ clinical_trials_opt_in: false })).toBe(false)
  })

  it('is true only on an explicit affirmative opt-in', () => {
    expect(isOptedIntoClinicalTrials({ consent_for_studies: true })).toBe(true)
    expect(isOptedIntoClinicalTrials({ clinical_trials_opt_in: true })).toBe(true)
    expect(isOptedIntoClinicalTrials({ consent_for_studies: 'yes' })).toBe(true)
    expect(isOptedIntoClinicalTrials({ clinical_trials_opt_in: '1' })).toBe(true)
  })
})

describe('extractConditionTerms (condition → query mapping source)', () => {
  it('reads structured conditions, chronic_illness_type, and disability_type', () => {
    const terms = extractConditionTerms({
      conditions: [{ name: 'Epilepsy' }, 'Multiple Sclerosis'],
      chronic_illness_type: 'Type 1 Diabetes',
      disability_type: ['Neurological'],
    })
    expect(terms).toContain('Epilepsy')
    expect(terms).toContain('Multiple Sclerosis')
    expect(terms).toContain('Type 1 Diabetes')
    expect(terms).toContain('Neurological')
  })

  it('de-dupes case-insensitively and drops too-short tokens', () => {
    const terms = extractConditionTerms({
      conditions: ['Epilepsy', 'epilepsy', 'a'],
    })
    expect(terms).toEqual(['Epilepsy'])
  })

  it('returns [] for an empty / missing section', () => {
    expect(extractConditionTerms(undefined)).toEqual([])
    expect(extractConditionTerms({})).toEqual([])
  })
})

describe('buildStudyQueryUrl (query mapping)', () => {
  it('maps a condition into a RECRUITING-filtered ClinicalTrials.gov v2 query', () => {
    const url = buildStudyQueryUrl('Epilepsy', { state: 'TN' })
    expect(url.startsWith('https://clinicaltrials.gov/api/v2/studies?')).toBe(true)
    const qs = new URL(url).searchParams
    expect(qs.get('query.cond')).toBe('Epilepsy')
    expect(qs.get('filter.overallStatus')).toContain('RECRUITING')
    expect(qs.get('query.locn')).toBe('TN')
  })
})

describe('normalizeStudy (clinical_trial typing + real NCT URL)', () => {
  it('produces a clinical_trial-typed record with a real study URL', () => {
    const rec = normalizeStudy(makeStudy({ nctId: 'NCT01234567', phases: ['PHASE1'] }))
    expect(rec).not.toBeNull()
    expect(rec.opportunity_type).toBe('clinical_trial')
    expect(rec.funding_type).toBe('clinical_trial')
    // Never a grant/loan/scholarship.
    expect(['grant', 'loan', 'scholarship']).not.toContain(rec.opportunity_type)
    expect(rec.source_url).toBe('https://clinicaltrials.gov/study/NCT01234567')
    expect(rec.application_url).toBe('https://clinicaltrials.gov/study/NCT01234567')
    expect(rec.external_id).toBe('NCT01234567')
    expect(rec.source_id).toBe('NCT01234567')
    expect(rec._is_early_phase).toBe(true)
    // Honest label: a study, not money.
    expect(rec.description.toLowerCase()).toContain('not funding')
  })

  it('rejects studies with no NCT id and never fabricates one', () => {
    const rec = normalizeStudy({ protocolSection: { statusModule: { overallStatus: 'RECRUITING' } } })
    expect(rec).toBeNull()
  })

  it('rejects non-recruiting studies', () => {
    const rec = normalizeStudy(makeStudy({ nctId: 'NCT09999999', status: 'COMPLETED' }))
    expect(rec).toBeNull()
  })
})

describe('searchClinicalTrials (RECRUITING + early-phase filtering, no network)', () => {
  it('returns [] when there are no conditions (no fabrication)', async () => {
    const out = await searchClinicalTrials({ conditions: [] })
    expect(out).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps only RECRUITING studies and boosts early-phase to the top', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        studies: [
          makeStudy({ nctId: 'NCT00000002', phases: ['PHASE3'], status: 'RECRUITING' }),
          makeStudy({ nctId: 'NCT00000001', phases: ['PHASE1'], status: 'RECRUITING' }),
          makeStudy({ nctId: 'NCT00000003', phases: ['PHASE2'], status: 'COMPLETED' }),
        ],
      }),
    )
    const out = await searchClinicalTrials({ conditions: ['Epilepsy'] })
    // The COMPLETED study is dropped; only the two RECRUITING remain.
    expect(out).toHaveLength(2)
    expect(out.every((o) => o._status === 'RECRUITING')).toBe(true)
    // Early-phase (Phase 1) is boosted ahead of the Phase 3 study.
    expect(out[0].source_id).toBe('NCT00000001')
    expect(out[0]._is_early_phase).toBe(true)
    // Every surfaced record is a clinical_trial with a real NCT URL.
    out.forEach((o) => {
      expect(o.opportunity_type).toBe('clinical_trial')
      expect(o.source_url).toBe(`https://clinicaltrials.gov/study/${o.source_id}`)
    })
  })

  it('with earlyPhaseOnly, drops studies that are not early/Phase 1', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        studies: [
          makeStudy({ nctId: 'NCT00000010', phases: ['PHASE3'], status: 'RECRUITING' }),
          makeStudy({ nctId: 'NCT00000011', phases: ['EARLY_PHASE1'], status: 'RECRUITING' }),
        ],
      }),
    )
    const out = await searchClinicalTrials({ conditions: ['Epilepsy'], earlyPhaseOnly: true })
    expect(out).toHaveLength(1)
    expect(out[0].source_id).toBe('NCT00000011')
  })

  it('never throws on a fetch failure — logs and returns []', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const out = await searchClinicalTrials({ conditions: ['Epilepsy'] })
    expect(out).toEqual([])
  })

  it('never throws on a non-OK HTTP response — returns []', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 503))
    const out = await searchClinicalTrials({ conditions: ['Epilepsy'] })
    expect(out).toEqual([])
  })
})

describe('opt-in enforcement at the ingest source gate', () => {
  it('the clinicaltrials.gov source surfaces NOTHING when the profile is not opted in', async () => {
    const { buildConnectorQueryPlan } = await import('../services/connectorIngestService.js')

    const optedOut = buildConnectorQueryPlan({
      profile: { primary_type: 'individual', id: 'p1' },
      sections: { health_medical: { conditions: [{ name: 'Epilepsy' }], consent_for_studies: false } },
    })
    expect(optedOut.clinicalTrialsOptIn).toBe(false)

    const optedIn = buildConnectorQueryPlan({
      profile: { primary_type: 'individual', id: 'p2' },
      sections: { health_medical: { conditions: [{ name: 'Epilepsy' }], consent_for_studies: true } },
    })
    expect(optedIn.clinicalTrialsOptIn).toBe(true)
    expect(optedIn.conditionTerms).toContain('Epilepsy')
  })
})
