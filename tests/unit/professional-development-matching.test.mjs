import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const pdMod = await import(pathToFileURL(path.join(root, 'backend/services/matching/professionalDevelopmentPolicy.js')).href)
const {
  detectProfessionalDevelopmentIntent,
  resolveBrandedProgram,
  loadCuratedProfessionalDevelopmentPrograms,
  applyProfessionalDevelopmentQueryPolicy,
  isIncomeSupportOpportunity,
} = pdMod

const { expandNeed, scoreNeedMatch } = await import(
  pathToFileURL(path.join(root, 'backend/services/shared/needTaxonomy.js')).href
)
const { interpretFundingIntentRules } = await import(
  pathToFileURL(path.join(root, 'backend/services/smartMatcherIntent.js')).href
)

const PROBE_QUERY =
  'Help me find funding to pay for the PROBE: Ethics and Boundaries program'

const DR_JOHN_PROFILE = {
  profile: {
    display_name: 'Dr. John White',
    primary_type: 'individual',
    state: 'OH',
  },
  sections: {
    occupation: { healthcare_worker: true, healthcare_worker_type: 'RN' },
    narrative: { primary_goal: 'Complete board-required ethics coursework for license reinstatement' },
  },
  signals: {
    needs: new Set(['license_reinstatement_support', 'professional_remediation_funding', 'healthcare']),
  },
}

test('resolveBrandedProgram recognizes PROBE ethics remediation', () => {
  const hit = resolveBrandedProgram('PROBE: Ethics and Boundaries program')
  assert.ok(hit)
  assert.equal(hit.programType, 'ethics_remediation')
})

test('detectProfessionalDevelopmentIntent activates for PROBE query', () => {
  const intent = detectProfessionalDevelopmentIntent({
    searchTerms: ['probe ethics', 'professional development funding'],
    freeText: PROBE_QUERY,
    profileContext: DR_JOHN_PROFILE,
  })
  assert.equal(intent.active, true)
  assert.equal(intent.excludeIncomeSupport, true)
  assert.ok(intent.branded)
})

test('interpretFundingIntentRules expands PROBE query toward workforce / CE sources', () => {
  const { search_terms } = interpretFundingIntentRules(PROBE_QUERY)
  assert.ok(search_terms.some((t) => /wioa|reinstatement|continuing education|professional remediation|nursing reentry/i.test(t)))
})

test('loadCuratedProfessionalDevelopmentPrograms returns at least 10 PD sources', () => {
  const rows = loadCuratedProfessionalDevelopmentPrograms('OH')
  assert.ok(rows.length >= 10, `expected >= 10 curated PD programs, got ${rows.length}`)
  assert.ok(rows.some((r) => /wioa|workforce|american job center/i.test(`${r.title} ${r.description}`)))
  assert.ok(rows.some((r) => /nurse|ncsbn|probe|reinstatement/i.test(`${r.title} ${r.description}`)))
})

test('applyProfessionalDevelopmentQueryPolicy removes SSI from PROBE-style results', () => {
  const intent = detectProfessionalDevelopmentIntent({ freeText: PROBE_QUERY, searchTerms: [PROBE_QUERY] })
  const rows = [
    { title: 'SSI (Supplemental Security Income)', description: 'Monthly cash for adults 65+', categories: '["cash_assistance","disability"]', match_score: 51 },
    { title: 'WIOA Individual Training Accounts', description: 'License reinstatement and PROBE ethics class tuition', categories: '["license_reinstatement_support","workforce_reentry_training"]', match_score: 78 },
  ]
  const out = applyProfessionalDevelopmentQueryPolicy(rows, intent)
  assert.equal(out.length, 1)
  assert.match(out[0].title, /WIOA/i)
})

test('applyProfessionalDevelopmentQueryPolicy caps unrelated income support at 25%', () => {
  const intent = detectProfessionalDevelopmentIntent({ freeText: PROBE_QUERY, searchTerms: [PROBE_QUERY] })
  const rows = [
    { title: 'General Emergency Cash Grant', description: 'Income support for households', categories: '["cash_assistance"]', match_score: 51 },
    { title: 'State Vocational Rehabilitation', description: 'Professional license reinstatement and remediation classes', categories: '["professional_remediation_funding"]', match_score: 74 },
  ]
  const out = applyProfessionalDevelopmentQueryPolicy(rows, intent)
  assert.equal(out.length, 1)
  assert.ok(out[0].match_score >= 70)
})

