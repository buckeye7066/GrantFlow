import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectReadinessPlan, renderProjectPlanDocument } from '../projectReadinessPlan.js';

test('food truck plan uses parsed profile documents without assuming veteran status', () => {
  const plan = buildProjectReadinessPlan({
    id: 'food-truck-wv',
    profile_type: 'individual',
    display_name: 'Mountain Route Kitchen',
    location: { city: 'Charleston', state: 'WV' },
    description: 'Wants to start a mobile food business.',
    documents: [
      {
        id: 'doc-1',
        name: 'permit-screenshot.png',
        mime_type: 'image/png',
        processing_status: 'completed',
        extracted_text: 'Active duty service member. Food truck startup notes: health permit, commissary agreement, generator, refrigeration, POS.',
      },
    ],
  });

  assert.equal(plan.plan_id, 'food_truck_startup');
  assert.ok(plan.military_statuses.includes('active_duty'));
  assert.ok(!plan.military_statuses.includes('veteran'));
  assert.equal(plan.document_evidence.length, 1);
  assert.equal(plan.checklist.find((item) => item.id === 'business_location')?.status, 'known');
  assert.equal(plan.checklist.find((item) => item.id === 'permits_licenses')?.status, 'known');
  assert.equal(plan.checklist.find((item) => item.id === 'truck_equipment')?.status, 'known');
  assert.ok(plan.interview_questions.some((q) => q.id === 'business_identity'), 'missing legal structure should still be asked');
  assert.ok(
    plan.interview_questions.some((q) => q.id === 'military_status_precision'),
    'a person-side fuzzy military signal still needs the status-precision question',
  );
  // A PERSON starting a business keeps person-side document asks — the org
  // gate must key off the declared side, not "needs a tax id".
  assert.ok(
    plan.checklist.some((x) => x.id === 'military_verification_upload'),
    'an active-duty individual keeps the military proof upload ask',
  );
  assert.ok(plan.checklist.some((x) => x.id === 'official_identity_upload'));
});

test('business plan asks for official uploads instead of typed sensitive identifiers', () => {
  const plan = buildProjectReadinessPlan({
    id: 'food-truck-docs',
    profile_type: 'business',
    display_name: 'River Road Tacos LLC',
    description: 'Launching a food truck and applying for startup funding.',
    sections: [
      {
        section_key: 'small_business_details',
        data: {
          business_name: 'River Road Tacos LLC',
          legal_structure: 'LLC',
          equipment_needed: 'truck, refrigeration, generator',
        },
      },
    ],
    documents: [
      {
        id: 'doc-license',
        name: 'business-license.pdf',
        mime_type: 'application/pdf',
        processing_status: 'completed',
        extracted_text: 'Business license and vendor permit for River Road Tacos LLC.',
      },
    ],
  });

  const taxDoc = plan.checklist.find((item) => item.id === 'tax_identifier_document_upload');
  const businessDocs = plan.checklist.find((item) => item.id === 'business_formation_documents_upload');

  assert.ok(taxDoc, 'business/startup plans should request tax or registration proof uploads');
  assert.match(taxDoc.question, /upload/i);
  assert.doesNotMatch(taxDoc.question, /type .*tax|enter .*tax|paste .*tax/i);
  assert.ok(businessDocs, 'business/startup plans should request formation/license/quote uploads');
  assert.equal(businessDocs.status, 'known');
});

test('student plan includes work-study and campus job portal readiness', () => {
  const plan = buildProjectReadinessPlan({
    id: 'student-osu',
    profile_type: 'student',
    sections: [
      { section_key: 'education', data: { school_name: 'Ohio State University', field_of_study: 'nursing' } },
      { section_key: 'financial_aid', data: { fafsa_status: 'submitted', work_study_interest: true } },
    ],
  });

  assert.equal(plan.plan_id, 'student_portal_plan');
  const workStudy = plan.checklist.find((item) => item.id === 'work_study_jobs');
  assert.ok(workStudy, 'work-study checklist item should exist');
  assert.equal(workStudy.status, 'known');
  assert.match(workStudy.question, /campus job portal/i);
  assert.ok(plan.checklist.some((item) => item.id === 'school_portals'));
  assert.ok(plan.checklist.some((item) => item.id === 'student_official_records_upload'));
});

