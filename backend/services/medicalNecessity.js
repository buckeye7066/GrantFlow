/**
 * Medical Necessity Service
 *
 * Generates Letters of Medical Necessity (LOMN), medical justification
 * statements, and DME justifications using profile health data.
 * Detects which pipeline opportunities require medical necessity
 * documentation and flags them for the user.
 */

import { createOpenAIClient } from '../utils/openaiClient.js'
import { invokeTextWithFallback as invokeProviderTextWithFallback } from '../utils/aiProviders.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('medicalNecessity')

// ─── Document Types ──────────────────────────────────────────────────────────

export const DOCUMENT_TYPES = {
  LOMN: 'letter_of_medical_necessity',
  DME_JUSTIFICATION: 'dme_justification',
  DISABILITY_STATEMENT: 'disability_statement',
  INSURANCE_APPEAL: 'insurance_appeal',
  PRIOR_AUTH: 'prior_authorization',
  FUNCTIONAL_LIMITATION: 'functional_limitation_report',
}

// Keywords in opportunity descriptions that signal medical necessity is needed
const MED_NEC_TRIGGERS = [
  'medical necessity', 'letter of medical necessity', 'lomn',
  'physician letter', 'doctor letter', 'medical documentation',
  'dme', 'durable medical equipment', 'assistive technology',
  'assistive device', 'prior authorization', 'prior auth',
  'medicaid waiver', 'disability verification', 'functional limitation',
  'medical justification', 'clinical justification',
  'insurance appeal', 'denial appeal', 'coverage determination',
  'diagnosis required', 'medical records required',
  'disability documentation', 'ada accommodation',
]

// ─── Profile Data Extraction ─────────────────────────────────────────────────

export async function extractMedicalProfile(db, profileId) {
  if (!db || !profileId) return null

  if (!db?.prepare) throw new Error('Invalid database connection')
  let profile
  try {
    profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
  } catch (dbErr) {
    log.error('[medicalNecessity] DB error fetching profile', profileId, dbErr)
    throw new Error(`Database error fetching profile ${profileId}: ${dbErr.message}`)
  }
  if (!profile) return null

  let rows
  try {
    rows = await db.prepare(
      'SELECT section_key, data FROM profile_sections WHERE profile_id = ?'
    ).all(profileId)
  } catch (dbErr) {
    log.error('[medicalNecessity] DB error fetching profile sections', profileId, dbErr)
    rows = []
  }

  const sections = {}
  for (const r of (rows || [])) {
    try {
      sections[r.section_key] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data
    } catch (parseErr) {
      console.warn('[medicalNecessity] Failed to parse section', r.section_key, 'for profile', profileId, parseErr.message)
    }
  }

  const health = (sections.health_medical && typeof sections.health_medical === 'object') ? sections.health_medical : {}
  const medHist = sections.medical_history || {}
  const medIns = sections.medical_insurance || {}
  const basic = sections.basic_information || {}
  const family = sections.family_life || {}
  const fin = sections.financial_information || sections.financial || {}
  const gov = sections.government_assistance || {}
  const loc = sections.location_focus || {}

  const conditions = extractConditions(health, medHist)
  const disabilities = extractDisabilities(health, medHist)
  const dmeNeeds = extractDMENeeds(health, medHist)
  const functionalLimitations = extractFunctionalLimitations(health, medHist)
  const insuranceInfo = extractInsurance(medIns, gov)

  const addr = basic.address || {}

  return {
    name: profile.display_name || basic.full_name || 'the patient',
    dateOfBirth: basic.date_of_birth || basic.dob || null,
    age: basic.age || null,
    gender: basic.gender || null,
    location: {
      city: basic.city || (typeof addr === 'object' ? addr.city : null) || null,
      state: basic.state || (typeof addr === 'object' ? addr.state : null) || loc.state || null,
      zip: basic.zip_code || (typeof addr === 'object' ? (addr.zip_code || addr.zip) : null) || null,
    },
    conditions,
    disabilities,
    dmeNeeds,
    functionalLimitations,
    insurance: insuranceInfo,
    supportNeeds: Array.isArray(health.support_needs) ? health.support_needs : [],
    supportNeedsLevel: health.support_needs_level || null,
    physician: {
      name: medHist.doctor_name || null,
      clinic: medHist.clinic_name || null,
    },
    letterSupportNeeded: medHist.letter_support_needed === true,
    financialContext: {
      income: fin.household_income || fin.annual_income || null,
      householdSize: fin.household_size || null,
      needLevel: fin.financial_need_level || null,
    },
    medicaid: gov.medicaid_enrolled === true || insuranceInfo.hasMedicaid,
    medicare: gov.medicare_recipient === true || insuranceInfo.hasMedicare,
    waiverProgram: gov.medicaid_waiver_program || null,
    familyContext: {
      caregiver: family.family_caregiver === true,
      singleParent: family.single_parent === true,
      dependentsWithDisabilities: family.dependents_with_disabilities === true,
    },
  }
}

