// crawler-os/projectReadinessPlan.js
//
// Profile-aware action planning. Anya uses this to interview the user only for
// missing facts that matter to the profile; Hamilton uses it to prepare the
// checklist/how-to packet. Empty fields become questions, never penalties.

import { buildThesis } from './profileIntelligence.js';

function lc(value) { return String(value ?? '').toLowerCase(); }
function titleCase(value) {
  return String(value ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function sectionRows(profile) {
  const rows = profile?.sections ?? [];
  if (Array.isArray(rows)) return rows;
  if (rows && typeof rows === 'object') {
    return Object.entries(rows).map(([section_key, data]) => ({ section_key, data }));
  }
  return [];
}

function sectionsByKey(profile) {
  const out = {};
  for (const row of sectionRows(profile)) {
    const key = row?.section_key ?? row?.key;
    if (!key) continue;
    out[key] = row?.data && typeof row.data === 'object' ? row.data : {};
  }
  return out;
}

function firstValue(profile, sections, paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let cur = parts[0] === '$' ? profile : sections[parts[0]];
    const rest = parts[0] === '$' ? parts.slice(1) : parts.slice(1);
    for (const p of rest) {
      if (cur == null) break;
      cur = cur[p];
    }
    if (hasValue(cur)) return cur;
  }
  return null;
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function fieldStatus(value) {
  return hasValue(value) ? 'known' : 'ask_anya';
}

function cleanText(value) {
  if (Array.isArray(value)) return value.filter(hasValue).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '').trim();
}

function profileBlob(profile, sections) {
  const parts = [
    profile?.display_name, profile?.name, profile?.primary_type, profile?.profile_type,
    profile?.description, profile?.summary, profile?.mission, profile?.needs,
  ];
  for (const data of Object.values(sections)) parts.push(JSON.stringify(data));
  for (const doc of profile?.documents ?? []) {
    parts.push(doc?.name, doc?.type, doc?.mime_type, doc?.extracted_text, doc?.ai_summary, doc?.notes);
    if (doc?.extracted_structured) parts.push(JSON.stringify(doc.extracted_structured));
  }
  return parts.map((p) => cleanText(p)).join(' ').toLowerCase();
}

function documentEvidence(profile) {
  const docs = Array.isArray(profile?.documents) ? profile.documents : [];
  return docs
    .filter((doc) => hasValue(doc?.extracted_text) || hasValue(doc?.ai_summary) || hasValue(doc?.extracted_structured))
    .map((doc) => ({
      id: doc?.id ?? null,
      name: doc?.name ?? 'Uploaded document',
      type: doc?.type ?? doc?.mime_type ?? null,
      status: doc?.processing_status ?? null,
    }));
}

function uploadedDocumentBlob(profile) {
  const docs = Array.isArray(profile?.documents) ? profile.documents : [];
  return docs
    .map((doc) => cleanText([
      doc?.name,
      doc?.type,
      doc?.mime_type,
      doc?.processing_status,
      doc?.extracted_text,
      doc?.ai_summary,
      doc?.summary,
      doc?.notes,
      doc?.extracted_structured,
    ]))
    .join(' ')
    .toLowerCase();
}

function uploadedDocumentEvidence(profile, entries) {
  return textEvidence(uploadedDocumentBlob(profile), entries);
}

function detectMilitaryStatus(profile, sections, blob) {
  const explicit = lc(firstValue(profile, sections, [
    'military_service.status',
    'military_service.military_status',
    'military_service.service_status',
    'demographics.military_status',
    '$.military_status',
  ]));
  const text = `${explicit} ${blob}`;
  const statuses = [];
  if (/\b(active duty|currently serving|servicemember|service member)\b/.test(text)) statuses.push('active_duty');
  if (/\b(national guard|reservist|reserve)\b/.test(text)) statuses.push('guard_reserve');
  if (/\b(transitioning service member|separating|separation|retiring|ets|tap)\b/.test(text)) statuses.push('transitioning_service_member');
  if (/\b(military spouse|spouse of service member|mycaa)\b/.test(text)) statuses.push('military_spouse');
  if (/\b(veteran|prior service|former service member|ex[-\s]?military)\b/.test(text)) statuses.push('veteran');
  return [...new Set(statuses)];
}

function detectArchetype(profile, thesis, sections, blob) {
  const primary = lc(profile?.primary_type ?? profile?.profile_type ?? profile?.type);
  const needText = lc([profile?.needs, profile?.need_categories].flat().join(' '));
  // An explicit non-student person (individual/family/senior/veteran/etc.) must NOT
  // be classified as a "student" just because an education section has data — almost
  // everyone has education history. Inferring student-ness from section presence is
  // only allowed when the primary type isn't an explicit non-student person type;
  // otherwise require an explicit student signal (thesis.is_student or a *_student
  // primary type). This stopped Individual profiles getting FAFSA/college content
  // and the "Student funding and portal action plan".
  const NON_STUDENT_PERSON_TYPES = ['individual', 'family', 'senior', 'veteran', 'disabled_adult', 'medical_need', 'individual_need'];
  const isExplicitNonStudentPerson = NON_STUDENT_PERSON_TYPES.includes(primary);
  const isStudent =
    thesis.is_student ||
    primary.includes('student') ||
    (!isExplicitNonStudentPerson && (hasValue(sections.education) || hasValue(sections.university_applications)));
  const isFoodTruck = /\bfood truck|mobile food|food trailer\b/.test(blob);
  const isStartup = thesis.needs?.includes('startup') || /\b(startup|start a business|starting a business|entrepreneur|launch)\b/.test(`${blob} ${needText}`);
  const applicantHas = (types) => types.some((type) => thesis.applicant_types?.includes(type));
  const needHas = (needs) => needs.some((need) => thesis.needs?.includes(need));
  const isLegalPractice =
    applicantHas(['business']) &&
    /\b(attorney|lawyer|law firm|law practice|legal practice)\b/.test(`${primary} ${blob}`);

  if (applicantHas(['candidate']) || needHas(['campaign'])) return 'campaign_compliance_plan';
  if (isStudent) return 'student_portal_plan';
  if (isFoodTruck) return 'food_truck_startup';
  if (isLegalPractice) return 'professional_practice_startup';
  if (applicantHas(['tribal'])) return 'tribal_government_plan';
  if (applicantHas(['farm']) || needHas(['agriculture'])) return 'farm_operation_plan';
  if (applicantHas(['vfd', 'law_enforcement', 'government']) || needHas(['public_safety', 'infrastructure', 'recreation'])) return 'public_agency_project_plan';
  if (applicantHas(['teacher'])) return 'classroom_project_plan';
  if (applicantHas(['nonprofit', 'church', 'ministry', 'school']) || needHas(['animal_welfare', 'capacity_building', 'programs'])) return 'nonprofit_program_plan';
  if (isStartup || thesis.applicant_types?.includes('business')) return 'small_business_startup';
  if (thesis.needs?.includes('caregiving') || thesis.needs?.includes('dementia_support')) return 'benefits_and_care_plan';
  if (needHas(['medical', 'medical_bills', 'disability', 'cancer_support', 'black_lung_benefits', 'survivor_benefits'])) return 'benefits_and_care_plan';
  if (applicantHas(['family', 'individual']) && needHas(['housing', 'food', 'energy', 'childcare', 'transportation'])) return 'benefits_and_care_plan';
  return 'general_funding_readiness';
}

function item({ id, title, value, question, why, howTo, hamilton, source_fields = [], category = 'readiness' }) {
  return {
    id,
    title,
    category,
    status: fieldStatus(value),
    known_value: hasValue(value) ? cleanText(value) : null,
    question,
    why,
    how_to: howTo,
    source_fields,
    hamilton_action: hamilton,
  };
}

function allKnownText(values) {
  return values.every(hasValue) ? values.map(cleanText).join(' / ') : null;
}

function textEvidence(blob, entries) {
  const hits = [];
  for (const [pattern, label] of entries) {
    if (pattern.test(blob)) hits.push(label);
  }
  return hits.length ? hits.join(', ') : null;
}

function hasApplicant(thesis, applicants) {
  const set = new Set(thesis?.applicant_types ?? []);
  return applicants.some((type) => set.has(type));
}

function hasNeed(thesis, needs) {
  const set = new Set(thesis?.needs ?? []);
  return needs.some((need) => set.has(need));
}

function officialDocumentItems(profile, sections, thesis, archetype, militaryStatuses) {
  const isStudent = archetype === 'student_portal_plan' || hasApplicant(thesis, ['student']);
  const isBusinessStartup =
    ['food_truck_startup', 'small_business_startup', 'professional_practice_startup', 'farm_operation_plan'].includes(archetype) ||
    hasApplicant(thesis, ['business', 'farm']);
  const applicantNeedsTaxId = hasApplicant(thesis, [
    'business',
    'farm',
    'nonprofit',
    'church',
    'ministry',
    'school',
    'vfd',
    'law_enforcement',
    'government',
    'tribal',
    'candidate',
  ]) || isBusinessStartup;
  const needsIncomeProof = hasNeed(thesis, [
    'housing',
    'food',
    'energy',
    'medical',
    'medical_bills',
    'disability',
    'caregiving',
    'survivor_benefits',
    'cancer_support',
    'dementia_support',
    'black_lung_benefits',
  ]);
  const hasMilitaryContext = militaryStatuses.length > 0 || hasApplicant(thesis, [
    'veteran',
    'active_duty',
    'guard_reserve',
    'transitioning_service_member',
    'military_spouse',
  ]);
  const isOrgLike = applicantNeedsTaxId;

  const items = [
    item({
      id: 'official_identity_upload',
      title: 'Official photo ID upload',
      category: 'document',
      value: uploadedDocumentEvidence(profile, [
        [/\b(driver'?s?\s+license|driving\s+license|state\s+id|photo\s+id|passport|government\s+id|\bdl\b)\b/, 'official photo ID uploaded'],
      ]),
      question: 'If a portal or application may require identity verification, please upload a current driver license, state ID, passport, or other official photo ID instead of typing the number here.',
      why: 'Many applications require identity verification, and uploading the document keeps the proof with the profile audit trail.',
      howTo: 'Use the profile document upload area. Do not paste driver license, passport, SSN, or taxpayer ID numbers into chat.',
      hamilton: 'Use the uploaded document only when a task requires identity proof; stop before any signature, attestation, or submission.',
      source_fields: ['documents.official_id', 'profile.documents'],
    }),
  ];

  if (applicantNeedsTaxId) {
    items.push(item({
      id: 'tax_identifier_document_upload',
      title: 'Tax ID or registration document upload',
      category: 'document',
      value: uploadedDocumentEvidence(profile, [
        [/\b(ein|tax\s+id|taxpayer\s+id|irs\s+(confirmation|letter)|cp\s?575|147c|w-?9|501\(c\)\(3\)|501c3|tax[-\s]?exempt|determination\s+letter)\b/, 'tax/registration proof uploaded'],
      ]),
      question: 'Please upload the official EIN/IRS letter, W-9, tax-exempt determination, campaign registration, or agency registration document if this profile has one.',
      why: 'Funders and portals often require tax/registration proof before they will accept an application or payment setup.',
      howTo: 'Upload the document to the profile. If the number itself is needed later, Hamilton should read it from the uploaded document, not from chat.',
      hamilton: 'Attach the tax/registration proof to the application packet and leave a profile document trail.',
      source_fields: ['organization_details.ein', 'small_business_details.ein', 'documents.tax_identifier'],
    }));
  }

  if (isBusinessStartup) {
    items.push(item({
      id: 'business_formation_documents_upload',
      title: 'Business formation, license, and quote uploads',
      category: 'document',
      value: uploadedDocumentEvidence(profile, [
        [/\b(articles\s+of\s+organization|business\s+registration|business\s+license|vendor\s+permit|health\s+permit|food\s+handler|insurance|equipment\s+quote|invoice|estimate)\b/, 'business/license/quote document uploaded'],
      ]),
      question: 'Please upload any business registration, license, permit, insurance certificate, equipment quote, invoice, or estimate you already have.',
      why: 'Startup funding requests need proof of legal setup and real costs, especially for equipment, permits, and insurance.',
      howTo: 'Upload each official form or vendor quote separately so Hamilton can build the checklist and budget from real documents.',
      hamilton: 'Use these uploads to prepare the business packet, permit tracker, and itemized funding list.',
      source_fields: ['small_business_details.licenses', 'small_business_details.permits', 'documents.business_forms'],
    }));
  }

  if (isStudent) {
    items.push(item({
      id: 'student_official_records_upload',
      title: 'Student aid and school record uploads',
      category: 'document',
      value: uploadedDocumentEvidence(profile, [
        [/\b(transcript|fafsa|student\s+aid\s+report|\bsar\b|financial\s+aid\s+award|tuition\s+bill|student\s+account|acceptance\s+letter|class\s+schedule)\b/, 'student aid/school record uploaded'],
      ]),
      question: 'Please upload any transcript, FAFSA confirmation/SAR, aid award letter, tuition bill, student account statement, acceptance letter, or class schedule that applies.',
      why: 'Scholarships, school portals, work-study, and emergency aid often require official school or aid records.',
      howTo: 'Upload school records directly to the profile; Anya should only ask follow-up questions for details not visible in the documents.',
      hamilton: 'Use the official records to build the student portal checklist and scholarship packet.',
      source_fields: ['education', 'financial_aid', 'documents.student_records'],
    }));
  }

  if (hasMilitaryContext) {
    const isActiveDuty = militaryStatuses.includes('active_duty') || militaryStatuses.includes('guard_reserve');
    items.push(item({
      id: 'military_verification_upload',
      title: 'Military status verification upload',
      category: 'document',
      value: uploadedDocumentEvidence(profile, [
        [/\b(dd[-\s]?214|va\s+benefit|va\s+award|disability\s+rating|orders|les|military\s+id|dependent\s+id|spouse\s+verification|tap\s+document)\b/, 'military verification uploaded'],
      ]),
      question: isActiveDuty
        ? 'Please upload non-sensitive proof of active duty, Guard/Reserve, or spouse/dependent status if a program requires it, such as orders, LES, TAP paperwork, or spouse verification.'
        : 'Please upload DD-214, VA benefit/award letter, disability rating letter, spouse verification, or other military-status proof if a program requires it.',
      why: 'Active duty, veteran, spouse, Guard/Reserve, and transition programs use different evidence and eligibility language.',
      howTo: 'Upload the official document. Do not type SSN, DoD ID, or full service-number details into chat.',
      hamilton: 'Route the packet to the right military program type and stop before any official submission.',
      source_fields: ['military_service.status', 'military_service.documents', 'documents.military'],
    }));
  }

  if (needsIncomeProof) {
    items.push(item({
      id: 'income_benefit_proof_upload',
      title: 'Income, benefit, bill, and need proof uploads',
      category: 'document',
      value: uploadedDocumentEvidence(profile, [
        [/\b(pay\s+stub|tax\s+return|w-?2|1099|benefit\s+letter|award\s+letter|utility\s+bill|rent\s+notice|lease|medical\s+bill|diagnosis|prescription|care\s+plan|death\s+certificate|black\s+lung)\b/, 'need/income proof uploaded'],
      ]),
      question: 'Please upload income proof, benefit letters, rent or utility bills, medical bills, diagnosis/care letters, survivor documents, or other proof tied to the help being requested.',
      why: 'Need-based programs usually require documentation of income, expenses, eligibility, or the urgent bill.',
      howTo: 'Upload documents to the profile and redact unrelated account details when possible. Do not paste SSNs or account numbers into chat.',
      hamilton: 'Use the documents to prepare benefit/application packets and keep proof attached to the profile.',
      source_fields: ['financial_information', 'health_medical', 'documents.need_proof'],
    }));
  }

  if (isOrgLike) {
    items.push(item({
      id: 'organization_governance_upload',
      title: 'Organization governance and authorization uploads',
      category: 'document',
      value: uploadedDocumentEvidence(profile, [
        [/\b(board\s+resolution|bylaws|articles\s+of\s+incorporation|authorization\s+letter|budget|audit|financial\s+statement|sam\.gov|uei)\b/, 'governance/authorization document uploaded'],
      ]),
      question: 'Please upload bylaws, articles, board authorization, budget, financial statement, audit, UEI/SAM proof, or other governance documents if this profile is applying as an organization.',
      why: 'Funders often require proof that the organization exists, is authorized to apply, and can steward funds.',
      howTo: 'Upload current official documents. Hamilton can then attach them to packets without inventing missing governance facts.',
      hamilton: 'Prepare the organizational document packet and flag missing authorization before submission.',
      source_fields: ['organization_details', 'documents.governance'],
    }));
  }

  return items;
}

function foodTruckItems(profile, sections, militaryStatuses, blob = '') {
  const state = firstValue(profile, sections, ['basic_information.state', 'basic_information.address.state', '$.state', '$.location.state']);
  const city = firstValue(profile, sections, ['basic_information.city', 'basic_information.address.city', '$.city', '$.location.city']);
  const businessName = firstValue(profile, sections, ['small_business_details.business_name', '$.business_name', '$.display_name', '$.name']);
  const legalStructure = firstValue(profile, sections, ['small_business_details.legal_structure', 'small_business_details.entity_type']);
  const equipment = firstValue(profile, sections, ['small_business_details.equipment_needed', 'small_business_details.assets_needed', '$.equipment_needed', '$.needs']);
  const startupBudget = firstValue(profile, sections, ['small_business_details.startup_budget', 'financial_information.startup_budget', 'financial_information.funding_needed']);
  const menu = firstValue(profile, sections, ['small_business_details.menu', 'small_business_details.products_services']);
  const serviceArea = allKnownText([city, state]);
  const businessIdentity = allKnownText([businessName, legalStructure]);
  const permitEvidence = textEvidence(blob, [
    [/\bhealth permit\b/, 'health permit mentioned in profile documents'],
    [/\bfood handler\b/, 'food handler credential mentioned in profile documents'],
    [/\bsales tax\b/, 'sales tax registration mentioned in profile documents'],
    [/\bcommissary\b/, 'commissary requirement mentioned in profile documents'],
    [/\bfire inspection\b/, 'fire inspection mentioned in profile documents'],
  ]);
  const equipmentEvidence = hasValue(equipment)
    ? equipment
    : textEvidence(blob, [
        [/\bfood truck|mobile food|food trailer\b/, 'truck/trailer mentioned in profile documents'],
        [/\bgenerator\b/, 'generator mentioned in profile documents'],
        [/\brefrigeration|freezer|cooler\b/, 'refrigeration mentioned in profile documents'],
        [/\bpos\b|point of sale/, 'point-of-sale equipment mentioned in profile documents'],
        [/\bcommissary\b/, 'commissary mentioned in profile documents'],
      ]);
  const militaryStatus = militaryStatuses.length ? militaryStatuses.join(', ') : null;
  return [
    item({
      id: 'business_location',
      title: 'Confirm service area',
      value: serviceArea,
      question: 'Where will the food truck operate first: city, county, and state?',
      why: 'Licenses, permits, inspections, and local funding depend on the operating location.',
      howTo: 'Start with the launch city/county, then list nearby event or route locations separately.',
      hamilton: 'Use the location to choose state, county, and municipal checklist links.',
      source_fields: ['basic_information.address', 'location'],
    }),
    item({
      id: 'business_identity',
      title: 'Choose business name and legal structure',
      value: businessIdentity,
      question: 'What business name and legal structure do you want to use?',
      why: 'The name/entity choice drives registration, EIN, bank account, insurance, and applications.',
      howTo: 'Decide whether this starts as sole proprietor, LLC, partnership, or corporation; then verify name availability.',
      hamilton: 'Prepare a registration worksheet and flag fields needed for state registration.',
      source_fields: ['small_business_details.business_name', 'small_business_details.legal_structure'],
    }),
    item({
      id: 'permits_licenses',
      title: 'Licenses and permits',
      value: permitEvidence,
      question: 'Do you already have any business license, food handler card, health permit, or sales tax registration?',
      why: 'Food trucks usually need layered business, tax, health, and local operating approvals.',
      howTo: 'Build a permit sequence: business registration, EIN, tax account, health department mobile food permit, fire inspection if required, commissary agreement if required, then local vending/event permits.',
      hamilton: 'Create a permit tracker with links and due dates once the launch city/county is known.',
      source_fields: ['small_business_details.licenses', 'small_business_details.permits'],
    }),
    item({
      id: 'truck_equipment',
      title: 'Truck, kitchen equipment, and commissary needs',
      value: equipmentEvidence,
      question: 'What do you already have, and what still needs funding: truck/trailer, wrap, generator, refrigeration, cooking equipment, POS, commissary?',
      why: 'This turns a broad startup request into fundable line items and documents for lenders/grants.',
      howTo: 'Make three columns: owned, quoted, and needed. Attach quotes/photos for every high-cost item.',
      hamilton: 'Draft an equipment budget with "to complete" amounts so no cost is invented.',
      source_fields: ['small_business_details.equipment_needed', 'needs'],
    }),
    item({
      id: 'menu_operations',
      title: 'Menu and operating model',
      value: menu,
      question: 'What will you sell, where will you prep food, and what days/hours will you operate?',
      why: 'Health permits, equipment, staffing, revenue projections, and insurance all depend on the menu and operating model.',
      howTo: 'Write a one-page operating plan: menu, prep location, vending locations, staffing, suppliers, and weekly schedule.',
      hamilton: 'Turn the answer into a business-plan section for applications.',
      source_fields: ['small_business_details.menu', 'small_business_details.products_services'],
    }),
    item({
      id: 'startup_capital',
      title: 'Startup budget and funding stack',
      value: startupBudget,
      question: 'How much startup capital is needed, and are loans acceptable or should GrantFlow search grants/benefits/resources only?',
      why: 'GrantFlow must not surface loans unless the profile allows them; the capital stack controls funding search.',
      howTo: 'Separate one-time startup costs from monthly operating costs; decide whether microloans/CDFIs are allowed.',
      hamilton: 'Prepare a funding packet and keep loan-capable sources gated by preference.',
      source_fields: ['financial_information.funding_needed', 'preferences.allow_loans'],
    }),
    item({
      id: 'military_context',
      title: 'Military-status-specific support',
      value: militaryStatus,
      question: 'Which status applies: active duty, transitioning service member, Guard/Reserve, military spouse, veteran, or prior service?',
      why: 'Active duty, veteran, spouse, and transition programs use different eligibility language and portals.',
      howTo: 'Capture exact status, branch, separation/transition date if any, and spouse status if relevant.',
      hamilton: 'Route to the right military entrepreneurship resources and avoid veteran-only language when it does not apply.',
      source_fields: ['military_service.status', 'military_service.separation_date'],
    }),
  ];
}

function studentItems(profile, sections, blob = '') {
  const school = firstValue(profile, sections, [
    'education.committed_college',
    'education.school_name',
    'student_details.school_name_or_target',
    'university_applications.applications',
    '$.school.name',
  ]);
  const fafsa = firstValue(profile, sections, ['financial_aid.fafsa_status', 'education.fafsa_status', 'student_details.fafsa_status']);
  const workStudy = firstValue(profile, sections, ['financial_aid.work_study_interest', 'education.work_study_interest', 'student_details.work_study_interest']);
  const major = firstValue(profile, sections, ['education.field_of_study', 'student_details.field_of_study', '$.field_of_study']);
  const workStudyEvidence = hasValue(workStudy)
    ? workStudy
    : textEvidence(blob, [[/\bwork[-\s]?study\b/, 'work-study mentioned in profile documents']]);
  return [
    item({
      id: 'school_portals',
      title: 'School portals',
      value: school,
      question: 'Which college or university should GrantFlow treat as the active school, and what portals do you already use?',
      why: 'Financial aid, scholarships, student accounts, housing, and work-study usually live inside school-specific portals.',
      howTo: 'Confirm the committed/target school, then add admissions, financial aid, scholarship, bursar/student account, housing, and department portals.',
      hamilton: 'Create portal tiles and request saved login/session capture where the user authorizes it.',
      source_fields: ['education.committed_college', 'university_applications.applications'],
      category: 'portal',
    }),
    item({
      id: 'fafsa',
      title: 'FAFSA and federal aid',
      value: fafsa,
      question: 'Has the FAFSA been started, submitted, selected for verification, or completed?',
      why: 'Pell, federal work-study, subsidized loans, and many school grants depend on FAFSA status.',
      howTo: 'Track FAFSA stage, StudentAid.gov account access, verification documents, SAR/SAI, and school receipt.',
      hamilton: 'Prepare verification document checklist; never submit federal forms without explicit user authorization.',
      source_fields: ['financial_aid.fafsa_status', 'education.fafsa_status'],
      category: 'portal',
    }),
    item({
      id: 'work_study_jobs',
      title: 'Federal work-study and campus jobs',
      value: workStudyEvidence,
      question: 'Do you want work-study considered, and if yes, which campus job portal should GrantFlow track?',
      why: 'Work-study is not just a grant. The student usually has to find eligible campus jobs through the school portal.',
      howTo: "Confirm work-study eligibility/interest, locate the school job board, save searches related to the student's major, and track application deadlines.",
      hamilton: 'Add a work-study portal/job-search checklist for the selected university.',
      source_fields: ['financial_aid.work_study_interest', 'education.work_study_interest'],
      category: 'portal',
    }),
    item({
      id: 'scholarship_strategy',
      title: 'Scholarship search lanes',
      value: major,
      question: 'What major, career goal, GPA/test context, activities, and demographics should scholarship searches use?',
      why: 'Scholarship portals match on major, school, residency, academic record, activities, and demographics.',
      howTo: 'Build school, department, state, foundation, employer, professional association, and identity-based scholarship lanes.',
      hamilton: 'Prepare reusable scholarship application materials and portal tracker.',
      source_fields: ['education.field_of_study', 'demographics', 'narrative'],
      category: 'funding',
    }),
  ];
}

function businessStartupItems(profile, sections) {
  const state = firstValue(profile, sections, ['basic_information.state', 'basic_information.address.state', '$.state', '$.location.state']);
  const city = firstValue(profile, sections, ['basic_information.city', 'basic_information.address.city', '$.city', '$.location.city']);
  const businessName = firstValue(profile, sections, ['small_business_details.business_name', '$.business_name', '$.display_name', '$.name']);
  const legalStructure = firstValue(profile, sections, ['small_business_details.legal_structure', 'small_business_details.entity_type']);
  const businessModel = firstValue(profile, sections, ['small_business_details.products_services', 'small_business_details.business_model', '$.description', '$.mission']);
  const startupBudget = firstValue(profile, sections, ['small_business_details.startup_budget', 'financial_information.startup_budget', 'financial_information.funding_needed']);
  const licensing = firstValue(profile, sections, ['small_business_details.licenses', 'small_business_details.permits', 'small_business_details.registrations']);
  return [
    item({
      id: 'business_location',
      title: 'Confirm operating location',
      value: allKnownText([city, state]),
      question: 'Where will the business operate first: city, county, and state?',
      why: 'Business registration, local permits, tax accounts, SBDC help, and state programs depend on the operating location.',
      howTo: 'Start with the primary launch location, then add service areas or remote/online sales separately.',
      hamilton: 'Use the location to choose state, county, municipal, SBDC, and chamber checklists.',
      source_fields: ['basic_information.address', 'location'],
    }),
    item({
      id: 'business_identity',
      title: 'Business name and legal structure',
      value: allKnownText([businessName, legalStructure]),
      question: 'What business name and legal structure should GrantFlow use: sole proprietor, LLC, partnership, corporation, or not decided yet?',
      why: 'The entity choice drives registration, EIN, tax accounts, banking, insurance, and funding eligibility.',
      howTo: 'Capture the preferred name and entity type. If undecided, Anya should mark it as a decision item rather than guessing.',
      hamilton: 'Prepare a registration worksheet and stop before any filing or attestation.',
      source_fields: ['small_business_details.business_name', 'small_business_details.legal_structure'],
    }),
    item({
      id: 'business_model',
      title: 'Business model and customers',
      value: businessModel,
      question: 'What will the business sell or provide, who are the first customers, and what problem does it solve?',
      why: 'Funding sources, certifications, pitch materials, and business-plan sections depend on the real business model.',
      howTo: 'Write a plain one-paragraph summary: offer, customer, geography, revenue model, and first milestone.',
      hamilton: 'Turn the answer into the business-plan summary and grant/funder search language.',
      source_fields: ['small_business_details.products_services', 'narrative.mission'],
    }),
    item({
      id: 'licenses_registration',
      title: 'Registrations, licenses, and insurance',
      value: licensing,
      question: 'Which registrations, licenses, permits, insurance policies, or professional approvals are already in place?',
      why: 'Most funders and business portals need proof that the business is legal and ready to operate.',
      howTo: 'List each required approval, current status, issuing agency, expiration date if known, and uploaded proof.',
      hamilton: 'Create a registration and compliance tracker with links and due dates.',
      source_fields: ['small_business_details.licenses', 'small_business_details.permits'],
    }),
    item({
      id: 'startup_costs',
      title: 'Startup costs and quotes',
      value: startupBudget,
      question: 'What exact startup costs need funding, and which ones already have quotes, invoices, or estimates?',
      why: 'GrantFlow can search better when broad startup need becomes line items like equipment, rent, insurance, software, inventory, or training.',
      howTo: 'Separate one-time startup costs from monthly operating costs and upload quotes for high-cost items.',
      hamilton: 'Build an itemized budget and evidence checklist without inventing missing costs.',
      source_fields: ['financial_information.funding_needed', 'small_business_details.startup_budget'],
    }),
    item({
      id: 'funding_preferences',
      title: 'Funding type boundaries',
      value: firstValue(profile, sections, ['preferences.allow_loans', 'financial_information.acceptable_funding_types']),
      question: 'Should GrantFlow search grants/resources only, or are microloans, CDFIs, or other repayable options acceptable for manual review?',
      why: 'GrantFlow should not mix grants with loans unless the profile explicitly allows repayable options.',
      howTo: 'Choose allowed funding types before search. Loans and match-required programs should stay review-only unless permitted.',
      hamilton: 'Gate loan-capable tasks behind the user preference and never accept repayment terms automatically.',
      source_fields: ['preferences.allow_loans', 'financial_information.acceptable_funding_types'],
    }),
  ];
}

function professionalPracticeItems(profile, sections) {
  const state = firstValue(profile, sections, ['basic_information.state', 'basic_information.address.state', '$.state', '$.location.state']);
  const practiceName = firstValue(profile, sections, ['small_business_details.business_name', '$.display_name', '$.name']);
  const license = firstValue(profile, sections, ['professional_details.license_status', 'small_business_details.licenses']);
  const services = firstValue(profile, sections, ['professional_details.practice_area', 'small_business_details.products_services', '$.needs']);
  const startupBudget = firstValue(profile, sections, ['small_business_details.startup_budget', 'financial_information.funding_needed']);
  return [
    item({
      id: 'practice_jurisdiction',
      title: 'Practice jurisdiction and location',
      value: state,
      question: 'Which state and local market will the practice serve first?',
      why: 'Bar rules, registrations, SBDC resources, local business support, and professional liability requirements are location-specific.',
      howTo: 'Confirm the principal office state, county/city, and any remote or multi-state practice plans.',
      hamilton: 'Use the jurisdiction to build registration, bar, tax, and insurance checklist items.',
      source_fields: ['basic_information.address', 'professional_details.jurisdiction'],
    }),
    item({
      id: 'practice_identity',
      title: 'Practice name, entity, and license status',
      value: allKnownText([practiceName, license]),
      question: 'What practice name/entity will be used, and what is the attorney license/bar status?',
      why: 'Professional practices need entity, ethics, licensing, malpractice, trust-account, and client-intake details handled correctly.',
      howTo: 'Capture the entity choice, bar status, malpractice plan, trust-account need, and any pro bono or legal-aid focus.',
      hamilton: 'Prepare a professional-practice launch checklist and stop before any regulated filing.',
      source_fields: ['small_business_details.business_name', 'professional_details.license_status'],
    }),
    item({
      id: 'practice_services',
      title: 'Practice services and client focus',
      value: services,
      question: 'Which practice areas, client populations, and launch services should funding and support searches use?',
      why: 'A solo practice, legal-tech project, legal-aid clinic, or rural-access practice needs different funding language.',
      howTo: 'Describe services, target clients, fee model, community benefit if any, and first 90-day milestone.',
      hamilton: 'Turn this into search language and a launch worksheet.',
      source_fields: ['professional_details.practice_area', 'small_business_details.products_services'],
    }),
    item({
      id: 'practice_startup_budget',
      title: 'Practice startup budget',
      value: startupBudget,
      question: 'What does the practice need to launch: insurance, software, office, legal research, marketing, equipment, filing fees, or training?',
      why: 'Professional startup requests need itemized costs and proof instead of generic business language.',
      howTo: 'Separate required compliance costs from optional growth costs and upload quotes where available.',
      hamilton: 'Build the budget checklist and keep repayable options separate from grant/resource options.',
      source_fields: ['financial_information.funding_needed', 'small_business_details.startup_budget'],
    }),
  ];
}

function farmItems(profile, sections, blob = '') {
  const state = firstValue(profile, sections, ['basic_information.state', 'basic_information.address.state', '$.state', '$.location.state']);
  const county = firstValue(profile, sections, ['basic_information.county', 'basic_information.address.county', '$.county']);
  const operation = firstValue(profile, sections, ['farm_details.operation_type', 'farm_details.products', '$.needs']);
  const fsa = firstValue(profile, sections, ['farm_details.fsa_status', 'farm_details.usda_status']);
  const budget = firstValue(profile, sections, ['farm_details.funding_needed', 'financial_information.funding_needed']);
  const equipmentEvidence = textEvidence(blob, [
    [/\b(tractor|livestock|crop|irrigation|greenhouse|fencing|barn|high tunnel|seed|feed)\b/, 'farm equipment/input need mentioned'],
  ]);
  return [
    item({
      id: 'farm_location',
      title: 'Farm location and county',
      value: allKnownText([county, state]),
      question: 'What county and state is the farm or ranch located in?',
      why: 'USDA, conservation district, extension, disaster, and state agriculture programs are location-specific.',
      howTo: 'Use the farm operating location, not just the mailing address, and add service area if products are sold elsewhere.',
      hamilton: 'Route to USDA, state agriculture, county extension, and conservation district resources.',
      source_fields: ['basic_information.address', 'farm_details.location'],
    }),
    item({
      id: 'farm_operation',
      title: 'Farm operation type',
      value: operation,
      question: 'What type of farm operation is this: crop, livestock, specialty crop, value-added product, beginning farmer, ranch, or other?',
      why: 'Different farm programs use different language and eligibility rules.',
      howTo: 'Capture products, acreage or herd size if known, years in operation, and whether this is beginning, veteran, socially disadvantaged, or disaster-related.',
      hamilton: 'Build the USDA/FSA/NRCS search terms and application checklist.',
      source_fields: ['farm_details.operation_type', 'farm_details.products'],
    }),
    item({
      id: 'usda_fsa_status',
      title: 'USDA/FSA status',
      value: fsa,
      question: 'Is the farm registered with FSA/USDA, and does it have a farm number or any existing USDA portal access?',
      why: 'Many agriculture programs require FSA records, USDA portal access, or conservation planning before funding can move.',
      howTo: 'Ask for status only. If proof is needed, upload the official document rather than typing sensitive IDs.',
      hamilton: 'Create USDA/FSA portal and document tasks when the user authorizes them.',
      source_fields: ['farm_details.fsa_status', 'documents.usda'],
      category: 'portal',
    }),
    item({
      id: 'farm_equipment_inputs',
      title: 'Equipment, input, or facility need',
      value: firstValue(profile, sections, ['farm_details.equipment_needed', 'farm_details.inputs_needed']) || equipmentEvidence,
      question: 'What does the farm need funded: equipment, livestock, seed/feed, fencing, conservation practice, storage, vehicle, or facility work?',
      why: 'GrantFlow needs concrete farm items to search the right grants, conservation programs, and assistance directories.',
      howTo: 'List owned, quoted, and still-needed items. Upload quotes, photos, or estimates when available.',
      hamilton: 'Prepare an itemized farm budget and evidence checklist.',
      source_fields: ['farm_details.equipment_needed', 'needs'],
    }),
    item({
      id: 'farm_budget',
      title: 'Farm budget and allowed funding types',
      value: budget,
      question: 'How much funding is needed, by when, and are cost-share or loan programs allowed for review?',
      why: 'Some agriculture programs are grants, some are cost-share, and some are loans; GrantFlow must keep those rules visible.',
      howTo: 'Separate grants/resources from cost-share and repayable options. Mark repayable options review-only unless allowed.',
      hamilton: 'Keep funding-type boundaries attached to the farm search and packet.',
      source_fields: ['financial_information.funding_needed', 'preferences.allow_loans'],
    }),
  ];
}

function classroomItems(profile, sections) {
  const school = firstValue(profile, sections, ['education.school_name', 'teacher_details.school_name', '$.school.name']);
  const grade = firstValue(profile, sections, ['teacher_details.grade_level', 'education.grade_level']);
  const subject = firstValue(profile, sections, ['teacher_details.subject', 'education.subject']);
  const need = firstValue(profile, sections, ['teacher_details.classroom_need', '$.needs', '$.need_categories']);
  const approval = firstValue(profile, sections, ['teacher_details.district_approval', 'teacher_details.admin_approval']);
  return [
    item({
      id: 'classroom_context',
      title: 'School, grade, and subject',
      value: allKnownText([school, grade, subject]),
      question: 'What school, grade level, and subject should GrantFlow use for classroom funding?',
      why: 'Teacher grants and classroom donors match by school, grade, subject, student population, and project type.',
      howTo: 'Capture school/district, grade, subject, student count, and any high-need or special population context.',
      hamilton: 'Build teacher grant and classroom donation search language.',
      source_fields: ['teacher_details', 'education'],
    }),
    item({
      id: 'classroom_need',
      title: 'Classroom project or supplies',
      value: need,
      question: 'What exactly is needed for the classroom, and what will students do with it?',
      why: 'A clear project need performs better than generic supplies language.',
      howTo: 'List items, quantities, cost, vendor link if known, student impact, and timing.',
      hamilton: 'Create a classroom project packet and itemized budget.',
      source_fields: ['teacher_details.classroom_need', 'needs'],
    }),
    item({
      id: 'school_approval',
      title: 'School approval and purchasing rules',
      value: approval,
      question: 'Does the school or district need to approve donations, grants, purchases, or public classroom campaigns?',
      why: 'Teachers often need administrator approval, vendor rules, or district donation procedures before applying.',
      howTo: 'Capture approval contact, allowed platforms, tax/donation handling, and purchase restrictions.',
      hamilton: 'Add approval and purchasing steps before any submission or purchase.',
      source_fields: ['teacher_details.district_approval'],
    }),
  ];
}

function nonprofitProgramItems(profile, sections, thesis, blob = '') {
  const state = firstValue(profile, sections, ['basic_information.state', 'basic_information.address.state', '$.state', '$.location.state']);
  const mission = firstValue(profile, sections, ['organization_details.mission', 'narrative.mission', '$.mission', '$.description']);
  const population = firstValue(profile, sections, ['organization_details.population_served', 'program_details.population_served']);
  const budget = firstValue(profile, sections, ['program_details.budget', 'financial_information.funding_needed']);
  const status = firstValue(profile, sections, ['organization_details.tax_exempt_status', 'organization_details.ein', 'organization_details.legal_status']);
  const faithBased = hasApplicant(thesis, ['church', 'ministry']);
  const animalWelfare = hasNeed(thesis, ['animal_welfare']) || /\b(animal shelter|animal rescue|humane society|spay|neuter|veterinary)\b/.test(blob);
  const items = [
    item({
      id: 'program_location',
      title: 'Service area',
      value: state,
      question: 'What city, county, state, and service area does this program serve?',
      why: 'Foundation, state, county, and community programs depend on geography and population served.',
      howTo: 'Use the actual service area, not only the mailing address, and note rural/tribal/urban context if relevant.',
      hamilton: 'Route to state, local, foundation, and directory sources for the service area.',
      source_fields: ['basic_information.address', 'program_details.service_area'],
    }),
    item({
      id: 'program_mission',
      title: 'Mission and program need',
      value: mission,
      question: 'What program or mission needs funding, and what would the funding pay for?',
      why: 'Nonprofit and ministry funding works best when the request is tied to a concrete program, population, and budget.',
      howTo: 'Summarize the program, population served, amount needed, timeline, and proof/outcomes available.',
      hamilton: 'Build the program statement and funding-source search language.',
      source_fields: ['organization_details.mission', 'program_details'],
    }),
    item({
      id: 'population_outcomes',
      title: 'Population served and outcomes',
      value: population,
      question: 'Who is served, how many people/animals/families are affected, and what outcome should funders see?',
      why: 'Funders often require population, geography, outcomes, and stewardship detail.',
      howTo: 'Capture target population, approximate volume, current waitlist or demand, and measurable result.',
      hamilton: 'Prepare outcome language without inventing numbers.',
      source_fields: ['organization_details.population_served', 'program_details.outcomes'],
    }),
    item({
      id: 'nonprofit_status',
      title: 'Nonprofit, fiscal sponsor, or organization status',
      value: status,
      question: 'Does the organization have 501(c)(3), church/ministry status, fiscal sponsor, EIN, or another legal status?',
      why: 'Eligibility differs for nonprofits, churches, ministries, schools, fiscal sponsors, and unincorporated groups.',
      howTo: 'Ask for status and upload official proof when needed. Do not type full tax identifiers into chat.',
      hamilton: 'Use the uploaded proof for application packets and flag fiscal-sponsor needs.',
      source_fields: ['organization_details.tax_exempt_status', 'organization_details.ein'],
    }),
    item({
      id: 'program_budget',
      title: 'Budget, documents, and stewardship',
      value: budget,
      question: 'What budget, quotes, financial statements, board approval, or reports are available for this request?',
      why: 'Program funders need a realistic budget and evidence that the applicant can manage funds.',
      howTo: 'Upload budgets, quotes, annual reports, board approvals, or financial statements if available.',
      hamilton: 'Create the application packet and missing-document checklist.',
      source_fields: ['financial_information.funding_needed', 'documents.budget'],
    }),
  ];

  if (faithBased) {
    items.push(item({
      id: 'faith_based_boundaries',
      title: 'Faith-based program boundaries',
      value: firstValue(profile, sections, ['program_details.faith_based_services', 'organization_details.faith_based_context']),
      question: 'Is the request for worship/ministry operations, community services, food/housing help, youth work, building needs, or another faith-based program?',
      why: 'Some funders support faith-based community services but not worship activity; the distinction must be honest.',
      howTo: 'Describe the public/community benefit separately from religious activity when applicable.',
      hamilton: 'Keep eligibility language precise and avoid misclassifying restricted religious activity.',
      source_fields: ['program_details.faith_based_services'],
    }));
  }

  if (animalWelfare) {
    items.push(item({
      id: 'animal_welfare_capacity',
      title: 'Animal care capacity and need',
      value: firstValue(profile, sections, ['program_details.animal_count', 'animal_welfare.capacity', 'animal_welfare.need']),
      question: 'What animal welfare need should GrantFlow fund: shelter operations, spay/neuter, rescue transport, veterinary care, kennels, food, or adoption support?',
      why: 'Animal shelters and rescues have different funders for medical care, facility capacity, transport, and adoption programs.',
      howTo: 'Capture animal counts, service area, urgent costs, vet/food/shelter needs, and any municipal contract or nonprofit status.',
      hamilton: 'Build an animal-welfare funding packet and evidence checklist.',
      source_fields: ['animal_welfare', 'program_details'],
    }));
  }

  return items;
}

function publicAgencyItems(profile, sections, thesis) {
  const state = firstValue(profile, sections, ['basic_information.state', 'basic_information.address.state', '$.state', '$.location.state']);
  const jurisdiction = firstValue(profile, sections, ['government_details.jurisdiction', 'basic_information.county', '$.county']);
  const project = firstValue(profile, sections, ['government_details.project_scope', 'program_details.project_scope', '$.needs']);
  const budget = firstValue(profile, sections, ['government_details.budget', 'financial_information.funding_needed']);
  const portal = firstValue(profile, sections, ['government_details.sam_status', 'organization_details.uei', 'organization_details.sam_gov_status']);
  const isPublicSafety = hasApplicant(thesis, ['vfd', 'law_enforcement']) || hasNeed(thesis, ['public_safety']);
  return [
    item({
      id: 'agency_jurisdiction',
      title: 'Jurisdiction and authority',
      value: allKnownText([jurisdiction, state]),
      question: 'Which agency, department, county/city, state, and legal authority applies to this request?',
      why: 'Government and public-safety funding depends on applicant authority, jurisdiction, and eligible entity type.',
      howTo: 'Capture department name, jurisdiction, authorizing body, population/service area, and fiscal agent if any.',
      hamilton: 'Route to federal/state/local sources and prepare authority documentation tasks.',
      source_fields: ['government_details.jurisdiction', 'organization_details'],
    }),
    item({
      id: 'public_project_scope',
      title: isPublicSafety ? 'Public-safety project scope' : 'Public project scope',
      value: project,
      question: isPublicSafety
        ? 'What public-safety need is being funded: equipment, vehicle, PPE, training, staffing, technology, prevention, or emergency management?'
        : 'What public project is being funded: infrastructure, facility, parks/recreation, broadband, water/sewer, transportation, housing, or economic development?',
      why: 'Federal and state public-sector sources are organized by project type and eligible cost category.',
      howTo: 'Define the project, eligible costs, beneficiaries, readiness, timeline, and procurement status.',
      hamilton: 'Create a public-sector grant checklist with procurement and authorization guardrails.',
      source_fields: ['government_details.project_scope', 'program_details.project_scope'],
    }),
    item({
      id: 'public_budget_match',
      title: 'Budget, match, and procurement status',
      value: budget,
      question: 'What is the project budget, is match funding required or available, and has procurement started?',
      why: 'Many public grants require cost estimates, local match, procurement compliance, and board/council authorization.',
      howTo: 'Upload estimates, capital plans, procurement notes, meeting minutes, and match documentation when available.',
      hamilton: 'Flag match/repayment/procurement requirements as review items, never as automatic approvals.',
      source_fields: ['government_details.budget', 'financial_information.funding_needed'],
    }),
    item({
      id: 'sam_uei_portals',
      title: 'SAM.gov, UEI, and agency portals',
      value: portal,
      question: 'Does the agency have SAM.gov/UEI access and any state or federal grant portals already set up?',
      why: 'Public-sector applications often require SAM.gov, Grants.gov, state portals, or agency-specific logins.',
      howTo: 'Capture portal status only. Upload official proof if needed and let Hamilton request login help with permission.',
      hamilton: 'Create portal tasks and stop before login, signature, certification, or submission.',
      source_fields: ['organization_details.uei', 'government_details.sam_status'],
      category: 'portal',
    }),
  ];
}

function tribalItems(profile, sections) {
  return [
    ...publicAgencyItems(profile, sections, { applicant_types: ['tribal'], needs: [] }).map((entry) => (
      entry.id === 'agency_jurisdiction'
        ? { ...entry, title: 'Tribal government and service area', question: 'Which Tribe, Native nation, reservation/service area, and authorizing office applies to this request?' }
        : entry
    )),
    item({
      id: 'tribal_program_fit',
      title: 'Tribal program fit',
      value: firstValue(profile, sections, ['tribal_details.program_area', 'program_details.project_scope', '$.needs']),
      question: 'Which tribal program area should GrantFlow search: governance, housing, health, education, culture, language, infrastructure, economic development, or social services?',
      why: 'Tribal funding sources use specific program authorities and eligibility language.',
      howTo: 'Capture program area, tribal resolution/authorization needs, beneficiaries, timeline, and documents available.',
      hamilton: 'Build a tribal-program packet and flag resolution/authorization steps before submission.',
      source_fields: ['tribal_details.program_area', 'program_details'],
    }),
  ];
}

function campaignItems(profile, sections) {
  const state = firstValue(profile, sections, ['basic_information.state', 'campaign_details.state', '$.state']);
  const office = firstValue(profile, sections, ['campaign_details.office_sought', 'campaign_details.office', '$.needs']);
  const committee = firstValue(profile, sections, ['campaign_details.committee_status', 'campaign_details.registration_status']);
  return [
    item({
      id: 'campaign_jurisdiction',
      title: 'Office, jurisdiction, and election',
      value: allKnownText([office, state]),
      question: 'What office, jurisdiction, election date, and state/local filing authority applies?',
      why: 'Campaign support is governed by election law and filing calendars, not ordinary grant eligibility.',
      howTo: 'Capture office sought, county/municipality/district, election date, filing agency, and campaign-contact details.',
      hamilton: 'Create a compliance calendar and resource checklist; do not treat campaign contributions as grants.',
      source_fields: ['campaign_details.office_sought', 'campaign_details.election_date'],
    }),
    item({
      id: 'campaign_committee',
      title: 'Committee and campaign-finance setup',
      value: committee,
      question: 'Has a campaign committee, treasurer, bank account, or campaign-finance registration been created?',
      why: 'Most campaign funding activity requires registration, reporting, contribution limits, and a treasurer process.',
      howTo: 'Ask for status and official filings. Upload forms rather than typing sensitive bank/tax details into chat.',
      hamilton: 'Prepare filing/document tasks and stop before any legal filing, attestation, payment, or contribution action.',
      source_fields: ['campaign_details.committee_status', 'documents.campaign_filings'],
    }),
    item({
      id: 'campaign_resource_boundaries',
      title: 'Allowed support boundaries',
      value: firstValue(profile, sections, ['campaign_details.allowed_support', 'preferences.campaign_support_types']),
      question: 'What help is being requested: compliance resources, public matching funds if available, training, campaign tools, or lawful contribution research?',
      why: 'GrantFlow must keep campaign compliance and funding boundaries explicit.',
      howTo: 'Separate official public-financing programs and compliance resources from donations, loans, or campaign spending.',
      hamilton: 'Label campaign items as compliance/resource tasks and require user/legal review before any filing or transaction.',
      source_fields: ['campaign_details.allowed_support'],
    }),
  ];
}

function benefitsCareItems(profile, sections, thesis) {
  const state = firstValue(profile, sections, ['basic_information.state', 'basic_information.address.state', '$.state', '$.location.state']);
  const household = firstValue(profile, sections, ['household.size', 'demographics.household_size', 'family_details.household_size']);
  const benefits = firstValue(profile, sections, ['benefits.current_benefits', 'financial_information.current_benefits']);
  const condition = firstValue(profile, sections, ['health_medical.condition', 'health_medical.diagnosis', 'caregiving.condition', '$.needs']);
  const urgentBill = firstValue(profile, sections, ['financial_information.urgent_bill', 'needs.urgent_bill', 'health_medical.medical_bills']);
  const studiesPreference = firstValue(profile, sections, ['health_medical.research_studies_opt_in', 'preferences.research_studies_opt_in', 'preferences.clinical_trials_opt_in']);
  const healthStudyRelevant = hasNeed(thesis, ['medical', 'medical_bills', 'disability', 'cancer_support', 'dementia_support']);
  const items = [
    item({
      id: 'benefits_location',
      title: 'Residence and service location',
      value: state,
      question: 'What city, county, state, and ZIP should benefits and assistance searches use?',
      why: 'Benefits, community action, utilities, food, Medicaid, and health resources are highly local.',
      howTo: 'Use the residence/service location and note if mailing address, care location, or hospital location differs.',
      hamilton: 'Route to state benefit portals, local directories, and assistance agencies.',
      source_fields: ['basic_information.address', 'location'],
    }),
    item({
      id: 'household_income_context',
      title: 'Household and income context',
      value: household,
      question: 'Who is in the household, and what income or benefit proof is available?',
      why: 'Need-based programs usually require household size, income, existing benefits, and proof documents.',
      howTo: 'Ask for ranges/status and upload proof documents. Do not ask for SSNs or account numbers in chat.',
      hamilton: 'Build the benefit checklist and required-document list.',
      source_fields: ['household', 'financial_information'],
    }),
    item({
      id: 'current_benefits',
      title: 'Current benefits and applications',
      value: benefits,
      question: 'Which benefits are already active, pending, denied, or not started: SNAP, Medicaid, LIHEAP, SSI/SSDI, VA, survivor, black-lung, or local help?',
      why: 'GrantFlow should fill gaps and avoid duplicate or conflicting applications.',
      howTo: 'Capture status only and upload letters/notices when available.',
      hamilton: 'Create a benefits status tracker and appeal/follow-up tasks where needed.',
      source_fields: ['benefits.current_benefits', 'financial_information.current_benefits'],
    }),
    item({
      id: 'condition_and_care_need',
      title: 'Medical, disability, caregiving, or survivor need',
      value: condition,
      question: 'What condition, disability, caregiving, survivor, or urgent health need should GrantFlow use for matching?',
      why: 'Patient assistance, disability support, dementia care, cancer help, survivor benefits, and black-lung programs use different eligibility language.',
      howTo: 'Use plain condition/need language and upload proof if required. Do not type medical record numbers or account numbers into chat.',
      hamilton: 'Keep medical/support documents attached and route to assistance programs without overexposing sensitive details.',
      source_fields: ['health_medical', 'caregiving', 'benefits'],
    }),
    item({
      id: 'urgent_bill_or_need',
      title: 'Urgent bill or concrete need',
      value: urgentBill,
      question: 'What bill, service, equipment, transportation, medication, food, rent, or utility need is most urgent?',
      why: 'Concrete needs help GrantFlow find benefit, charity, foundation, and direct-assistance programs.',
      howTo: 'Capture amount, due date, provider, proof available, and what has already been tried.',
      hamilton: 'Build the urgent-assistance checklist and document packet.',
      source_fields: ['financial_information.urgent_bill', 'needs'],
    }),
  ];

  if (healthStudyRelevant) {
    items.push(item({
      id: 'research_studies_preference',
      title: 'Relevant studies opt-in preference',
      value: studiesPreference,
      question: 'Do you want relevant clinical or research studies shown as an optional lane, or should GrantFlow hide studies and show only benefits/assistance?',
      why: 'Studies are not funding assistance for everyone; they must be profile-relevant and user-controlled.',
      howTo: 'Keep studies off unless the user opts in. When on, show official study links separately from grants, benefits, or charity help.',
      hamilton: 'Do not enroll, contact, or submit anything for a study. Only prepare optional review links with user consent.',
      source_fields: ['health_medical.research_studies_opt_in', 'preferences.clinical_trials_opt_in'],
    }));
  }

  return items;
}

function generalItems(profile, sections) {
  const state = firstValue(profile, sections, ['basic_information.state', '$.state', '$.location.state']);
  const needs = firstValue(profile, sections, ['$.needs', '$.need_categories', 'narrative.needs_statement']);
  return [
    item({
      id: 'profile_location',
      title: 'Confirm location',
      value: state,
      question: 'What city, county, state, and ZIP should GrantFlow use?',
      why: 'Local benefits, county programs, state portals, and geographic eligibility all depend on this.',
      howTo: 'Use the primary residence or operating location; add a second address if school, duty station, or service area differs.',
      hamilton: 'Use the location for portal and application routing.',
      source_fields: ['basic_information.address', 'location'],
    }),
    item({
      id: 'priority_needs',
      title: 'Prioritize needs',
      value: needs,
      question: 'Which three needs are most urgent, and what would "help" actually pay for?',
      why: 'GrantFlow searches better when a need is translated into concrete items, services, documents, or portal tasks.',
      howTo: 'List urgent need, amount if known, due date, proof available, and acceptable funding types.',
      hamilton: 'Turn the needs into a checklist and document packet.',
      source_fields: ['needs', 'narrative.needs_statement'],
    }),
  ];
}

function militaryInterviewQuestions(militaryStatuses, archetype) {
  if (!militaryStatuses.length && archetype !== 'food_truck_startup') return [];
  const statusText = militaryStatuses.length ? militaryStatuses.map(titleCase).join(', ') : 'military background';
  return [
    {
      id: 'military_status_precision',
      prompt: 'Which military status should GrantFlow use for eligibility: active duty, transitioning, Guard/Reserve, military spouse, veteran, or prior service?',
      why: `${statusText} can unlock different programs, but using the wrong label creates bad matches.`,
      fields_to_check: ['military_service.status', 'military_service.branch', 'military_service.separation_date'],
      required: true,
    },
  ];
}

function planTitle(archetype) {
  if (archetype === 'campaign_compliance_plan') return 'Campaign compliance and funding-boundary action plan';
  if (archetype === 'food_truck_startup') return 'Food truck launch action plan';
  if (archetype === 'student_portal_plan') return 'Student funding and portal action plan';
  if (archetype === 'professional_practice_startup') return 'Professional practice startup action plan';
  if (archetype === 'farm_operation_plan') return 'Farm operation funding action plan';
  if (archetype === 'tribal_government_plan') return 'Tribal program funding action plan';
  if (archetype === 'public_agency_project_plan') return 'Public agency project funding action plan';
  if (archetype === 'classroom_project_plan') return 'Classroom funding action plan';
  if (archetype === 'nonprofit_program_plan') return 'Nonprofit program funding action plan';
  if (archetype === 'small_business_startup') return 'Business startup action plan';
  if (archetype === 'benefits_and_care_plan') return 'Benefits and care support action plan';
  return 'Funding readiness action plan';
}

export function buildProjectReadinessPlan(profile = {}) {
  const sections = sectionsByKey(profile);
  const thesis = buildThesis(profile);
  const blob = profileBlob(profile, sections);
  const documents = documentEvidence(profile);
  const archetype = detectArchetype(profile, thesis, sections, blob);
  const military_statuses = detectMilitaryStatus(profile, sections, blob);
  const coreChecklist =
    archetype === 'campaign_compliance_plan'
      ? campaignItems(profile, sections)
      : archetype === 'food_truck_startup'
        ? foodTruckItems(profile, sections, military_statuses, blob)
        : archetype === 'student_portal_plan'
          ? studentItems(profile, sections, blob)
          : archetype === 'professional_practice_startup'
            ? professionalPracticeItems(profile, sections)
            : archetype === 'farm_operation_plan'
              ? farmItems(profile, sections, blob)
              : archetype === 'tribal_government_plan'
                ? tribalItems(profile, sections)
                : archetype === 'public_agency_project_plan'
                  ? publicAgencyItems(profile, sections, thesis)
                  : archetype === 'classroom_project_plan'
                    ? classroomItems(profile, sections)
                    : archetype === 'nonprofit_program_plan'
                      ? nonprofitProgramItems(profile, sections, thesis, blob)
                      : archetype === 'small_business_startup'
                        ? businessStartupItems(profile, sections)
                        : archetype === 'benefits_and_care_plan'
                          ? benefitsCareItems(profile, sections, thesis)
                          : generalItems(profile, sections);
  const checklist = [
    ...coreChecklist,
    ...officialDocumentItems(profile, sections, thesis, archetype, military_statuses),
  ];

  const missing = checklist.filter((x) => x.status === 'ask_anya');
  const interview_questions = [
    ...missing.map((x) => ({
      id: x.id,
      prompt: x.question,
      why: x.why,
      fields_to_check: x.source_fields,
      required: ['business_location', 'business_identity', 'school_portals', 'profile_location', 'priority_needs'].includes(x.id),
    })),
    ...militaryInterviewQuestions(military_statuses, archetype),
  ];

  return {
    plan_id: archetype,
    title: planTitle(archetype),
    profile_id: profile?.id ?? profile?.profile_id ?? null,
    applicant_types: thesis.applicant_types,
    needs: thesis.needs,
    military_statuses,
    summary: `${planTitle(archetype)} built from profile fields and parsed profile documents. Known fields are reused; missing fields become Anya interview questions.`,
    document_evidence: documents,
    checklist,
    interview_questions,
    hamilton_next_actions: [
      'Save the checklist and how-to packet to the profile documents.',
      'Prepare application/portal worksheets for checklist items with enough known data.',
      'When official ID, tax, eligibility, or need proof is required, use uploaded profile documents rather than asking the user to type sensitive numbers into chat.',
      'Stop and ask the user before login, signature, payment, attestation, federal form submission, or loan acceptance.',
    ],
  };
}

export function renderProjectPlanDocument(plan) {
  const lines = [
    `# ${plan.title}`,
    '',
    plan.summary,
    '',
    '## Anya interview',
    ...(plan.interview_questions.length
      ? plan.interview_questions.map((q) => `- [ ] ${q.prompt} (${q.why})`)
      : ['- No required interview questions right now.']),
    '',
    '## Document evidence used',
    ...((plan.document_evidence ?? []).length
      ? plan.document_evidence.map((doc) => `- ${doc.name}${doc.type ? ` (${doc.type})` : ''}${doc.status ? ` - ${doc.status}` : ''}`)
      : ['- No parsed profile documents were available when this plan was generated.']),
    '',
    '## Checklist',
    ...plan.checklist.map((x) => [
      `- [${x.status === 'known' ? 'x' : ' '}] ${x.title}`,
      `  - Status: ${x.status === 'known' ? `Known: ${x.known_value}` : 'Ask Anya'}`,
      `  - Why: ${x.why}`,
      `  - How to handle it: ${x.how_to}`,
      `  - Hamilton: ${x.hamilton_action}`,
    ].join('\n')),
    '',
    '## Hamilton guardrails',
    ...plan.hamilton_next_actions.map((x) => `- ${x}`),
  ];
  return lines.join('\n');
}

export default { buildProjectReadinessPlan, renderProjectPlanDocument };