test('professional practice startup does not inherit food-truck language', () => {
  const plan = buildProjectReadinessPlan({
    id: 'attorney-nd',
    profile_type: 'attorney_practice',
    display_name: 'Prairie Counsel',
    description: 'Attorney opening a solo legal practice in North Dakota and needing startup support.',
    sections: [
      {
        section_key: 'professional_details',
        data: { practice_area: 'estate planning and small business counsel', license_status: 'licensed in ND' },
      },
      {
        section_key: 'financial_information',
        data: { funding_needed: '$18,000 for software, insurance, filing, and office setup' },
      },
    ],
  });

  assert.equal(plan.plan_id, 'professional_practice_startup');
  assert.ok(plan.checklist.some((item) => item.id === 'practice_identity'));
  const rendered = renderProjectPlanDocument(plan).toLowerCase();
  assert.doesNotMatch(rendered, /food truck|mobile food|commissary|food handler/);
});

test('farmer plan asks agriculture-specific questions without penalizing missing FSA fields', () => {
  const plan = buildProjectReadinessPlan({
    id: 'farmer-ia',
    profile_type: 'farmer',
    display_name: 'Iowa Beginning Farmer',
    description: 'Beginning farmer seeking equipment and conservation support.',
    sections: [
      { section_key: 'farm_details', data: { operation_type: 'specialty crop', equipment_needed: 'high tunnel and irrigation' } },
    ],
  });

  assert.equal(plan.plan_id, 'farm_operation_plan');
  assert.ok(plan.checklist.some((item) => item.id === 'usda_fsa_status'));
  assert.ok(plan.interview_questions.some((q) => q.id === 'usda_fsa_status'));
  assert.equal(plan.checklist.find((item) => item.id === 'farm_equipment_inputs')?.status, 'known');
});

test('health support plan keeps clinical studies relevant and opt-in', () => {
  const plan = buildProjectReadinessPlan({
    id: 'patient-sc',
    profile_type: 'breast_cancer_patient',
    display_name: 'South Carolina patient',
    description: 'Stage 4 breast cancer patient needing help with medical bills, prescriptions, rent, and transportation.',
  });

  assert.equal(plan.plan_id, 'benefits_and_care_plan');
  const studies = plan.checklist.find((item) => item.id === 'research_studies_preference');
  assert.ok(studies, 'health/cancer profiles should ask whether studies are wanted');
  assert.match(studies.question, /optional lane/i);
  assert.match(studies.hamilton_action, /Do not enroll/i);
});

test('campaign profile is routed to compliance resources, not ordinary grant language', () => {
  const plan = buildProjectReadinessPlan({
    id: 'candidate-pa',
    profile_type: 'politician',
    display_name: 'Local council campaign',
    description: 'Candidate in Pennsylvania running for a local election.',
  });

  assert.equal(plan.plan_id, 'campaign_compliance_plan');
  assert.ok(plan.checklist.some((item) => item.id === 'campaign_committee'));
  const rendered = renderProjectPlanDocument(plan).toLowerCase();
  assert.match(rendered, /do not treat campaign contributions as grants/);
});

