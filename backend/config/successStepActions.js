/**
 * Action metadata for SmartMatcher "What You Need for Success" cards.
 *
 * Each success step gets a stable id + concrete next actions (official URL,
 * profile section deep-link, documents upload, Anya prompt, checklist).
 * Completion is stored per profile in system_kv — never global.
 */

export const SUCCESS_STEPS_KV_PREFIX = 'matching_success_steps:'

/** Stable id from the step label (dedupe key across archetypes). */
export function successStepId(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 96)
}

/**
 * Pattern → action. First match wins. Keep official URLs on .gov / known
 * national orgs only — never invent a state portal.
 */
const ACTION_PATTERNS = [
  {
    test: (l) => /\bnpi\b|national provider identifier/.test(l),
    action: {
      how: 'An NPI is a free 10-digit ID from CMS. Most insurance billing and many HRSA grants require it.',
      checklist: [
        'Confirm you (or your organization) need a Type 1 (individual) or Type 2 (organization) NPI',
        'Create or sign in to an Identity & Access Management System (I&A) account',
        'Apply in NPPES and save the confirmation PDF',
        'Add your NPI on the profile organization or occupation section',
      ],
      official_url: 'https://nppes.cms.hhs.gov/',
      official_label: 'Open NPPES (CMS)',
      profile_section: 'organization_details',
      documents: true,
      document_hint: 'NPI confirmation letter',
      anya_prompt: 'Help me get an NPI and record it on my profile.',
    },
  },
  {
    test: (l) => /credential with insurance|insurance panels|medicaid.*medicare/.test(l),
    action: {
      how: 'Panel credentialing lets you bill Medicaid, Medicare, or private plans. It often takes 90–120 days, so start early.',
      checklist: [
        'List the payers you need (Medicaid, Medicare, major commercial plans)',
        'Gather license, NPI, malpractice certificate, and W-9',
        'Submit through each payer’s provider enrollment portal',
        'Upload acceptance letters to Documents when approved',
      ],
      official_url: 'https://www.cms.gov/medicare/enrollment-renewal/providers-suppliers',
      official_label: 'CMS provider enrollment',
      profile_section: 'organization_details',
      documents: true,
      document_hint: 'Insurance panel acceptance letters',
      anya_prompt: 'Walk me through insurance panel credentialing for my practice.',
    },
  },
  {
    test: (l) => /malpractice|professional liability|ftca/.test(l),
    action: {
      how: 'Malpractice (or FTCA coverage for HRSA sites) is usually required before you treat patients under a grant.',
      checklist: [
        'Decide individual vs organizational coverage',
        'Request quotes with your specialty and claim history',
        'Purchase a policy (or apply for FTCA if you are an FQHC)',
        'Upload the certificate of insurance to Documents',
      ],
      official_url: 'https://bphc.hrsa.gov/compliance/federal-tort-claims-act-ftca',
      official_label: 'HRSA FTCA overview',
      profile_section: 'organization_details',
      documents: true,
      document_hint: 'Malpractice / liability certificate',
      anya_prompt: 'Help me get the right malpractice insurance documentation on file.',
    },
  },
  {
    test: (l) => /hrsa-eligible|hrsa.*site|section 330|fqhc/.test(l),
    action: {
      how: 'HRSA community health funding expects an eligible site or New Access Point path. Start with HRSA’s official guidance.',
      checklist: [
        'Confirm whether you are applying as a new access point or as a partner site',
        'Review HRSA Health Center Program requirements',
        'Document underserved area need (CHNA / MUA-MUP)',
        'Save eligibility notes and site documents on your profile',
      ],
      official_url: 'https://bphc.hrsa.gov/funding/funding-opportunities',
      official_label: 'HRSA Health Center funding',
      profile_section: 'programs_services',
      documents: true,
      document_hint: 'HRSA eligibility / site documentation',
      anya_prompt: 'Help me understand HRSA-eligible site requirements for my clinic.',
    },
  },
  {
    test: (l) => /501\s*\(c\)\s*\(3\)|501c3|tax-exempt|fiscal sponsor/.test(l),
    action: {
      how: 'Most foundation and many government grants require 501(c)(3) status — or a fiscal sponsor that already has it.',
      checklist: [
        'Decide: file your own 501(c)(3) vs partner with a fiscal sponsor',
        'If filing: complete Form 1023/1023-EZ with the IRS',
        'If sponsoring: get a written fiscal sponsorship agreement',
        'Add EIN / determination letter on organization details and upload the letter',
      ],
      official_url: 'https://www.irs.gov/charities-non-profits/application-for-recognition-of-exemption',
      official_label: 'IRS tax-exempt application',
      profile_section: 'organization_details',
      documents: true,
      document_hint: '501(c)(3) determination letter or fiscal sponsor agreement',
      anya_prompt: 'Help me get 501(c)(3) status or find a fiscal sponsor for grant eligibility.',
    },
  },
  {
    test: (l) => /\bchna\b|community health needs assessment/.test(l),
    action: {
      how: 'A Community Health Needs Assessment documents local health gaps. CDC/HRSA reviewers expect this as the basis for your proposal.',
      checklist: [
        'Pull existing CHNA data from your hospital or health department if available',
        'Define the geography and priority health needs you serve',
        'Summarize findings in a short PDF (methods, needs, priorities)',
        'Upload the CHNA to Documents and reference it in your narrative',
      ],
      official_url: 'https://www.cdc.gov/publichealthgateway/cha/index.html',
      official_label: 'CDC community health assessment',
      profile_section: 'narrative',
      documents: true,
      document_hint: 'Community Health Needs Assessment (CHNA)',
      anya_prompt: 'Help me plan and document a Community Health Needs Assessment (CHNA).',
    },
  },
  {
    test: (l) => /logic model/.test(l),
    action: {
      how: 'A logic model shows inputs → activities → outputs → outcomes. Public health funders treat it as the gold standard.',
      checklist: [
        'List inputs (staff, partners, funding)',
        'List activities and measurable outputs',
        'Define short- and long-term health outcomes',
        'Save a one-page logic model PDF to Documents',
      ],
      official_url: 'https://www.cdc.gov/evaluation/logicmodels/index.htm',
      official_label: 'CDC logic model guide',
      profile_section: 'programs_services',
      documents: true,
      document_hint: 'Program logic model',
      anya_prompt: 'Help me draft a logic model for my health program.',
    },
  },
  {
    test: (l) => /\birb\b|institutional review board|human subjects/.test(l),
    action: {
      how: 'If you collect identifiable health or research data, most federal funders require IRB review before work starts.',
      checklist: [
        'Decide whether your work is human-subjects research or program evaluation',
        'Identify an IRB (university affiliate, independent IRB, or partner FQHC)',
        'Submit protocol, consent forms, and data-security plan',
        'Upload the approval letter to Documents',
      ],
      official_url: 'https://www.hhs.gov/ohrp/',
      official_label: 'HHS OHRP (human subjects)',
      profile_section: 'programs_services',
      documents: true,
      document_hint: 'IRB approval letter',
      anya_prompt: 'Help me figure out if I need IRB approval and how to get it.',
    },
  },
  {
    test: (l) => /background check/.test(l),
    action: {
      how: 'Anyone working with minors usually needs a background check. Funders often ask for proof before awarding.',
      checklist: [
        'Identify which roles need checks (staff, coaches, volunteers)',
        'Use your state-approved vendor or national check service',
        'Store clearance letters securely',
        'Upload a redacted clearance summary to Documents if funders require it',
      ],
      official_url: null,
      official_label: null,
      profile_section: 'organization_details',
      documents: true,
      document_hint: 'Background check clearances (redacted)',
      anya_prompt: 'Help me set up background checks for staff and volunteers who work with youth.',
    },
  },
  {
    test: (l) => /curriculum|measurable outcomes|competency-based/.test(l),
    action: {
      how: 'Funders want a written curriculum with measurable outcomes — not just a program idea.',
      checklist: [
        'Outline sessions / modules and learning objectives',
        'Define how you will measure success (pre/post, attendance, credentials)',
        'Save the curriculum PDF and link it from programs & services',
        'Upload the document so Hamilton and proposals can reuse it',
      ],
      official_url: null,
      official_label: null,
      profile_section: 'programs_services',
      documents: true,
      document_hint: 'Program curriculum with outcomes',
      anya_prompt: 'Help me draft a program curriculum with measurable outcomes for grant applications.',
    },
  },
  {
    test: (l) => /youth.*(registry|register)|state'?s youth/.test(l),
    action: {
      how: 'Many states require youth-serving organizations to register and report annually. Check your state agency first.',
      checklist: [
        'Identify your state youth-services or child-care licensing agency',
        'Complete registration / annual report forms',
        'Keep the confirmation on file',
        'Note registration status on organization details',
      ],
      official_url: null,
      official_label: null,
      profile_section: 'organization_details',
      documents: true,
      document_hint: 'State youth-organization registration',
      anya_prompt: 'Help me find and complete my state youth-serving organization registry requirements.',
    },
  },
  {
    test: (l) => /health department|partner with.*fqhc|local health department/.test(l),
    action: {
      how: 'CDC and HRSA proposals score higher with a named health department or FQHC partner.',
      checklist: [
        'Identify your county/city health department and nearest FQHC',
        'Request a brief partnership or MOU letter',
        'Record the partner name under programs & services',
        'Upload the MOU / letter of support to Documents',
      ],
      official_url: 'https://findahealthcenter.hrsa.gov/',
      official_label: 'Find a Health Center (HRSA)',
      profile_section: 'programs_services',
      documents: true,
      document_hint: 'Partnership / MOU letter',
      anya_prompt: 'Help me partner with my local health department or an FQHC for grant applications.',
    },
  },
  {
    test: (l) => /\bein\b|employer identification/.test(l),
    action: {
      how: 'An EIN is free from the IRS and is required for most business and nonprofit grant filings.',
      checklist: [
        'Apply online at IRS.gov (instant for most applicants)',
        'Save the CP 575 confirmation notice',
        'Enter the EIN on organization details',
        'Upload the confirmation PDF',
      ],
      official_url: 'https://www.irs.gov/businesses/small-businesses-self-employed/apply-for-an-employer-identification-number-ein-online',
      official_label: 'Apply for an EIN (IRS)',
      profile_section: 'organization_details',
      documents: true,
      document_hint: 'EIN confirmation (CP 575)',
      anya_prompt: 'Help me get an EIN and save it on my profile.',
    },
  },
  {
    test: (l) => /sam\.gov|uei number|unique entity/.test(l),
    action: {
      how: 'Federal awards require an active SAM.gov registration and a Unique Entity ID (UEI).',
      checklist: [
        'Create a Login.gov account',
        'Register or renew your entity on SAM.gov',
        'Copy your UEI into organization details',
        'Upload the SAM registration PDF',
      ],
      official_url: 'https://sam.gov/',
      official_label: 'Open SAM.gov',
      profile_section: 'organization_details',
      documents: true,
      document_hint: 'SAM.gov registration confirmation',
      anya_prompt: 'Help me register on SAM.gov and record my UEI.',
    },
  },
  {
    test: (l) => /grants\.gov/.test(l),
    action: {
      how: 'Most federal applications are submitted through Grants.gov once SAM.gov is active.',
      checklist: [
        'Confirm SAM.gov / UEI is active',
        'Create a Grants.gov applicant account',
        'Add organization users / AOR roles',
        'Note account status on organization details',
      ],
      official_url: 'https://www.grants.gov/',
      official_label: 'Open Grants.gov',
      profile_section: 'organization_details',
      documents: false,
      anya_prompt: 'Help me set up a Grants.gov account for federal applications.',
    },
  },
  {
    test: (l) => /\bfafsa\b/.test(l),
    action: {
      how: 'FAFSA unlocks federal student aid and is required by most colleges and many scholarships.',
      checklist: [
        'Create an FSA ID at StudentAid.gov',
        'Complete this year’s FAFSA form',
        'Update education / FAFSA status on your profile',
        'Download the confirmation email/PDF to Documents',
      ],
      official_url: 'https://studentaid.gov/h/apply-for-aid/fafsa',
      official_label: 'Start FAFSA (StudentAid.gov)',
      profile_section: 'education',
      documents: true,
      document_hint: 'FAFSA submission confirmation',
      anya_prompt: 'Help me complete the FAFSA and update my education profile.',
    },
  },
  {
    test: (l) => /dd-?214|certificate of release/.test(l),
    action: {
      how: 'Your DD-214 proves military service for almost every veteran benefit and grant.',
      checklist: [
        'Request a copy via VA.gov or eBenefits if you do not have one',
        'Upload a copy to Documents (keep it private)',
        'Confirm veteran status on military service',
      ],
      official_url: 'https://www.va.gov/records/get-military-service-records/',
      official_label: 'Request military records (VA)',
      profile_section: 'military_service',
      documents: true,
      document_hint: 'DD-214',
      anya_prompt: 'Help me obtain my DD-214 and attach it for veteran funding.',
    },
  },
  {
    test: (l) => /fema|disasterassistance\.gov/.test(l),
    action: {
      how: 'FEMA registration is step one after a declared disaster — it opens housing, SBA, and other aid paths.',
      checklist: [
        'Confirm your county is in a declared disaster area',
        'Register at DisasterAssistance.gov',
        'Document damage with photos',
        'Upload FEMA registration confirmation',
      ],
      official_url: 'https://www.disasterassistance.gov/',
      official_label: 'Register with FEMA',
      profile_section: 'financial_information',
      documents: true,
      document_hint: 'FEMA registration confirmation',
      anya_prompt: 'Help me register with FEMA and gather the documents they need.',
    },
  },
]

