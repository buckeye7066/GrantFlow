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
  const isStudent = thesis.is_student || primary.includes('student') || hasValue(sections.education) || hasValue(sections.university_applications);
  const isFoodTruck = /\bfood truck|mobile food|food trailer\b/.test(blob);
  const isStartup = thesis.needs?.includes('startup') || /\b(startup|start a business|starting a business|entrepreneur|launch)\b/.test(`${blob} ${needText}`);
  if (isStudent) return 'student_portal_plan';
  if (isFoodTruck) return 'food_truck_startup';
  if (isStartup || thesis.applicant_types?.includes('business')) return 'small_business_startup';
  if (thesis.needs?.includes('caregiving') || thesis.needs?.includes('dementia_support')) return 'benefits_and_care_plan';
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
  if (archetype === 'food_truck_startup') return 'Food truck launch action plan';
  if (archetype === 'student_portal_plan') return 'Student funding and portal action plan';
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
  const checklist = archetype === 'food_truck_startup'
    ? foodTruckItems(profile, sections, military_statuses, blob)
    : archetype === 'student_portal_plan'
      ? studentItems(profile, sections, blob)
      : archetype === 'small_business_startup'
        ? foodTruckItems(profile, sections, military_statuses, blob).filter((x) => x.id !== 'menu_operations')
        : generalItems(profile, sections);

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