function extractConditions(health, medHist) {
  const conditions = []
  if (Array.isArray(health.conditions)) {
    for (const c of health.conditions) {
      if (typeof c === 'string') conditions.push({ name: c })
      else if (c?.name) conditions.push(c)
    }
  }
  if (health.chronic_illness_type) {
    conditions.push({ name: health.chronic_illness_type, chronic: true })
  }
  if (medHist.primary_condition) {
    const existing = conditions.find(c => c.name?.toLowerCase() === medHist.primary_condition.toLowerCase())
    if (!existing) conditions.push({ name: medHist.primary_condition, primary: true })
  }
  if (Array.isArray(medHist.secondary_conditions)) {
    for (const sc of medHist.secondary_conditions) {
      const existing = conditions.find(c => c.name?.toLowerCase() === sc.toLowerCase())
      if (!existing) conditions.push({ name: sc, secondary: true })
    }
  }

  // Boolean flags as conditions
  const boolFlags = [
    ['chronic_illness', 'Chronic illness'],
    ['dialysis_patient', 'End-stage renal disease (dialysis)'],
    ['organ_transplant', 'Organ transplant recipient'],
    ['hiv_aids', 'HIV/AIDS'],
    ['tbi_survivor', 'Traumatic brain injury'],
    ['cancer_survivor', 'Cancer (survivor/active treatment)'],
    ['substance_recovery', 'Substance use disorder (in recovery)'],
    ['mental_health_condition', 'Mental health condition'],
  ]
  for (const [flag, label] of boolFlags) {
    if (health[flag] && !conditions.find(c => c.name?.toLowerCase().includes(label.split(' ')[0].toLowerCase()))) {
      conditions.push({ name: label, fromFlag: true })
    }
  }
  return conditions
}

function extractDisabilities(health, medHist) {
  const disabilities = new Set()
  if (Array.isArray(health.disability_type)) {
    health.disability_type.forEach(d => disabilities.add(d))
  } else if (typeof health.disability_type === 'string' && health.disability_type) {
    health.disability_type.split(',').map(s => s.trim()).filter(Boolean).forEach(d => disabilities.add(d))
  }
  if (health.visual_impairment) disabilities.add('Visual impairment')
  if (health.hearing_impairment) disabilities.add('Hearing impairment')
  if (health.wheelchair_user) disabilities.add('Mobility impairment (wheelchair user)')
  if (health.amputee) disabilities.add('Amputee')
  if (health.neurodivergent) disabilities.add('Neurodivergent (ASD/ADHD)')
  if (medHist.mobility_needs) disabilities.add(`Mobility: ${medHist.mobility_needs}`)
  return [...disabilities]
}

