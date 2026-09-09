import { describe, expect, it } from 'vitest'
import { classifyFundingResult } from '../config/fundingResultFilters.js'
import { partitionFundingSources } from '../services/matching/fundingSourcePresentation.js'
import { gateRelatable } from '../services/robert/robertPipelineAudit.js'
import { evaluateDiscovery } from '../services/amy/amyReport.js'

const serviceTitles = [
  'Nursing Entrance Exam (TEAS)',
  'Accuplacer Placement Exams',
  'Correspondence Exams',
  'Disability Support Services',
]
const row = (title) => ({ title, sponsor: 'Community College', opportunity_kind: 'DIRECT_GRANT',
  kind: 'DIRECT_GRANT', source_url: 'https://www.clevelandstatecc.edu/for-students/',
  application_url: 'https://www.clevelandstatecc.edu/for-students/',
  amount_status: 'not_listed', match_score: 60, decision: 'REVIEW' })
const amountFinding = (recommendations) => evaluateDiscovery(
  { scenario_id: 'college-student', category: 'college_student', label: 'College student', expected: { state: 'TN' } },
  'synthetic-college-student',
  { run: { run_id: 'test', stored: recommendations.length, sources: [], recommendations },
    persisted: { opportunities: recommendations.length },
    thesis: { applicant_types: ['individual'], needs: ['education'], location: { state: 'TN' } } },
).findings.find((finding) => finding.type === 'amount_recall_miss')

describe('educational services are resources, not per-award funding', () => {
  it.each(serviceTitles)('keeps %s out of direct funding even when ingest mislabeled it', (title) => {
    expect(classifyFundingResult(row(title))).toMatchObject({ bucket: 'resource', reasons: ['educational_service_title'] })
    expect(gateRelatable(row(title))).toMatchObject({ pass: false, harvest_first: true })
  })
  it.each(['Nursing Entrance Exam Fee Assistance', 'Accuplacer Placement Exam Scholarship',
    'Disability Support Services Grant', 'Correspondence Exam Fee Waiver',
    'Nursing Entrance Exam Fee-Assistance Program', 'Entrance Exam Financial Assistance',
    'Placement Test Voucher', 'Mi Sueño',
    'CSCC Alumni Legacy Scholarship'])('preserves an actual award: %s', (title) => {
    expect(classifyFundingResult(row(title)).bucket).toBe('fundable')
  })
  it.each(serviceTitles)('routes a legacy ACCEPT for %s to resources', (title) => {
    const result = partitionFundingSources([{ ...row(title), id: title, match_decision: 'ACCEPT' }])
    expect(result.sources).toHaveLength(0)
    expect(result.directories).toHaveLength(1)
    expect(result.directories[0].resource_reasons).toContain('educational_service_title')
  })
  it('keeps the existing stored ACCEPT policy when the only evidence is missing funding fields', () => {
    const result = partitionFundingSources([{ id: 'unknown-program', title: 'Education Program', match_decision: 'ACCEPT' }])
    expect(result.sources).toHaveLength(1)
    expect(result.directories).toHaveLength(0)
  })
  it('does not call tests and disability accommodations missing scholarship dollars', () => {
    expect(amountFinding([...serviceTitles.map(row), row('Mi Sueño'), row('CSCC Alumni Legacy Scholarship')])).toBeUndefined()
  })
  it('still reports five genuine unknown award amounts and names only those awards', () => {
    const titles = ['Alpha Scholarship', 'Beta Grant', 'Gamma Award', 'Delta Scholarship', 'Epsilon Grant']
    const finding = amountFinding([...serviceTitles.map(row), ...titles.map(row)])
    expect(finding).toBeTruthy()
    expect(finding.evidence.measurable).toBe(5)
    expect(finding.evidence.subjects).toEqual(titles)
  })
})