const CATEGORY_DEFAULTS = {
  documentation: {
    how: 'Gather the documents funders ask for and keep them on your profile so applications go faster.',
    checklist: [
      'Collect the required files (letters, plans, certificates)',
      'Upload them under Documents for this profile',
      'Add a short note in your narrative if the document proves need or capacity',
    ],
    documents: true,
  },
  insurance: {
    how: 'Get the right insurance certificate on file — many grants and licenses stop without it.',
    checklist: [
      'Identify the coverage type named in this step',
      'Request a certificate of insurance from your broker',
      'Upload the certificate to Documents',
    ],
    documents: true,
    document_hint: 'Certificate of insurance',
  },
  legal: {
    how: 'Complete the legal filing or license this step names, then record proof on your profile.',
    checklist: [
      'Identify the issuing agency (city, county, state, or IRS)',
      'Submit the application or registration',
      'Upload the approval letter or license',
      'Update organization details with any new numbers (EIN, license #)',
    ],
    documents: true,
  },
  compliance: {
    how: 'Finish the compliance registration this step names so you stay eligible for the funding pool.',
    checklist: [
      'Open the official registration or enrollment site',
      'Complete required forms and keep confirmation numbers',
      'Upload proof to Documents and note status on the profile',
    ],
    documents: true,
  },
  planning: {
    how: 'Write down the plan funders expect — then save it so proposals can reuse it.',
    checklist: [
      'Draft the plan or partnership notes in plain language',
      'Add key points under programs & services or narrative',
      'Upload a finished PDF if you have one',
    ],
    documents: true,
  },
  financial: {
    how: 'Set up the financial account or budget artifact this step requires.',
    checklist: [
      'Complete the banking or budget step',
      'Record relevant amounts under financial information',
      'Upload statements or budgets if funders will ask for them',
    ],
    documents: true,
  },
  financial_aid: {
    how: 'Start the aid application on the official site, then update your profile status.',
    checklist: [
      'Open the official application',
      'Submit and save confirmation',
      'Update education / financial sections and Documents',
    ],
    documents: true,
  },
  benefits: {
    how: 'Enroll through the official benefits channel, then record enrollment on your profile.',
    checklist: [
      'Check eligibility on the official site',
      'Submit the application',
      'Update government assistance / financial sections',
    ],
    documents: true,
  },
  governance: {
    how: 'Document board or governance steps funders expect to see.',
    checklist: [
      'List board members and meeting cadence',
      'Save bylaws / minutes if available',
      'Upload governance documents',
    ],
    documents: true,
  },
  operations: {
    how: 'Secure the operational capability this step names and keep proof on file.',
    checklist: [
      'Identify vendors or partners needed',
      'Get written agreements where possible',
      'Upload agreements to Documents',
    ],
    documents: true,
  },
  equipment: {
    how: 'Specify the equipment need with quotes — funders rarely fund vague asks.',
    checklist: [
      'List make/model and estimated cost',
      'Get at least one vendor quote',
      'Upload quotes to Documents and note the need under financial information',
    ],
    documents: true,
  },
  safety: {
    how: 'Use the official hotline or safety path first — then document only what you are comfortable sharing.',
    checklist: [
      'Contact the official safety resource named in this step',
      'Follow their local referral guidance',
      'Add only non-sensitive next-step notes to your profile if helpful',
    ],
    documents: false,
  },
  education: {
    how: 'Complete the education step and record progress on your profile.',
    checklist: [
      'Enroll or request the credential',
      'Update education section',
      'Upload certificates when received',
    ],
    documents: true,
  },
}

