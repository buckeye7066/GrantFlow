import test from 'node:test'
import assert from 'node:assert/strict'

import {
  determineClientCategory,
  recommendServices,
} from '../../backend/services/pricing/pricingRules.js'
import { SERVICE_KEYS } from '../../backend/services/pricing/pricingTypes.js'

test('individual / family / student profile types are always Individual', () => {
  for (const t of ['individual', 'family', 'student']) {
    const r = determineClientCategory({ profile: { primary_type: t } })
    assert.equal(r.client_category, 'individual')
    assert.equal(r.confidence, 'high')
  }
})

test('organization with annual budget under $250k → Small Org', () => {
  const r = determineClientCategory({
    profile: { primary_type: 'nonprofit' },
    organization: { annual_budget: 200000 },
  })
  assert.equal(r.client_category, 'small')
  assert.equal(r.confidence, 'high')
})

test('organization with annual budget $250k-$2M → Mid-Size', () => {
  const r = determineClientCategory({
    profile: { primary_type: 'church' },
    organization: { annual_budget: 1500000 },
  })
  assert.equal(r.client_category, 'mid_size')
  assert.equal(r.confidence, 'high')
})

test('organization with annual budget over $2M → Large Org', () => {
  const r = determineClientCategory({
    profile: { primary_type: 'school' },
    organization: { annual_budget: 5000000 },
  })
  assert.equal(r.client_category, 'large')
  assert.equal(r.confidence, 'high')
})

test('unknown org budget defaults to Small with needs_admin_review', () => {
  const r = determineClientCategory({
    profile: { primary_type: 'small_business' },
  })
  assert.equal(r.client_category, 'small')
  assert.ok(['estimated', 'needs_admin_review'].includes(r.confidence), `got ${r.confidence}`)
  assert.ok(r.missing_fields.includes('annual_budget'))
})

test('unknown org budget but small/local signal → Small with estimated confidence', () => {
  const r = determineClientCategory({
    profile: { primary_type: 'church', city: 'Springfield' },
    organization: { staff_count: 6 },
  })
  assert.equal(r.client_category, 'small')
  assert.equal(r.confidence, 'estimated')
})

test('parses currency strings ("$150,000") for annual_budget', () => {
  const r = determineClientCategory({
    profile: { primary_type: 'nonprofit' },
    intakeAnswers: { annual_budget: '$150,000' },
  })
  assert.equal(r.client_category, 'small')
})

// ── Service recommendation ──────────────────────────────────────────────────

test('research-only intent → Quick Eligibility Scan', () => {
  const r = recommendServices({
    clientCategory: 'individual',
    intakeAnswers: { wants_research_only: true },
    matches: [],
  })
  const keys = r.line_items.map((li) => li.service_key)
  assert.ok(keys.includes(SERVICE_KEYS.QUICK_ELIGIBILITY_SCAN))
})

test('research-only with broad landscape → Comprehensive Funding Dossier', () => {
  const r = recommendServices({
    clientCategory: 'small',
    intakeAnswers: { wants_research_only: true, broad_landscape: true },
    matches: Array.from({ length: 12 }, (_, i) => ({ id: i, match_score: 0.4 })),
  })
  const keys = r.line_items.map((li) => li.service_key)
  assert.ok(keys.includes(SERVICE_KEYS.COMPREHENSIVE_FUNDING_DOSSIER))
})

test('application help under $5k → Micro-Grant Application', () => {
  const r = recommendServices({
    clientCategory: 'individual',
    intakeAnswers: { wants_application_help: true, amount_requested: 2500 },
  })
  const keys = r.line_items.map((li) => li.service_key)
  assert.ok(keys.includes(SERVICE_KEYS.MICRO_GRANT_APPLICATION))
})

test('application help $5k-$250k → Standard Foundation Application', () => {
  const r = recommendServices({
    clientCategory: 'small',
    intakeAnswers: { wants_application_help: true, amount_requested: 75000 },
  })
  const keys = r.line_items.map((li) => li.service_key)
  assert.ok(keys.includes(SERVICE_KEYS.STANDARD_FOUNDATION_APPLICATION))
})

test('application help over $250k → Complex/Federal Application', () => {
  const r = recommendServices({
    clientCategory: 'mid_size',
    intakeAnswers: { wants_application_help: true, amount_requested: 500000 },
  })
  const keys = r.line_items.map((li) => li.service_key)
  assert.ok(keys.includes(SERVICE_KEYS.COMPLEX_FEDERAL_APPLICATION))
})

test('federal signals in matches → Complex/Federal Application', () => {
  const r = recommendServices({
    clientCategory: 'small',
    intakeAnswers: { wants_application_help: true, amount_requested: 90000 },
    matches: [{ title: 'USDA Rural Grant', source: 'grants.gov', match_score: 0.8 }],
  })
  const keys = r.line_items.map((li) => li.service_key)
  assert.ok(keys.includes(SERVICE_KEYS.COMPLEX_FEDERAL_APPLICATION))
})

test('student transfer scholarship signal → Transfer Scholarship Pack', () => {
  const r = recommendServices({
    clientCategory: 'individual',
    profile: { primary_type: 'student' },
    intakeAnswers: { is_transfer_student: true },
  })
  const keys = r.line_items.map((li) => li.service_key)
  assert.ok(keys.includes(SERVICE_KEYS.TRANSFER_SCHOLARSHIP_PACK))
})

test('existing draft → Editing & Redraft Service', () => {
  const r = recommendServices({
    clientCategory: 'small',
    intakeAnswers: { has_draft: true },
  })
  const keys = r.line_items.map((li) => li.service_key)
  assert.ok(keys.includes(SERVICE_KEYS.EDITING_REDRAFT))
})

test('budget/logic-model gap → Budget & Logic Model Development', () => {
  const r = recommendServices({
    clientCategory: 'small',
    intakeAnswers: { needs_budget: true, needs_logic_model: true },
  })
  const keys = r.line_items.map((li) => li.service_key)
  assert.ok(keys.includes(SERVICE_KEYS.BUDGET_LOGIC_MODEL))
})

test('many matches or wants_calendar → Grant Calendar', () => {
  const r = recommendServices({
    clientCategory: 'small',
    matches: Array.from({ length: 4 }, (_, i) => ({ id: i, match_score: 0.6 })),
  })
  const keys = r.line_items.map((li) => li.service_key)
  assert.ok(keys.includes(SERVICE_KEYS.GRANT_CALENDAR))
})

test('post-award user → Compliance Reporting & Management', () => {
  const r = recommendServices({
    clientCategory: 'small',
    intakeAnswers: { already_funded: true, needs_compliance_reporting: true },
  })
  const keys = r.line_items.map((li) => li.service_key)
  assert.ok(keys.includes(SERVICE_KEYS.COMPLIANCE_REPORTING))
})

test('unclear scope → Hourly Consultation + admin review flagged', () => {
  const r = recommendServices({ clientCategory: 'small', intakeAnswers: {} })
  const keys = r.line_items.map((li) => li.service_key)
  assert.ok(keys.includes(SERVICE_KEYS.HOURLY_CONSULTATION))
  assert.equal(r.admin_review_required, true)
})

test('application help with no amount → flagged for admin review + missing input', () => {
  const r = recommendServices({
    clientCategory: 'small',
    intakeAnswers: { wants_application_help: true },
  })
  assert.equal(r.admin_review_required, true)
  assert.ok(r.missing_pricing_inputs.includes('amount_requested'))
})