test('student mentioning a school "election"/"campaign" is NOT classified as a political campaign', () => {
  // Regression: Anya asked a student (Anastasia) about political campaign committee
  // and campaign-finance filings. Root cause: the bare need words 'campaign'/'election'
  // in a free-text blob flagged 'campaign', and detectArchetype short-circuited to
  // campaign_compliance_plan on that need keyword alone. A stray theme word must never
  // reclassify a declared student/individual into election-law filing questions.
  const plan = buildProjectReadinessPlan({
    id: 'student-council-election',
    profile_type: 'college_student',
    display_name: 'Anastasia',
    description: 'Ran a student council election campaign and needs help with tuition and scholarships.',
    sections: [
      { section_key: 'education', data: { committed_college: 'Middle Tennessee State University' } },
    ],
  });

  assert.notEqual(plan.plan_id, 'campaign_compliance_plan');
  assert.equal(plan.plan_id, 'student_portal_plan');
  assert.ok(
    !plan.checklist.some((item) => item.id === 'campaign_committee'),
    'must not ask about a campaign committee/treasurer',
  );
  assert.ok(
    !plan.interview_questions.some((q) => /campaign|committee|treasurer|election/i.test(q.prompt)),
    'no campaign-finance filing questions for a student',
  );
});

test('individual with education history is NOT classified as a student plan', () => {
  // Regression: an Individual profile was getting the student_portal_plan (FAFSA /
  // college / work-study content) merely because an education section had data —
  // almost everyone has education history. Explicit non-student person types must
  // require an explicit student signal, not section presence.
  const plan = buildProjectReadinessPlan({
    id: 'individual-edu-history',
    profile_type: 'individual',
    display_name: 'QA Individual',
    description: 'An individual seeking general funding support.',
    sections: [
      { section_key: 'education', data: { highest_level: 'high_school_diploma', school_name: 'Central High (2008)' } },
    ],
  });

  assert.notEqual(plan.plan_id, 'student_portal_plan');
  const rendered = renderProjectPlanDocument(plan);
  assert.doesNotMatch(rendered, /Student funding and portal action plan/);
});

test('organization with education-shaped section data is NOT classified as a student plan', () => {
  // Regression: Focus Forward Ministries (primary_type 'organization', which
  // profileIntelligence.js maps to the 'nonprofit' applicant bucket) got the
  // "Student funding and portal action plan" (FAFSA / college / work-study
  // questions) merely because it had an education/university_applications
  // section with data. Any org-bucketed profile must never be inferred as a
  // student from section presence alone, the same way explicit non-student
  // person types already are.
  const plan = buildProjectReadinessPlan({
    id: 'focus-forward-ministries',
    profile_type: 'organization',
    display_name: 'Focus Forward Ministries',
    description: 'Faith-based ministry seeking program funding.',
    sections: [
      { section_key: 'education', data: { school_name: 'Community partner university' } },
      { section_key: 'university_applications', data: { applications: [{ school: 'Community partner university' }] } },
    ],
  });

  assert.notEqual(plan.plan_id, 'student_portal_plan');
  const rendered = renderProjectPlanDocument(plan);
  assert.doesNotMatch(rendered, /Student funding and portal action plan/);
});

test('explicit student type still gets the student plan', () => {
  const plan = buildProjectReadinessPlan({
    id: 'student-still-works',
    profile_type: 'college_student',
    sections: [{ section_key: 'education', data: { school_name: 'State U' } }],
  });
  assert.equal(plan.plan_id, 'student_portal_plan');
});