function categoryDefault(category) {
  const key = String(category || '').toLowerCase()
  return CATEGORY_DEFAULTS[key] || {
    how: 'Complete this real-world step, then save proof on your profile so funding applications move faster.',
    checklist: [
      'Follow the official process for this requirement',
      'Save confirmation or documents',
      'Update the matching profile section when done',
    ],
    documents: true,
  }
}

/**
 * Attach actionable fields to a {label, category, why, section_key?, field?}
 * success step.
 *
 * The profile deep link (`profile_section` / `profile_field`) is OPT-IN per
 * step: an explicit `section_key` from the archetype wins, then a per-step
 * ACTION_PATTERNS match. A category NEVER implies an editor — "legal" holds an
 * EIN filing (organization_details.ein) and an immigration document (no home
 * on the profile), and "planning" holds a sustainability plan (narrative) and
 * a phone call to 211. Steps without a verified destination stay plain rows
 * rather than links that land the user on an unrelated section.
 * @returns {object} serializable step (no functions)
 */
export function enrichSuccessStep(step) {
  const label = String(step?.label || '').trim()
  const category = String(step?.category || 'planning')
  const why = String(step?.why || '')
  const id = successStepId(label)
  const lower = label.toLowerCase()

  let matched = null
  for (const row of ACTION_PATTERNS) {
    if (row.test(lower)) {
      matched = row.action
      break
    }
  }

  const fallback = categoryDefault(category)
  const action = {
    how: matched?.how || fallback.how,
    checklist: Array.isArray(matched?.checklist) && matched.checklist.length
      ? matched.checklist
      : fallback.checklist,
    official_url: matched?.official_url ?? null,
    official_label: matched?.official_label ?? null,
    profile_section: step?.section_key || matched?.profile_section || null,
    profile_field: step?.section_key && step?.field ? String(step.field) : null,
    documents: matched?.documents ?? fallback.documents ?? false,
    document_hint: matched?.document_hint || fallback.document_hint || null,
    anya_prompt:
      matched?.anya_prompt ||
      `Help me complete this funding readiness step: ${label}. ${why}`.trim(),
  }

  return {
    id,
    label,
    category,
    why,
    how: action.how,
    checklist: action.checklist,
    official_url: action.official_url,
    official_label: action.official_label,
    profile_section: action.profile_section,
    profile_field: action.profile_field,
    documents: Boolean(action.documents),
    document_hint: action.document_hint,
    anya_prompt: action.anya_prompt,
  }
}