test('isIncomeSupportOpportunity identifies SSI rows', () => {
  assert.equal(
    isIncomeSupportOpportunity({ title: 'SSI Benefits', description: 'Supplemental Security Income', categories: ['cash_assistance'] }),
    true,
  )
})

const CE_QUERIES = [
  { label: 'nursing PROBE', text: 'Help me find funding to pay for the PROBE: Ethics and Boundaries program' },
  { label: 'social work CE', text: 'I need continuing education funding for my LCSW license renewal ethics course' },
  { label: 'medicine CME', text: 'Need CME credits funding for board-required professional boundaries training' },
  { label: 'mental health LPC', text: 'Help paying for LPC remedial ethics coursework before I can return to practice' },
  { label: 'allied health PT', text: 'Funding for physical therapist continuing education and licensure exam fees' },
  { label: 'nursing re-entry', text: 'Nursing license reinstatement refresher program tuition assistance' },
  { label: 'WIOA ITA', text: 'WIOA individual training account for workforce certification' },
  { label: 'voc rehab', text: 'Vocational rehabilitation help for professional license reinstatement' },
  { label: 'HRSA nurse', text: 'HRSA Nurse Corps scholarship for healthcare workforce re-entry' },
  { label: 'CPEP physician', text: 'CPEP physician remediation program funding assistance' },
]

for (const { label, text } of CE_QUERIES) {
  test(`PD intent detected for ${label}`, () => {
    const intent = detectProfessionalDevelopmentIntent({ freeText: text, searchTerms: [text] })
    assert.equal(intent.active, true, `expected PD intent for: ${text}`)
  })
}

test('PROBE acceptance: curated scoring yields multiple strong matches and no SSI', () => {
  const expanded = expandNeed(PROBE_QUERY)
  assert.ok(expanded)
  const curated = loadCuratedProfessionalDevelopmentPrograms('OH')
  const scored = curated
    .map((opp) => {
      const cats = JSON.parse(opp.categories || '[]')
      const needScore = scoreNeedMatch(
        { name: opp.title, description: opp.description, categories: cats },
        expanded,
      )
      return { ...opp, match_score: needScore?.score ?? 0 }
    })
    .filter((o) => o.match_score >= 50)
    .sort((a, b) => b.match_score - a.match_score)

  assert.ok(scored.length >= 10, `expected >= 10 qualified curated matches, got ${scored.length}`)
  assert.ok(scored.filter((o) => o.match_score >= 70).length >= 3, 'expected >= 3 matches at 70%+')

  const intent = detectProfessionalDevelopmentIntent({ freeText: PROBE_QUERY, searchTerms: [PROBE_QUERY] })
  const policyApplied = applyProfessionalDevelopmentQueryPolicy(scored, intent)
  assert.ok(
    !policyApplied.some((o) =>
      /\b(ssi|supplemental security income)\b/i.test(`${o.title} ${o.description}`),
    ),
    'PD policy must not leave explicit SSI / income-support programs in results',
  )
})

test('scoreNeedMatch penalizes SSI for license reinstatement need', () => {
  const expanded = expandNeed(PROBE_QUERY)
  const ssiScore = scoreNeedMatch(
    { name: 'SSI (Supplemental Security Income)', description: 'Monthly cash assistance', categories: ['cash_assistance', 'disability'] },
    expanded,
  )
  const wioaScore = scoreNeedMatch(
    { name: 'WIOA Reinstatement ITA', description: 'PROBE ethics and license reinstatement tuition', categories: ['license_reinstatement_support', 'workforce_reentry_training'] },
    expanded,
  )
  assert.ok((ssiScore?.score ?? 100) < 25)
  assert.ok((wioaScore?.score ?? 0) > (ssiScore?.score ?? 0))
})
