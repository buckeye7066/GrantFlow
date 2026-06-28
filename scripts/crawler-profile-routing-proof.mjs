#!/usr/bin/env node
/**
 * Crawler profile-routing proof.
 *
 * This is the evidence gate for the owner's core concern:
 * "different profiles must not receive the same generic crawler returns."
 *
 * It is deterministic and offline. It is NOT a live web-crawl proof and must
 * never be described as one. It proves that Crawler OS:
 * - reads rich and sparse profile fields;
 * - derives applicant/need language without penalizing empty fields;
 * - selects different source sets for different profile types;
 * - only counts expected sources when a real adapter exists;
 * - keeps sensitive identifiers out of crawler-facing output;
 * - gives Anya/Hamilton a profile-aware action plan, including document uploads.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  buildCrawlerQueries,
  buildProjectReadinessPlan,
  buildThesis,
  getAdapter,
  getSource,
  plan,
} from '../backend/crawler-os/index.js'
import { GOLDEN_PROFILES } from '../tests/fixtures/goldenProfiles.mjs'

const WRITE_REPORT = process.argv.includes('--write')

const UNIVERSAL_CASES = [
  {
    name: 'farmer from Iowa',
    profile: {
      id: 'proof-farmer-ia',
      profile_type: 'farmer',
      location: { state: 'IA' },
      needs: ['farm equipment', 'agriculture operations'],
    },
    applicantTypes: ['farm'],
    needs: ['agriculture', 'equipment', 'operations'],
    selectedSources: ['usda_rd', 'sba_grants'],
    planId: 'farm_operation_plan',
    noStudyLane: true,
  },
  {
    name: 'local political candidate in Pennsylvania',
    profile: {
      id: 'proof-candidate-pa',
      profile_type: 'political_candidate',
      location: { state: 'PA' },
      needs: ['campaign finance compliance', 'campaign operations'],
    },
    applicantTypes: ['candidate'],
    needs: ['campaign', 'operations'],
    selectedSources: ['fec_candidate_resources', 'pa_campaign_finance'],
    notSelectedSources: ['grants_gov'],
    planId: 'campaign_compliance_plan',
    noStudyLane: true,
    minSources: 2,
  },
  {
    name: 'county parks summer baseball program in Oregon',
    profile: {
      id: 'proof-parks-or',
      profile_type: 'county_parks_recreation',
      location: { state: 'OR' },
      mission: 'summer public baseball program through county parks and recreation',
      needs: ['recreation equipment', 'youth sports program support'],
    },
    applicantTypes: ['government'],
    needs: ['recreation', 'equipment', 'programs'],
    selectedSources: ['oregon_parks_rec_grants', 'grants_gov'],
    planId: 'public_agency_project_plan',
    noStudyLane: true,
  },
  {
    name: 'volunteer fire department in Arizona',
    profile: {
      id: 'proof-vfd-az',
      profile_type: 'volunteer_fire_department',
      location: { state: 'AZ' },
      needs: ['turnout gear', 'public safety equipment', 'emergency response'],
    },
    applicantTypes: ['vfd', 'government'],
    needs: ['equipment', 'public_safety', 'emergency'],
    selectedSources: ['fema_afg', 'dhs_grants', 'cops_grants'],
    planId: 'public_agency_project_plan',
    noStudyLane: true,
  },
  {
    name: 'United States Border Patrol',
    profile: {
      id: 'proof-border-patrol',
      profile_type: 'border_patrol',
      location: { state: 'TX' },
      needs: ['public safety technology', 'law enforcement equipment'],
    },
    applicantTypes: ['law_enforcement', 'government'],
    needs: ['public_safety', 'technology', 'equipment'],
    selectedSources: ['dhs_grants', 'doj_grants', 'cops_grants'],
    planId: 'public_agency_project_plan',
    noStudyLane: true,
  },
  {
    name: 'minister of a small church in Florida',
    profile: {
      id: 'proof-minister-fl',
      profile_type: 'minister',
      location: { state: 'FL' },
      mission: 'small church ministry serving families',
      needs: ['program support', 'building repair'],
    },
    applicantTypes: ['church', 'ministry', 'nonprofit'],
    needs: ['programs'],
    selectedSources: ['grants_gov', 'cof_locator'],
    planId: 'nonprofit_program_plan',
    noStudyLane: true,
  },
  {
    name: 'single mom needing rent utility and food help in Maine',
    profile: {
      id: 'proof-single-mom-me',
      profile_type: 'single_mom',
      location: { state: 'ME' },
      needs: ['rent help', 'utility assistance', 'food support'],
    },
    applicantTypes: ['family', 'individual'],
    needs: ['housing', 'energy', 'food'],
    selectedSources: ['benefits_gov', 'united_way_211'],
    planId: 'benefits_and_care_plan',
    noStudyLane: true,
  },
  {
    name: 'school teacher needing classroom funding in Missouri',
    profile: {
      id: 'proof-teacher-mo',
      profile_type: 'classroom_teacher',
      location: { state: 'MO' },
      needs: ['classroom supplies', 'books', 'technology'],
    },
    applicantTypes: ['teacher', 'individual'],
    needs: ['education', 'technology'],
    selectedSources: ['donorschoose'],
    planId: 'classroom_project_plan',
    noStudyLane: true,
  },
  {
    name: 'attorney practice in North Dakota',
    profile: {
      id: 'proof-attorney-nd',
      profile_type: 'attorney_practice',
      location: { state: 'ND' },
      needs: ['law practice operations', 'legal technology'],
    },
    applicantTypes: ['business'],
    needs: ['legal', 'operations', 'technology'],
    selectedSources: ['sba_grants'],
    planId: 'professional_practice_startup',
    noStudyLane: true,
  },
  {
    name: 'Indian Tribe on a reservation in South Dakota',
    profile: {
      id: 'proof-tribe-sd',
      profile_type: 'indian_tribe',
      location: { state: 'SD' },
      needs: ['tribal public safety', 'agriculture', 'community programs'],
    },
    applicantTypes: ['tribal', 'government'],
    needs: ['public_safety', 'agriculture', 'programs'],
    selectedSources: ['ana_grants', 'dhs_grants', 'doj_grants'],
    planId: 'tribal_government_plan',
    noStudyLane: true,
  },
  {
    name: 'stage 4 breast cancer patient in South Carolina',
    profile: {
      id: 'proof-cancer-sc',
      profile_type: 'breast_cancer_patient',
      location: { state: 'SC' },
      needs: ['stage 4 breast cancer treatment', 'rent help', 'utility assistance', 'food'],
    },
    applicantTypes: ['individual'],
    needs: ['medical', 'housing', 'energy', 'food'],
    selectedSources: ['cancer_care', 'benefits_gov', 'united_way_211'],
    planId: 'benefits_and_care_plan',
    studyLane: true,
  },
  {
    name: 'coal miner widow in Kentucky with dementia',
    profile: {
      id: 'proof-miner-widow-ky',
      profile_type: 'coal_miner_widow',
      location: { state: 'KY' },
      description: 'Coal miner widow in Kentucky with dementia who needs local support.',
      needs: ['black lung survivor benefits', 'dementia care', 'food assistance'],
    },
    applicantTypes: ['family', 'individual'],
    needs: ['black_lung_benefits', 'survivor_benefits', 'dementia_support', 'caregiving', 'medical', 'food'],
    selectedSources: ['dol_black_lung_benefits', 'ssa_survivors', 'alzheimers_gov_services', 'kynect_benefits'],
    notSelectedSources: ['cancer_care'],
    planId: 'benefits_and_care_plan',
    studyLane: true,
  },
  {
    name: 'military-background individual starting a food truck in West Virginia',
    profile: {
      id: 'proof-food-truck-wv',
      profile_type: 'individual',
      location: { state: 'WV' },
      description: 'Single guy with a military background wants to start a food truck in West Virginia.',
      needs: ['food truck startup', 'kitchen equipment', 'working capital'],
    },
    applicantTypes: ['individual'],
    needs: ['startup', 'equipment', 'capital'],
    selectedSources: ['wv_business_funding_resources', 'wv_sbdc_funding'],
    notNeeds: ['food', 'veterans', 'veteran_startup', 'military_startup'],
    notApplicantTypes: ['veteran', 'active_duty'],
    notSelectedSources: [
      'benefits_gov',
      'united_way_211',
      'military_onesource',
      'sba_boots_to_business',
      'sba_veteran_business',
      'sba_vboc',
    ],
    planId: 'food_truck_startup',
    noStudyLane: true,
  },
  {
    name: 'active duty service member starting a food truck in West Virginia',
    profile: {
      id: 'proof-active-duty-food-truck-wv',
      profile_type: 'individual',
      location: { state: 'WV' },
      description: 'Active duty service member wants to start a food truck in West Virginia.',
      needs: ['food truck startup', 'kitchen equipment', 'working capital'],
      sections: [{ section_key: 'military_service', data: { status: 'active duty', branch: 'Army' } }],
    },
    applicantTypes: ['active_duty', 'individual'],
    notApplicantTypes: ['veteran'],
    needs: ['startup', 'equipment', 'capital', 'military_startup', 'active_duty_support'],
    notNeeds: ['veteran_startup'],
    selectedSources: ['military_onesource', 'sba_boots_to_business', 'sba_veteran_business', 'sba_vboc'],
    planId: 'food_truck_startup',
    noStudyLane: true,
  },
  {
    name: 'veteran entrepreneur starting a food truck in West Virginia',
    profile: {
      id: 'proof-veteran-food-truck-wv',
      profile_type: 'veteran_entrepreneur',
      location: { state: 'WV' },
      description: 'Prior service veteran wants to start a food truck in West Virginia.',
      needs: ['food truck startup', 'kitchen equipment', 'working capital'],
    },
    applicantTypes: ['veteran', 'business', 'individual'],
    notApplicantTypes: ['active_duty'],
    needs: ['startup', 'equipment', 'capital', 'veteran_startup'],
    selectedSources: ['sba_boots_to_business', 'sba_veteran_business', 'sba_vboc', 'wv_sbdc_funding'],
    planId: 'food_truck_startup',
    noStudyLane: true,
  },
  {
    name: 'sparse nonprofit animal shelter',
    profile: {
      id: 'proof-animal-shelter',
      profile_type: 'animal_shelter',
      location: { state: 'OH' },
    },
    applicantTypes: ['nonprofit'],
    needs: ['animal_welfare', 'capacity_building', 'equipment'],
    selectedSources: ['petsmart_charities_grants', 'petco_love_grants', 'aspca_grants', 'cof_locator'],
    planId: 'nonprofit_program_plan',
    sparse: true,
    noStudyLane: true,
  },
  {
    name: 'sparse college student',
    profile: {
      id: 'proof-college-student',
      profile_type: 'college_student',
      location: { state: 'OH' },
    },
    applicantTypes: ['student', 'individual'],
    needs: ['scholarship', 'tuition', 'housing', 'textbooks', 'fafsa', 'pell', 'education'],
    selectedSources: ['pell_grant', 'studentaid_gov', 'benefits_gov'],
    planId: 'student_portal_plan',
    sparse: true,
    noStudyLane: true,
  },
]

const DOCUMENT_RICH_CASES = [
  {
    name: 'document-rich food truck profile',
    profile: {
      id: 'proof-doc-food-truck',
      profile_type: 'veteran_entrepreneur',
      location: { city: 'Charleston', state: 'WV' },
      description: 'Veteran wants to launch a food truck in West Virginia.',
      needs: ['food truck startup', 'kitchen equipment', 'working capital'],
      documents: [
        {
          id: 'doc-pdf-license',
          name: 'Business Registration and Health Permit.pdf',
          type: 'application/pdf',
          processing_status: 'parsed',
          extracted_text: 'Articles of organization, EIN CP 575 letter, business license, health permit, food handler certificate, insurance certificate.',
        },
        {
          id: 'doc-docx-budget',
          name: 'Food Truck Equipment Quotes.docx',
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          processing_status: 'parsed',
          extracted_text: 'Equipment quote for a food truck, generator, refrigeration, POS system, commissary contract, and startup inventory.',
        },
        {
          id: 'doc-screenshot-id',
          name: 'Identity Proof Screenshot.png',
          type: 'image/png',
          processing_status: 'parsed',
          extracted_text: 'Official photo ID uploaded. Driver license image is present but numbers are redacted.',
        },
      ],
    },
    applicantTypes: ['veteran', 'business', 'individual'],
    needs: ['startup', 'equipment', 'capital', 'veteran_startup'],
    selectedSources: ['sba_boots_to_business', 'sba_veteran_business', 'sba_vboc', 'wv_sbdc_funding'],
    planId: 'food_truck_startup',
    documentEvidenceCount: 3,
    knownChecklistIds: [
      'official_identity_upload',
      'tax_identifier_document_upload',
      'business_formation_documents_upload',
    ],
    noStudyLane: true,
  },
]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function goldenCase(fixture) {
  const profile = clone(fixture.profile)
  profile.sections = Object.entries(fixture.sections ?? {}).map(([section_key, data]) => ({ section_key, data }))
  return {
    name: `golden profile: ${fixture.name}`,
    profile,
    piiTokens: fixture.expectations?.piiTokensThatMustNeverLeak ?? [],
    minSources: fixture.expectations?.mustHaveDirectSource === false ? 2 : 3,
  }
}

function fail(failures, name, message, details = {}) {
  failures.push({ profile: name, message, details })
}

function includesAll(actual, expected) {
  const set = new Set(actual ?? [])
  return (expected ?? []).filter((item) => !set.has(item))
}

function buildQueries(thesis, selectedSourceIds) {
  const rows = []
  for (const sourceId of selectedSourceIds) {
    const source = getSource(sourceId) ?? { source_id: sourceId }
    const queries = buildCrawlerQueries(thesis, source, { limit: 5 })
    rows.push(...queries.map((query) => ({ source_id: sourceId, query })))
  }
  return rows
}

function summarizeDecisionReasons(sourcePlan) {
  const counts = {}
  for (const decision of sourcePlan.source_decisions ?? []) {
    for (const reason of decision.reasons ?? []) {
      counts[reason] = (counts[reason] ?? 0) + 1
    }
  }
  return counts
}

function profileSpecificQueryExists(queries, thesis) {
  const tokens = [...(thesis.needs ?? []), ...(thesis.applicant_types ?? [])]
    .map((token) => String(token).replace(/_/g, ' ').toLowerCase())
    .filter(Boolean)
  return queries.some((row) => {
    const text = String(row.query ?? '').toLowerCase()
    return tokens.some((token) => text.includes(token))
  })
}

function assertNoPii(caseDef, artifacts, failures) {
  const tokens = caseDef.piiTokens ?? []
  if (!tokens.length) return
  const serialized = JSON.stringify(artifacts).toLowerCase()
  for (const token of tokens) {
    if (serialized.includes(String(token).toLowerCase())) {
      fail(failures, caseDef.name, 'sensitive identifier leaked into crawler-facing output', { token })
    }
  }
}

function assessCase(caseDef) {
  const failures = []
  const thesis = buildThesis(caseDef.profile)
  const sourcePlan = plan(thesis)
  const selectedSourceIds = sourcePlan.selected_source_ids ?? []
  const queries = buildQueries(thesis, selectedSourceIds)
  const readinessPlan = buildProjectReadinessPlan(caseDef.profile)
  const checklist = readinessPlan.checklist ?? []
  const checklistById = new Map(checklist.map((item) => [item.id, item]))

  for (const applicantType of caseDef.applicantTypes ?? []) {
    if (!thesis.applicant_types.includes(applicantType)) {
      fail(failures, caseDef.name, 'missing applicant type', {
        applicantType,
        actual: thesis.applicant_types,
      })
    }
  }
  for (const applicantType of caseDef.notApplicantTypes ?? []) {
    if (thesis.applicant_types.includes(applicantType)) {
      fail(failures, caseDef.name, 'forbidden applicant type was inferred', {
        applicantType,
        actual: thesis.applicant_types,
      })
    }
  }
  for (const need of caseDef.needs ?? []) {
    if (!thesis.needs.includes(need)) {
      fail(failures, caseDef.name, 'missing need signal', { need, actual: thesis.needs })
    }
  }
  for (const need of caseDef.notNeeds ?? []) {
    if (thesis.needs.includes(need)) {
      fail(failures, caseDef.name, 'forbidden need signal was inferred', { need, actual: thesis.needs })
    }
  }
  for (const sourceId of caseDef.selectedSources ?? []) {
    if (!selectedSourceIds.includes(sourceId)) {
      fail(failures, caseDef.name, 'expected source was not selected', {
        sourceId,
        selected: selectedSourceIds,
      })
    }
    if (!getAdapter(sourceId)) {
      fail(failures, caseDef.name, 'expected source has no implemented adapter', { sourceId })
    }
  }

  const unexplainedDecisions = (sourcePlan.source_decisions ?? []).filter(
    (decision) => !Array.isArray(decision.reasons) || decision.reasons.length === 0,
  )
  if (!(sourcePlan.source_decisions ?? []).length) {
    fail(failures, caseDef.name, 'crawler source plan has no decision log')
  }
  if (unexplainedDecisions.length) {
    fail(failures, caseDef.name, 'crawler source plan has unexplained source decisions', {
      unexplained_source_ids: unexplainedDecisions.map((decision) => decision.source_id),
    })
  }
  for (const sourceId of caseDef.notSelectedSources ?? []) {
    if (selectedSourceIds.includes(sourceId)) {
      fail(failures, caseDef.name, 'forbidden source was selected', {
        sourceId,
        selected: selectedSourceIds,
      })
    }
  }

  const minSources = Number.isFinite(caseDef.minSources) ? caseDef.minSources : 2
  if (selectedSourceIds.length < minSources) {
    fail(failures, caseDef.name, 'too few crawler sources selected', {
      minSources,
      selected: selectedSourceIds,
    })
  }

  if (queries.length > 0 && !profileSpecificQueryExists(queries, thesis)) {
    fail(failures, caseDef.name, 'crawler queries are not profile-specific', { queries, thesis })
  }

  if (caseDef.planId && readinessPlan.plan_id !== caseDef.planId) {
    fail(failures, caseDef.name, 'wrong Anya/Hamilton plan type', {
      expected: caseDef.planId,
      actual: readinessPlan.plan_id,
    })
  }
  if (!checklist.length) {
    fail(failures, caseDef.name, 'Anya/Hamilton checklist is empty')
  }
  if (!checklistById.has('official_identity_upload')) {
    fail(failures, caseDef.name, 'official upload audit-trail prompt is missing')
  }

  const studyItem = checklistById.get('research_studies_preference')
  if (caseDef.studyLane && !studyItem) {
    fail(failures, caseDef.name, 'health/disability study opt-in lane is missing')
  }
  if (caseDef.noStudyLane && studyItem) {
    fail(failures, caseDef.name, 'study lane appeared for a non-health profile')
  }

  if (caseDef.documentEvidenceCount && (readinessPlan.document_evidence ?? []).length < caseDef.documentEvidenceCount) {
    fail(failures, caseDef.name, 'parsed document evidence was not carried into the plan', {
      expectedAtLeast: caseDef.documentEvidenceCount,
      actual: readinessPlan.document_evidence,
    })
  }
  for (const checklistId of caseDef.knownChecklistIds ?? []) {
    const item = checklistById.get(checklistId)
    if (!item || item.status !== 'known') {
      fail(failures, caseDef.name, 'parsed documents did not satisfy expected checklist item', {
        checklistId,
        item,
      })
    }
  }

  assertNoPii(
    caseDef,
    {
      thesis,
      sourcePlan,
      queries,
      readinessPlan: {
        plan_id: readinessPlan.plan_id,
        applicant_types: readinessPlan.applicant_types,
        needs: readinessPlan.needs,
        checklist: checklist.map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          known_value: item.known_value,
        })),
      },
    },
    failures,
  )

  return {
    name: caseDef.name,
    ok: failures.length === 0,
    failures,
    thesis: {
      applicant_types: thesis.applicant_types,
      needs: thesis.needs,
      location: thesis.location,
      keywords: thesis.keywords,
    },
    selected_source_ids: selectedSourceIds,
    adapter_backed_sources: selectedSourceIds.filter((sourceId) => Boolean(getAdapter(sourceId))),
    query_samples: queries.slice(0, 8),
    decision_reason_counts: summarizeDecisionReasons(sourcePlan),
    selected_decisions: (sourcePlan.source_decisions ?? [])
      .filter((decision) => decision.selected)
      .slice(0, 8),
    project_plan: {
      plan_id: readinessPlan.plan_id,
      title: readinessPlan.title,
      checklist_count: checklist.length,
      interview_question_count: readinessPlan.interview_questions?.length ?? 0,
      parsed_document_count: readinessPlan.document_evidence?.length ?? 0,
      has_study_opt_in_lane: Boolean(studyItem),
    },
    signature: selectedSourceIds.slice().sort().join('|'),
  }
}

function assessDiversity(results) {
  const failures = []
  const signatures = new Map()
  for (const result of results) {
    signatures.set(result.signature, (signatures.get(result.signature) ?? 0) + 1)
  }
  const uniqueSignatures = signatures.size
  const requiredUnique = Math.ceil(results.length * 0.65)
  const largestReuse = Math.max(...signatures.values())
  if (uniqueSignatures < requiredUnique) {
    fail(failures, 'profile set', 'too many profiles selected the same source sets', {
      uniqueSignatures,
      requiredUnique,
      totalProfiles: results.length,
      signatures: Object.fromEntries(signatures),
    })
  }
  if (largestReuse > 4) {
    fail(failures, 'profile set', 'one source signature was reused too often', {
      largestReuse,
      signatures: Object.fromEntries(signatures),
    })
  }
  return { uniqueSignatures, requiredUnique, largestReuse, failures }
}

async function writeReport(report) {
  const outDir = path.resolve('docs/_readiness_logs')
  await mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, 'crawler-profile-routing-proof.json')
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`)
}

async function main() {
  const cases = [
    ...GOLDEN_PROFILES.map(goldenCase),
    ...UNIVERSAL_CASES,
    ...DOCUMENT_RICH_CASES,
  ]
  const results = cases.map(assessCase)
  const diversity = assessDiversity(results)
  const failures = [
    ...results.flatMap((result) => result.failures),
    ...diversity.failures,
  ]
  const report = {
    ok: failures.length === 0,
    generated_at: new Date().toISOString(),
    profile_count: results.length,
    unique_source_signatures: diversity.uniqueSignatures,
    required_unique_source_signatures: diversity.requiredUnique,
    largest_signature_reuse: diversity.largestReuse,
    failures,
    results,
  }

  console.log('GrantFlow crawler profile-routing proof')
  console.log('Mode: deterministic/offline code-path proof; not a live crawl or live award lookup.')
  console.log(`Profiles checked: ${report.profile_count}`)
  console.log(`Unique source signatures: ${report.unique_source_signatures}/${report.profile_count}`)
  for (const result of results) {
    const status = result.ok ? 'ok' : 'FAIL'
    console.log(
      `[${status}] ${result.name} -> ${result.project_plan.plan_id}; sources=${result.selected_source_ids.slice(0, 6).join(', ')}`,
    )
  }

  if (WRITE_REPORT) await writeReport(report)

  if (failures.length > 0) {
    console.error('\nCrawler profile-routing proof failed:')
    for (const failure of failures) {
      console.error(`- ${failure.profile}: ${failure.message}`)
    }
    process.exit(1)
  }

  console.log('\nPASS: crawler source planning is profile-aware, diverse, adapter-backed, and Anya/Hamilton-ready.')
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error)
  process.exit(1)
})