async function ensureKv(db) {
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)',
  ).run()
}

function kvKey(profileId) {
  return `${SUCCESS_STEPS_KV_PREFIX}${String(profileId)}`
}

/**
 * @returns {Promise<{ completed: Record<string, { completed_at: string, label?: string }> }>}
 */
export async function loadSuccessStepCompletion(db, profileId) {
  if (!db?.prepare || !profileId) return { completed: {} }
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(kvKey(profileId))
    if (!row?.value) return { completed: {} }
    const parsed = JSON.parse(row.value)
    const completed = parsed?.completed && typeof parsed.completed === 'object' ? parsed.completed : {}
    return { completed }
  } catch {
    return { completed: {} }
  }
}

/**
 * Mark a success step complete or incomplete for one profile.
 * @returns {Promise<{ completed: Record<string, object>, step_id: string, is_completed: boolean }>}
 */
export async function setSuccessStepCompletion(db, profileId, stepId, { completed, label } = {}) {
  const id = successStepId(stepId)
  if (!id) throw new Error('step_id is required')
  await ensureKv(db)
  const store = await loadSuccessStepCompletion(db, profileId)
  const next = { ...store.completed }
  const isCompleted = completed !== false
  if (isCompleted) {
    next[id] = {
      completed_at: new Date().toISOString(),
      label: label ? String(label).slice(0, 200) : undefined,
    }
  } else {
    delete next[id]
  }
  const payload = JSON.stringify({ completed: next, updated_at: new Date().toISOString() })
  const now = new Date().toISOString()
  const key = kvKey(profileId)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(payload, now, key)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, payload, now)
  }
  return { completed: next, step_id: id, is_completed: isCompleted }
}

/**
 * Merge completion flags onto enriched steps. Counts map 1:1 to the arrays.
 */
export function applySuccessStepCompletion(steps, completionStore) {
  const completed = completionStore?.completed && typeof completionStore.completed === 'object'
    ? completionStore.completed
    : {}
  const withFlags = (Array.isArray(steps) ? steps : []).map((step) => {
    const row = completed[step.id]
    return {
      ...step,
      completed: Boolean(row),
      completed_at: row?.completed_at || null,
    }
  })
  const completed_count = withFlags.filter((s) => s.completed).length
  return {
    success_steps: withFlags,
    success_steps_completed: completed_count,
    success_steps_total: withFlags.length,
  }
}