function extractDMENeeds(health, medHist) {
  const needs = []
  if (Array.isArray(medHist.dme_needed)) {
    needs.push(...medHist.dme_needed)
  }
  if (health.wheelchair_user) needs.push('Wheelchair')
  if (health.visual_impairment) needs.push('Vision aids / assistive technology')
  if (health.hearing_impairment) needs.push('Hearing aids / assistive listening devices')
  return [...new Set(needs)]
}

function extractFunctionalLimitations(health, medHist) {
  const limitations = []
  if (health.wheelchair_user) limitations.push('Unable to ambulate independently; requires wheelchair for all mobility')
  if (health.visual_impairment) limitations.push('Significant visual impairment affecting activities of daily living')
  if (health.hearing_impairment) limitations.push('Hearing impairment affecting communication and safety awareness')
  if (health.dialysis_patient) limitations.push('Requires regular dialysis treatment; limited energy and mobility around treatment schedule')
  if (health.tbi_survivor) limitations.push('Cognitive and/or physical limitations resulting from traumatic brain injury')
  if (health.amputee) limitations.push('Limb loss affecting mobility, self-care, and/or vocational activities')
  if (medHist.mobility_needs) limitations.push(`Mobility limitation: ${medHist.mobility_needs}`)
  if (health.support_needs_level === 'high') limitations.push('Requires high level of daily support for activities of daily living')
  return limitations
}

function extractInsurance(medIns, gov) {
  const planType = (medIns.plan_type || '').toLowerCase()
  return {
    provider: medIns.insurance_provider || null,
    planName: medIns.plan_name || null,
    planType: medIns.plan_type || null,
    memberId: medIns.member_id || null,
    hasMedicaid: planType.includes('medicaid') || gov.medicaid_enrolled === true,
    hasMedicare: planType.includes('medicare') || gov.medicare_recipient === true,
    phone: medIns.phone_for_claims || null,
  }
}

// ─── Opportunity Scanning ────────────────────────────────────────────────────

export function requiresMedicalNecessity(opportunity) {
  if (!opportunity) return { required: false, triggers: [] }
  const text = [
    opportunity.title, opportunity.description,
    opportunity.eligibility_bullets, opportunity.applicationNote,
    opportunity.application_steps,
  ].filter(Boolean).join(' ').toLowerCase()

  const triggers = MED_NEC_TRIGGERS.filter(t => text.includes(t))
  return {
    required: triggers.length > 0,
    triggers,
    suggestedDocType: guessBestDocType(triggers),
  }
}

function guessBestDocType(triggers) {
  const joined = triggers.join(' ')
  if (joined.includes('dme') || joined.includes('durable medical') || joined.includes('assistive')) return DOCUMENT_TYPES.DME_JUSTIFICATION
  if (joined.includes('prior auth')) return DOCUMENT_TYPES.PRIOR_AUTH
  if (joined.includes('appeal') || joined.includes('denial')) return DOCUMENT_TYPES.INSURANCE_APPEAL
  if (joined.includes('disability')) return DOCUMENT_TYPES.DISABILITY_STATEMENT
  if (joined.includes('functional')) return DOCUMENT_TYPES.FUNCTIONAL_LIMITATION
  return DOCUMENT_TYPES.LOMN
}

export async function scanPipelineForMedNec(db, profileId) {
  let grants
  try {
    grants = await db.prepare(`
      SELECT g.id, g.title, g.status, g.funding_opportunity_id, g.application_method,
             fo.description, fo.eligibility_bullets, fo.application_url
      FROM grants g
      LEFT JOIN funding_opportunities fo ON g.funding_opportunity_id = fo.id
      WHERE g.profile_id = ? AND g.status NOT IN ('closed', 'declined', 'archived')
    `).all(profileId)
  } catch (dbErr) {
    log.error('[medicalNecessity] scanPipelineForMedNec DB error for profile', profileId, dbErr)
    return []
  }

  const flagged = []
  for (const g of (grants || [])) {
    const check = requiresMedicalNecessity(g)
    if (check.required) {
      flagged.push({
        grantId: g.id,
        title: g.title,
        status: g.status,
        triggers: check.triggers,
        suggestedDocType: check.suggestedDocType,
      })
    }
  }
  return flagged
}