test('ministry whose documents mention veterans gets ONLY org-applicable questions', () => {
  // Regression (Focus Forward Ministry): the project-readiness interview queued
  // "Which military status should GrantFlow use?", a DD-214/VA upload request,
  // a personal photo-ID upload, and personal income-proof uploads for a MINISTRY
  // whose documents merely said it SERVES veterans and families needing food and
  // housing help. Anya must only ask profile-specific, match-boosting questions.
  const plan = buildProjectReadinessPlan({
    id: 'focus-forward-ministry',
    profile_type: 'ministry',
    display_name: 'Focus Forward Ministry',
    description: 'Faith-based ministry building a community recreation facility and expanding outreach infrastructure.',
    sections: [
      { section_key: 'basic_information', data: { state: 'TN', county: 'Bradley' } },
    ],
    documents: [
      {
        id: 'doc-outreach',
        name: 'outreach-flyer.pdf',
        mime_type: 'application/pdf',
        processing_status: 'completed',
        extracted_text: 'Our ministry serves veterans, military spouses, and seniors in Bradley County with food, rent, and utility help.',
      },
    ],
  });

  // "Serves veterans" is who the org HELPS, not what it IS.
  assert.deepEqual(plan.military_statuses, []);

  const ids = new Set([
    ...plan.checklist.map((x) => x.id),
    ...plan.interview_questions.map((q) => q.id),
  ]);
  for (const personOnly of [
    'military_status_precision',
    'military_verification_upload',
    'military_context',
    'official_identity_upload',
    'income_benefit_proof_upload',
  ]) {
    assert.ok(!ids.has(personOnly), `org profile must not carry person-only item "${personOnly}"`);
  }

  // A declared ministry outranks "infrastructure"/"recreation" need keywords —
  // it gets the nonprofit plan, not public-agency SAM.gov/jurisdiction questions.
  assert.equal(plan.plan_id, 'nonprofit_program_plan');

  // Org-appropriate document asks survive.
  assert.ok(plan.checklist.some((x) => x.id === 'tax_identifier_document_upload'));
  assert.ok(plan.checklist.some((x) => x.id === 'organization_governance_upload'));
});

test('declared public agency still gets the public-agency plan (and no personal-ID ask)', () => {
  const plan = buildProjectReadinessPlan({
    id: 'county-parks',
    profile_type: 'county_government',
    display_name: 'Bradley County Parks',
    description: 'County parks department seeking recreation infrastructure funding.',
  });
  assert.equal(plan.plan_id, 'public_agency_project_plan');
  assert.ok(!plan.checklist.some((x) => x.id === 'official_identity_upload'));
  assert.ok(!plan.interview_questions.some((q) => q.id === 'military_status_precision'));
});

test('food-truck profile with NO military signal is never asked a military-status question', () => {
  // Regression: militaryInterviewQuestions fired unconditionally for every
  // food_truck_startup archetype, and the military_context checklist item was
  // unconditional — both queued military questions with zero military signal.
  const plan = buildProjectReadinessPlan({
    id: 'food-truck-plain',
    profile_type: 'individual',
    display_name: 'Plain Tacos',
    description: 'Wants to start a food truck business selling tacos.',
  });
  assert.equal(plan.plan_id, 'food_truck_startup');
  assert.deepEqual(plan.military_statuses, []);
  assert.ok(!plan.checklist.some((x) => x.id === 'military_context'));
  assert.ok(!plan.interview_questions.some((q) => q.id === 'military_status_precision'));
});

test('explicit military_service.status suppresses the precision re-ask; proof upload still requested', () => {
  const plan = buildProjectReadinessPlan({
    id: 'vet-explicit',
    profile_type: 'veteran',
    description: 'Veteran seeking help with housing costs.',
    sections: [{ section_key: 'military_service', data: { status: 'veteran' } }],
  });
  assert.ok(plan.military_statuses.includes('veteran'));
  assert.ok(
    !plan.interview_questions.some((q) => q.id === 'military_status_precision'),
    'an explicitly stored military_service.status must never be re-asked',
  );
  // The DD-214/VA proof UPLOAD is still a valid ask — proof of a fact is not the fact.
  assert.ok(plan.checklist.some((x) => x.id === 'military_verification_upload'));
});

test('empty profile becomes an Anya interview, not a penalty or crash', () => {
  const plan = buildProjectReadinessPlan({ id: 'empty-profile' });

  assert.equal(plan.plan_id, 'general_funding_readiness');
  assert.ok(Array.isArray(plan.checklist));
  assert.ok(plan.checklist.length > 0);
  assert.ok(plan.interview_questions.length > 0);
  assert.ok(plan.interview_questions.every((q) => q.prompt && q.why));

  const rendered = renderProjectPlanDocument(plan);
  assert.match(rendered, /Anya interview/);
  assert.match(rendered, /Hamilton guardrails/);
});