// ─── Document Generation ─────────────────────────────────────────────────────

export async function generateMedicalNecessityDocument(db, profileId, options = {}) {
  const {
    documentType = DOCUMENT_TYPES.LOMN,
    opportunityId = null,
    grantId = null,
    specificEquipment = null,
    specificCondition = null,
    additionalContext = null,
  } = options

  const medProfile = await extractMedicalProfile(db, profileId)
  if (!medProfile) throw new Error('Profile not found or no medical data available')

  if (medProfile.conditions.length === 0 && medProfile.disabilities.length === 0) {
    throw new Error('No medical conditions or disabilities found in profile. Please update health information before generating medical necessity documentation.')
  }

  let opportunity = null
  if (opportunityId) {
    opportunity = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(opportunityId)
  }
  let grant = null
  if (grantId) {
    grant = await db.prepare('SELECT * FROM grants WHERE id = ?').get(grantId)
    if (!opportunity && grant?.funding_opportunity_id) {
      opportunity = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(grant.funding_opportunity_id)
    }
  }

  const prompt = buildDocumentPrompt(documentType, medProfile, opportunity, grant, {
    specificEquipment, specificCondition, additionalContext,
  })

  let openai = null
  try {
    const client = createOpenAIClient({ allowMissing: true })
    openai = client?.openai || null
    const providerResult = await invokeProviderTextWithFallback({
    openai,
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    system: getMedNecSystemPrompt(documentType),
    prompt,
    temperature: 0.6,
    maxTokens: 3000,
  })

  if (providerResult.ok && providerResult.text) {
    const content = providerResult.text.trim()
    log.info(`[medicalNecessity] Generated ${documentType} for profile ${profileId} (${content.length} chars)`)
    return {
      type: documentType,
      content,
      generated: 'ai',
      provider: providerResult.provider,
      profile: summarizeProfile(medProfile),
      usage: providerResult.usage || null,
    }
  }

  log.error('[medicalNecessity] AI generation failed; using grounded template', providerResult.error?.message)
  return {
    type: documentType,
    content: buildTemplateDocument(documentType, medProfile, opportunity, grant, options),
    generated: 'template_fallback',
    error: providerResult.error?.message || 'Every configured AI provider failed',
    profile: summarizeProfile(medProfile),
  }


function summarizeProfile(medProfile) {
  return {
    name: medProfile.name,
    conditionCount: medProfile.conditions.length,
    disabilityCount: medProfile.disabilities.length,
    dmeCount: medProfile.dmeNeeds.length,
    hasMedicaid: medProfile.medicaid,
    hasMedicare: medProfile.medicare,
    hasPhysician: Boolean(medProfile.physician?.name),
    letterSupportNeeded: medProfile.letterSupportNeeded,
  }
}

// ─── Prompt Construction ─────────────────────────────────────────────────────

function getMedNecSystemPrompt(documentType) {
  const base = `You are a medical documentation specialist and healthcare advocate with 20+ years of experience writing medical necessity documentation for patients seeking funding, insurance coverage, disability accommodations, and durable medical equipment.

You write at a clinical-professional level that satisfies:
- Insurance company medical reviewers
- Medicaid/Medicare administrators
- Grant review committees
- Disability determination services
- Equipment funding programs

RULES:
- Use the patient's REAL medical data — never use placeholders like [INSERT] or [TBD]
- Include specific diagnoses, ICD-10 codes when the condition is identifiable
- Describe functional limitations concretely — how the condition affects daily living
- Reference standard clinical criteria (InterQual, MCG, Medicare LCD/NCD) when applicable
- Maintain HIPAA-appropriate professional language
- Structure documents per industry standard format for the document type
- Include signature blocks for physician review and signature
- Be persuasive but factually grounded — reviewers are clinical professionals`

  const typeSpecific = {
    [DOCUMENT_TYPES.LOMN]: `\n\nYou are writing a Letter of Medical Necessity (LOMN). This is a formal letter from a healthcare provider that documents why a specific service, item, or procedure is medically necessary for the patient. Structure: Date, Patient Info, To Whom It May Concern, Diagnosis/History, Functional Limitations, Medical Justification, Requested Service/Item, Conclusion, Physician Signature Block.`,
    [DOCUMENT_TYPES.DME_JUSTIFICATION]: `\n\nYou are writing a DME (Durable Medical Equipment) Justification letter. Document why specific equipment is essential for the patient's medical condition, functional independence, and safety. Include: diagnosis, functional limitations, specific equipment requested, why no lesser alternative is sufficient, expected duration of need, and how the equipment will improve the patient's condition or prevent deterioration.`,
    [DOCUMENT_TYPES.DISABILITY_STATEMENT]: `\n\nYou are writing a Disability Verification Statement. Document the nature, severity, and functional impact of the disability. Include: diagnoses, onset/duration, functional limitations (mobility, communication, self-care, work capacity), expected prognosis, accommodations needed, and clinician assessment of disability severity.`,
    [DOCUMENT_TYPES.INSURANCE_APPEAL]: `\n\nYou are writing an Insurance Appeal Letter. This is a formal appeal of a coverage denial. Structure: Reference denial letter/date, summarize denied service, present medical evidence for necessity, cite relevant coverage criteria (LCD, NCD, plan language), describe consequences of non-coverage, request expedited review if urgent, physician signature block.`,
    [DOCUMENT_TYPES.PRIOR_AUTH]: `\n\nYou are writing a Prior Authorization Request narrative. Document the clinical rationale for the requested service or equipment. Include: patient history, current symptoms, failed conservative treatments, clinical necessity per payer criteria, requested service with CPT/HCPCS codes where identifiable, expected outcome.`,
    [DOCUMENT_TYPES.FUNCTIONAL_LIMITATION]: `\n\nYou are writing a Functional Limitation Report. Document specific measurable limitations in: mobility, self-care, communication, cognition, social functioning, and work capacity. Use clinical assessment language (e.g., "Patient is unable to ambulate more than 50 feet without rest" rather than "Patient has difficulty walking").`,
  }

  return base + (typeSpecific[documentType] || '')
}

function buildDocumentPrompt(documentType, medProfile, opportunity, grant, options) {
  const parts = []

  parts.push('PATIENT INFORMATION:')
  parts.push(`Name: ${medProfile.name}`)
  if (medProfile.dateOfBirth) parts.push(`Date of Birth: ${medProfile.dateOfBirth}`)
  if (medProfile.age) parts.push(`Age: ${medProfile.age}`)
  if (medProfile.gender) parts.push(`Gender: ${medProfile.gender}`)
  if (medProfile.location.city || medProfile.location.state) {
    parts.push(`Location: ${[medProfile.location.city, medProfile.location.state, medProfile.location.zip].filter(Boolean).join(', ')}`)
  }

  parts.push('\nDIAGNOSES / CONDITIONS:')
  if (medProfile.conditions.length > 0) {
    for (const c of medProfile.conditions) {
      let line = `- ${c.name}`
      if (c.icd10) line += ` (ICD-10: ${c.icd10})`
      if (c.chronic) line += ' [chronic]'
      if (c.primary) line += ' [primary diagnosis]'
      if (c.stage) line += ` [stage: ${c.stage}]`
      if (c.diagnosed_year) line += ` [diagnosed: ${c.diagnosed_year}]`
      parts.push(line)
    }
  } else {
    parts.push('- No specific conditions documented')
  }

  if (medProfile.disabilities.length > 0) {
    parts.push('\nDISABILITIES:')
    medProfile.disabilities.forEach(d => parts.push(`- ${d}`))
  }

  if (medProfile.functionalLimitations.length > 0) {
    parts.push('\nFUNCTIONAL LIMITATIONS:')
    medProfile.functionalLimitations.forEach(l => parts.push(`- ${l}`))
  }

  if (medProfile.dmeNeeds.length > 0 || options.specificEquipment) {
    parts.push('\nDME / EQUIPMENT NEEDS:')
    if (options.specificEquipment) parts.push(`- REQUESTED: ${options.specificEquipment}`)
    medProfile.dmeNeeds.forEach(d => parts.push(`- ${d}`))
  }

  parts.push('\nINSURANCE:')
  if (medProfile.insurance.provider) parts.push(`Provider: ${medProfile.insurance.provider}`)
  if (medProfile.insurance.planName) parts.push(`Plan: ${medProfile.insurance.planName}`)
  if (medProfile.insurance.planType) parts.push(`Type: ${medProfile.insurance.planType}`)
  if (medProfile.medicaid) parts.push('Enrolled in Medicaid')
  if (medProfile.medicare) parts.push('Enrolled in Medicare')
  if (medProfile.waiverProgram) parts.push(`Waiver Program: ${medProfile.waiverProgram}`)

  if (medProfile.physician.name || medProfile.physician.clinic) {
    parts.push('\nPHYSICIAN:')
    if (medProfile.physician.name) parts.push(`Name: ${medProfile.physician.name}`)
    if (medProfile.physician.clinic) parts.push(`Clinic: ${medProfile.physician.clinic}`)
  }

  if (medProfile.supportNeeds.length > 0) {
    parts.push('\nSUPPORT NEEDS:')
    medProfile.supportNeeds.forEach(s => parts.push(`- ${s}`))
    if (medProfile.supportNeedsLevel) parts.push(`Support Level: ${medProfile.supportNeedsLevel}`)
  }

  if (medProfile.financialContext.income || medProfile.financialContext.needLevel) {
    parts.push('\nFINANCIAL CONTEXT:')
    if (medProfile.financialContext.income) parts.push(`Household Income: $${medProfile.financialContext.income}`)
    if (medProfile.financialContext.householdSize) parts.push(`Household Size: ${medProfile.financialContext.householdSize}`)
    if (medProfile.financialContext.needLevel) parts.push(`Need Level: ${medProfile.financialContext.needLevel}`)
  }

  if (opportunity) {
    parts.push('\nFUNDING OPPORTUNITY / PROGRAM:')
    parts.push(`Title: ${opportunity.title}`)
    if (opportunity.sponsor) parts.push(`Sponsor: ${opportunity.sponsor}`)
    if (opportunity.description) parts.push(`Description: ${opportunity.description.slice(0, 500)}`)
    if (opportunity.eligibility_bullets) parts.push(`Eligibility: ${opportunity.eligibility_bullets}`)
  }

  if (options.specificCondition) {
    parts.push(`\nFOCUS CONDITION: ${options.specificCondition}`)
  }
  if (options.additionalContext) {
    parts.push(`\nADDITIONAL CONTEXT: ${options.additionalContext}`)
  }

  const typeLabels = {
    [DOCUMENT_TYPES.LOMN]: 'a Letter of Medical Necessity (LOMN)',
    [DOCUMENT_TYPES.DME_JUSTIFICATION]: 'a DME Justification Letter',
    [DOCUMENT_TYPES.DISABILITY_STATEMENT]: 'a Disability Verification Statement',
    [DOCUMENT_TYPES.INSURANCE_APPEAL]: 'an Insurance Appeal Letter',
    [DOCUMENT_TYPES.PRIOR_AUTH]: 'a Prior Authorization Request Narrative',
    [DOCUMENT_TYPES.FUNCTIONAL_LIMITATION]: 'a Functional Limitation Report',
  }

  parts.push(`\nPlease generate ${typeLabels[documentType] || 'a medical necessity document'} using all of the above patient data. The document should be ready for a physician to review, sign, and submit.`)

  return parts.join('\n')
}

// ─── Template Fallback ───────────────────────────────────────────────────────

function buildTemplateDocument(documentType, medProfile, opportunity, grant, options) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const patientName = medProfile.name
  const physicianName = medProfile.physician?.name || '[Physician Name]'
  const clinicName = medProfile.physician?.clinic || '[Clinic/Practice Name]'
  const conditionList = medProfile.conditions.map(c => c.name).join(', ') || '[Primary Diagnosis]'

  switch (documentType) {
    case DOCUMENT_TYPES.LOMN:
      return buildLomnTemplate(today, patientName, physicianName, clinicName, conditionList, medProfile, opportunity, options)
    case DOCUMENT_TYPES.DME_JUSTIFICATION:
      return buildDmeTemplate(today, patientName, physicianName, clinicName, conditionList, medProfile, options)
    case DOCUMENT_TYPES.DISABILITY_STATEMENT:
      return buildDisabilityTemplate(today, patientName, physicianName, clinicName, conditionList, medProfile)
    default:
      return buildLomnTemplate(today, patientName, physicianName, clinicName, conditionList, medProfile, opportunity, options)
  }
}

function buildLomnTemplate(today, patientName, physicianName, clinicName, conditionList, medProfile, opportunity, options) {
  const dob = medProfile.dateOfBirth || '[Date of Birth]'
  const equipment = options?.specificEquipment || medProfile.dmeNeeds.join(', ') || '[Requested Service/Equipment]'
  const insuranceId = medProfile.insurance?.memberId || '[Member ID]'
  const insuranceName = medProfile.insurance?.provider || '[Insurance Provider]'

  const limitations = medProfile.functionalLimitations.length > 0
    ? medProfile.functionalLimitations.map(l => `  - ${l}`).join('\n')
    : '  - [Describe specific functional limitations here]'

  const oppContext = opportunity
    ? `\nThis documentation is being submitted in support of ${patientName}'s application to: ${opportunity.title}${opportunity.sponsor ? ` (${opportunity.sponsor})` : ''}.\n`
    : ''

  return `${clinicName}
[Address]
[City, State ZIP]
[Phone] | [Fax]

${today}

RE: Letter of Medical Necessity
Patient: ${patientName}
Date of Birth: ${dob}
Insurance: ${insuranceName} | Member ID: ${insuranceId}

To Whom It May Concern:

I am writing to document the medical necessity of ${equipment} for my patient, ${patientName}. ${patientName} is under my care for the following diagnoses:

  ${conditionList}

CLINICAL HISTORY:
${patientName} presents with the above conditions which significantly impact their ability to perform activities of daily living. ${medProfile.conditions.length > 0 ? `The primary condition, ${medProfile.conditions[0].name}, ${medProfile.conditions[0].chronic ? 'is chronic in nature and' : ''} requires ongoing management and support.` : '[Describe clinical history and progression]'}

FUNCTIONAL LIMITATIONS:
The following functional limitations have been clinically observed and documented:
${limitations}

MEDICAL JUSTIFICATION:
Based on my clinical assessment, ${equipment} is medically necessary for ${patientName} because:
1. The patient's conditions directly cause the functional limitations described above
2. The requested service/equipment is the least restrictive means to address these limitations
3. Without this service/equipment, the patient's condition is expected to deteriorate
4. Standard conservative treatments have been attempted or are insufficient
${oppContext}
It is my professional medical opinion that this request meets the standard criteria for medical necessity. I am available to provide additional clinical documentation upon request.

Sincerely,

_________________________________
${physicianName}, MD
${clinicName}
NPI: [NPI Number]
Date: ${today}

[This letter has been prepared using GrantFlow's medical necessity documentation tool. It should be reviewed, customized, and signed by the treating physician before submission.]`
}

function buildDmeTemplate(today, patientName, physicianName, clinicName, conditionList, medProfile, options) {
  const equipment = options?.specificEquipment || medProfile.dmeNeeds[0] || '[Specific Equipment]'
  const allDme = medProfile.dmeNeeds.length > 0 ? medProfile.dmeNeeds.map(d => `- ${d}`).join('\n') : `- ${equipment}`

  return `${clinicName}
${today}

RE: Durable Medical Equipment (DME) Justification
Patient: ${patientName}

To Whom It May Concern:

I am the treating physician for ${patientName} and am writing to document the medical necessity of the following durable medical equipment:

EQUIPMENT REQUESTED:
${allDme}

DIAGNOSES:
${conditionList}

CLINICAL JUSTIFICATION:
${patientName} requires the above equipment due to functional limitations resulting from their diagnosed conditions. ${medProfile.functionalLimitations.length > 0 ? 'Specifically:\n' + medProfile.functionalLimitations.map(l => `- ${l}`).join('\n') : '[Describe how the condition creates the need for this equipment]'}

The requested equipment is:
1. Required to serve a medical purpose for the patient's condition
2. Not useful to a person who is not ill or injured
3. Appropriate for use in the patient's home or community setting
4. Expected to last for a significant period (durable)
5. The least costly alternative that meets the patient's medical needs

EXPECTED DURATION OF NEED: ${medProfile.conditions.some(c => c.chronic) ? 'Indefinite (chronic condition)' : '[Estimated duration]'}

CONSEQUENCES WITHOUT EQUIPMENT:
Without the requested equipment, ${patientName} faces:
- Increased risk of injury or medical deterioration
- Inability to perform essential activities of daily living
- Potential for hospitalization or higher-cost medical interventions

Sincerely,

_________________________________
${physicianName}, MD
${clinicName}
Date: ${today}

[Review, customize, and obtain physician signature before submission.]`
}

function buildDisabilityTemplate(today, patientName, physicianName, clinicName, conditionList, medProfile) {
  return `${clinicName}
${today}

RE: Disability Verification Statement
Patient: ${patientName}

To Whom It May Concern:

I am the treating physician for ${patientName} and am providing this statement to verify their disability status and functional limitations.

DIAGNOSES:
${conditionList}

DISABILITIES:
${medProfile.disabilities.length > 0 ? medProfile.disabilities.map(d => `- ${d}`).join('\n') : '- [Specify disabilities]'}

ONSET / DURATION:
${medProfile.conditions.some(c => c.diagnosed_year) ? medProfile.conditions.filter(c => c.diagnosed_year).map(c => `- ${c.name}: diagnosed ${c.diagnosed_year}`).join('\n') : '[Date of onset / duration of disability]'}

FUNCTIONAL LIMITATIONS:
${medProfile.functionalLimitations.length > 0 ? medProfile.functionalLimitations.map(l => `- ${l}`).join('\n') : '- [Describe functional limitations in mobility, self-care, communication, cognition, and/or work capacity]'}

SEVERITY ASSESSMENT:
Support needs level: ${medProfile.supportNeedsLevel || '[Mild / Moderate / Severe]'}

PROGNOSIS:
${medProfile.conditions.some(c => c.chronic) ? 'The above conditions are chronic in nature. Significant improvement is not expected, and ongoing support services are medically necessary.' : '[Expected prognosis and whether the disability is temporary or permanent]'}

ACCOMMODATIONS RECOMMENDED:
${medProfile.supportNeeds.length > 0 ? medProfile.supportNeeds.map(s => `- ${s}`).join('\n') : '- [Recommended accommodations]'}

I certify that the above information is accurate to the best of my professional knowledge.

Sincerely,

_________________________________
${physicianName}, MD
${clinicName}
Date: ${today}

[Review, customize, and obtain physician signature before submission.]`
}
