/**
 * hamiltonFullProposalGenerator.js
 *
 * Hamilton's "full grant proposal" author. Where
 * hamiltonApplicationPacketGenerator.js assembles a submission PACKET
 * (cover sheet + applicant info + mailing instructions from the raw
 * profile fields), THIS module drafts a complete, MBA-experienced-
 * grant-writer-level NARRATIVE proposal: need statement, SMART
 * goals/objectives, methods, evaluation, budget narrative, capacity,
 * sustainability — each section aligned to the funder's stated
 * requirements and grounded in the profile's real evidence.
 *
 * Contract (mission rules):
 *   - NEVER invents facts. Every claim must be grounded in the evidence
 *     pack we extract from the profile. When the model has nothing to
 *     ground a section in, it emits a bracketed `[ EVIDENCE NEEDED: … ]`
 *     placeholder AND we surface it as a structured evidence-gap item so
 *     the owner can fill it (mirrors the packet generator's missing-info
 *     contract and the repo's no-fake-production-rule gate).
 *   - Adapts the section rubric to the profile TYPE: an individual /
 *     student proposal does not carry "organizational capacity" or a
 *     multi-year org "sustainability plan"; an organization proposal does.
 *   - Uses the SAME LLM client the rest of the backend uses
 *     (backend/utils/aiProviders.js → OpenAI primary, Claude fallback).
 *     The Claude model reuses the project's already-configured capable
 *     model id (school-lookup's claude-sonnet-4-6) rather than a new
 *     hard-coded id; override via HAMILTON_PROPOSAL_ANTHROPIC_MODEL.
 *
 * Integration: hamiltonAutomationOrchestrator.runDocumentPathway calls
 * generateMbaProposal() then saveProposalDocument() BEFORE the existing
 * packet, attaches the saved document to the application_task, records
 * evidence gaps as missing-info, and notifies the owner. Any failure
 * there falls back to the existing packet (never breaks the pathway).
 *
 * FOLLOW-UP (documented, not yet wired): feeding the drafted narrative
 * sections into the portal autofill/`/portal-assist` answer source so
 * Hamilton reuses this prose to answer portal form fields. The drafted
 * sections are persisted to the task + Documents, so that wiring is a
 * read of already-saved content — see PR notes.
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { invokeJsonWithFallback, getOpenAIOptional } from '../../utils/aiProviders.js'
import {
  buildDocxBuffer,
  buildHtml,
  _internal as packetInternal,
} from './hamiltonApplicationPacketGenerator.js'

const PERSONA =
  'Hamilton — a senior grant writer with an MBA and 20+ years of experience who has secured more than $100M in grant funding for individuals and organizations.'

const PROPOSAL_ANTHROPIC_MODEL =
  process.env.HAMILTON_PROPOSAL_ANTHROPIC_MODEL
  || process.env.ANTHROPIC_MODEL_SCHOOL_LOOKUP
  || 'claude-sonnet-4-6'

// ── profile-type resolution ──────────────────────────────────────────

const ORG_TYPE_HINTS = [
  'organization', 'nonprofit', 'non_profit', 'nonprofit_organization', 'business',
  'small_business', 'company', 'school', 'district', 'church', 'ministry',
  'government', 'agency', 'foundation', 'institution', 'clinic', 'hospital',
]

/**
 * Resolve whether we are drafting for an INDIVIDUAL (person / student /
 * family / veteran) or an ORGANIZATION (nonprofit / business / school /
 * agency). Drives which section rubric applies. Purely a shape decision —
 * never suppresses content, never touches matching.
 */
export function resolveProfileKind(profile) {
  if (!profile || typeof profile !== 'object') return 'individual'
  const explicit = String(
    profile.applicant_type
      || profile.profile_type
      || profile.type
      || profile.sections?.basic_information?.applicant_type
      || profile.basic_information?.applicant_type
      || '',
  ).toLowerCase().trim()
  if (explicit) {
    if (ORG_TYPE_HINTS.some((h) => explicit.includes(h))) return 'organization'
    if (['individual', 'person', 'student', 'family', 'veteran', 'household'].some((h) => explicit.includes(h))) {
      return 'individual'
    }
  }
  // Structural signal: an org identity (mission + EIN / org name) with no
  // personal student/household signal reads as an organization.
  const org = profile.organization || profile.sections?.organization || {}
  const hasOrgSignal = Boolean(
    profile.ein || org.ein || profile.mission || org.mission
      || profile.organization_name || org.name,
  )
  const basic = profile.basic_information || profile.sections?.basic_information || {}
  const hasPersonSignal = Boolean(basic.first_name || basic.last_name || profile.display_name)
  if (hasOrgSignal && !hasPersonSignal) return 'organization'
  return 'individual'
}

// Section rubric per profile kind. `key` is the stable section id;
// `title` is the human heading; `applies` documents the intent. Not all
// sections will be emitted — the model omits any it cannot ground and we
// flag the gap.
const INDIVIDUAL_RUBRIC = [
  { key: 'cover_letter', title: 'Cover Letter' },
  { key: 'need_statement', title: 'Statement of Need' },
  { key: 'goals_objectives', title: 'Goals & Objectives (SMART)' },
  { key: 'methods_implementation', title: 'Plan of Action / Use of Funds' },
  { key: 'evaluation_outcomes', title: 'Expected Outcomes & Impact' },
  { key: 'budget_narrative', title: 'Budget Narrative (line-justified)' },
  { key: 'personal_capacity', title: 'Readiness & Personal Capacity' },
]

const ORGANIZATION_RUBRIC = [
  { key: 'cover_letter', title: 'Cover Letter' },
  { key: 'need_statement', title: 'Statement of Need' },
  { key: 'goals_objectives', title: 'Goals & Objectives (SMART)' },
  { key: 'methods_implementation', title: 'Methods & Implementation Plan' },
  { key: 'evaluation_outcomes', title: 'Evaluation & Outcomes' },
  { key: 'budget_narrative', title: 'Budget Narrative (line-justified)' },
  { key: 'organizational_capacity', title: 'Organizational Capacity' },
  { key: 'sustainability', title: 'Sustainability Plan' },
]

export function rubricForProfileKind(kind) {
  return kind === 'organization' ? ORGANIZATION_RUBRIC : INDIVIDUAL_RUBRIC
}

// ── evidence extraction ──────────────────────────────────────────────

function nonEmpty(v) {
  return v !== null && v !== undefined && String(v).trim() !== ''
}

function coerceSection(v) {
  if (v === null || v === undefined) return {}
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return {} }
}

/**
 * Build a labeled, LLM-friendly evidence pack from the profile bundle.
 * We read defensively across BOTH shapes the codebase uses:
 *   - profile_sections spread onto the bundle (basic_information, essays…)
 *   - the flat profiles columns (education_information, financial_information…)
 * Empty fields are dropped so the model can distinguish "present" from
 * "missing" cleanly.
 */
export function buildEvidencePack(profile, kind) {
  const sec = (key) => coerceSection(
    profile?.[key] ?? profile?.sections?.[key],
  )
  const basic = sec('basic_information')
  const essays = sec('essays')
  const financial = { ...sec('financial'), ...sec('financial_information') }
  const education = sec('education_information')
  const employment = sec('employment_information')
  const health = sec('health_information')
  const housing = sec('housing_information')
  const additional = sec('additional_information')
  const org = { ...sec('organization'), ...sec('organization_details') }
  const uniApps = sec('university_applications')

  const evidence = {}
  const put = (label, value) => { if (nonEmpty(value)) evidence[label] = String(value).slice(0, 1500) }

  put('applicant_name', [basic.first_name, basic.last_name].filter(Boolean).join(' ') || profile?.display_name)
  put('location', [basic.city, basic.state, basic.zip].filter(Boolean).join(', '))
  put('email', basic.email)
  put('phone', basic.phone)
  put('household_size', basic.household_size || financial.household_size)
  put('annual_income', financial.annual_income || financial.household_income || basic.annual_income)
  put('fafsa_status', financial.fafsa_status)
  put('financial_hardship', essays.financial_hardship || financial.hardship)

  // Narrative evidence — the richest grounding material.
  put('mission_or_personal_statement', essays.personal_statement || essays.primary || org.mission || profile?.mission)
  put('goals', essays.goals || essays.career_goals)
  put('statement_of_need', essays.statement_of_need)

  if (kind === 'organization') {
    put('organization_name', org.name || profile?.organization_name)
    put('ein', org.ein || profile?.ein)
    put('annual_budget', org.annual_budget || profile?.annual_budget)
    put('programs', org.programs || org.services)
    put('years_operating', org.years_operating || org.founded)
    put('staff_capacity', org.staff || org.staff_capacity || org.team)
    put('past_outcomes', org.outcomes || org.impact)
  } else {
    put('education', JSON.stringify(education).slice(0, 900) === '{}' ? '' : JSON.stringify(education).slice(0, 900))
    put('employment', JSON.stringify(employment).slice(0, 700) === '{}' ? '' : JSON.stringify(employment).slice(0, 700))
    put('health_context', JSON.stringify(health).slice(0, 500) === '{}' ? '' : JSON.stringify(health).slice(0, 500))
    put('housing_context', JSON.stringify(housing).slice(0, 500) === '{}' ? '' : JSON.stringify(housing).slice(0, 500))
    if (Array.isArray(uniApps?.applications) && uniApps.applications.length > 0) {
      const a = uniApps.applications[0]
      put('school', a.name)
      put('program_major', a.major || a.program)
      put('degree_level', a.degree_level)
      put('expected_graduation', a.expected_graduation)
    }
  }
  put('additional_context', JSON.stringify(additional).slice(0, 600) === '{}' ? '' : JSON.stringify(additional).slice(0, 600))

  return evidence
}

/**
 * Extract the funder's requirements / eligibility / priorities from the
 * opportunity or grant record so each proposal section can be aligned to
 * them explicitly.
 */
export function buildFunderRequirements(opportunity, grant) {
  const opp = opportunity || grant || {}
  const req = {}
  const put = (label, value) => { if (nonEmpty(value)) req[label] = String(value).slice(0, 2000) }
  put('title', opp.title || opp.name)
  put('funder', opp.funder_name || opp.funder || opp.organization || opp.source_name)
  put('description', opp.description)
  put('eligibility', opp.eligibility_text || opp.eligibility)
  put('priorities', opp.priorities || opp.focus_areas || opp.categories)
  put('requirements', opp.requirements || opp.application_requirements)
  put('amount', opp.amount_max || opp.amount || opp.estimated_amount)
  put('deadline', opp.deadline || opp.application_deadline || opp.due_date)
  return req
}

// ── prompt ───────────────────────────────────────────────────────────

function buildProposalPrompt({ kind, rubric, evidence, funder }) {
  const rubricList = rubric.map((s) => `  - ${s.key}: ${s.title}`).join('\n')
  return `You are ${PERSONA}
You are drafting a COMPLETE, submission-ready grant proposal for ${kind === 'organization' ? 'an ORGANIZATION' : 'an INDIVIDUAL / STUDENT'} applicant.

Write at the level of a seasoned professional grant writer: precise, evidence-led, persuasive, and honest. This is a full narrative proposal, NOT a form or a cover sheet only.

ABSOLUTE RULES (a fabrication gate rejects invented facts):
- Ground every factual claim in the EVIDENCE below. Do NOT invent names, numbers, dates, credentials, or outcomes.
- Where a section needs a fact the evidence does not contain, write the sentence with an inline bracket placeholder exactly like "[ EVIDENCE NEEDED: <what is missing> ]" and add a matching entry to "evidence_gaps".
- Every section must show explicit FUNDER ALIGNMENT: connect the applicant's situation to the funder's stated requirements/eligibility/priorities.
- Objectives must be SMART (Specific, Measurable, Achievable, Relevant, Time-bound).
- Budget narrative must justify each line item and tie spending to objectives.

SECTION RUBRIC (produce ONLY sections you can meaningfully ground; omit and gap-flag any you cannot):
${rubricList}

=== FUNDER ===
${JSON.stringify(funder, null, 2)}

=== APPLICANT EVIDENCE ===
${JSON.stringify(evidence, null, 2)}

Return ONLY valid JSON with this exact shape:
{
  "sections": [
    { "key": "<one of the rubric keys>", "title": "<section heading>", "content": "<full prose, submission-ready>",
      "evidence_gaps": [ { "key": "<slug>", "label": "<what's missing>", "description": "<how to supply it>" } ] }
  ],
  "funder_alignment": {
    "requirements": [ "<requirement/eligibility/priority you extracted>" ],
    "alignment": [ { "requirement": "<requirement>", "addressed_in": "<section key>", "note": "<how it is addressed>" } ]
  },
  "evidence_gaps": [ { "key": "<slug>", "label": "<what's missing>", "description": "<how to supply it>", "required": true } ],
  "recommendations": [ "<concrete next step to strengthen the proposal>" ]
}`
}

// ── normalization ────────────────────────────────────────────────────

function slug(s, fallback) {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
  return out || fallback
}

function normalizeGap(g, idx) {
  if (!g) return null
  const key = slug(g.key || g.label, `gap_${idx}`)
  return {
    kind: 'field',
    key: `proposal_${key}`,
    label: String(g.label || g.key || 'Missing evidence').slice(0, 200),
    description: g.description ? String(g.description).slice(0, 500) : null,
    required: g.required === false ? false : true,
  }
}

function normalizeProposal(json, { kind, rubric }) {
  const validKeys = new Set(rubric.map((r) => r.key))
  const titleByKey = new Map(rubric.map((r) => [r.key, r.title]))
  const sectionsIn = Array.isArray(json?.sections) ? json.sections : []
  const sections = []
  for (const s of sectionsIn) {
    if (!s || !nonEmpty(s.content)) continue
    const key = validKeys.has(s.key) ? s.key : slug(s.key || s.title, `section_${sections.length}`)
    const gaps = Array.isArray(s.evidence_gaps)
      ? s.evidence_gaps.map((g, i) => normalizeGap(g, i)).filter(Boolean)
      : []
    sections.push({
      key,
      title: String(s.title || titleByKey.get(key) || key).slice(0, 200),
      content: String(s.content),
      evidence_gaps: gaps,
    })
  }

  // Collect a de-duplicated evidence-gap set: top-level gaps + per-section gaps.
  const topGaps = Array.isArray(json?.evidence_gaps)
    ? json.evidence_gaps.map((g, i) => normalizeGap(g, i)).filter(Boolean)
    : []
  const seen = new Set()
  const evidenceGaps = []
  for (const g of [...topGaps, ...sections.flatMap((s) => s.evidence_gaps)]) {
    if (seen.has(g.key)) continue
    seen.add(g.key)
    evidenceGaps.push(g)
  }

  const funderAlignment = json?.funder_alignment && typeof json.funder_alignment === 'object'
    ? {
        requirements: Array.isArray(json.funder_alignment.requirements)
          ? json.funder_alignment.requirements.map((r) => String(r).slice(0, 400)).filter(Boolean)
          : [],
        alignment: Array.isArray(json.funder_alignment.alignment)
          ? json.funder_alignment.alignment
              .filter((a) => a && (a.requirement || a.note))
              .map((a) => ({
                requirement: String(a.requirement || '').slice(0, 400),
                addressed_in: a.addressed_in ? String(a.addressed_in).slice(0, 60) : null,
                note: String(a.note || '').slice(0, 600),
              }))
          : [],
      }
    : { requirements: [], alignment: [] }

  const recommendations = Array.isArray(json?.recommendations)
    ? json.recommendations.map((r) => String(r).slice(0, 400)).filter(Boolean)
    : []

  return { kind, sections, funder_alignment: funderAlignment, evidence_gaps: evidenceGaps, recommendations }
}

// ── public: generate ─────────────────────────────────────────────────

/**
 * Draft a full MBA-level grant proposal for a profile against a funding
 * opportunity/grant.
 *
 * Resolves (never throws for LLM failures — "graceful fallback") to:
 *   {
 *     ok: boolean,
 *     kind: 'individual' | 'organization',
 *     sections: [{ key, title, content, evidence_gaps[] }],
 *     funder_alignment: { requirements[], alignment[] },
 *     evidence_gaps: [{ kind:'field', key, label, description, required }],
 *     recommendations: [string],
 *     meta: { provider, model, section_keys, funder },
 *     error?: string,          // set when ok === false
 *   }
 *
 * @param {object} db  (unused for generation; kept for signature parity /
 *                      future profile re-reads — persistence lives in
 *                      saveProposalDocument.)
 */
export async function generateMbaProposal(db, {
  profile, opportunity = null, grant = null, taskId = null,
  // Test seam: inject a stub LLM so unit tests stay hermetic.
  _deps = null,
} = {}) {
  void db
  void taskId
  if (!profile || typeof profile !== 'object') throw new Error('profile required')

  const kind = resolveProfileKind(profile)
  const rubric = rubricForProfileKind(kind)
  const evidence = buildEvidencePack(profile, kind)
  const funder = buildFunderRequirements(opportunity, grant)
  const prompt = buildProposalPrompt({ kind, rubric, evidence, funder })

  const invokeJson = _deps?.invokeJson || invokeJsonWithFallback
  const openaiFactory = _deps?.getOpenAIOptional || getOpenAIOptional

  const baseResult = {
    ok: false,
    kind,
    sections: [],
    funder_alignment: { requirements: [], alignment: [] },
    evidence_gaps: [],
    recommendations: [],
    meta: { provider: null, model: PROPOSAL_ANTHROPIC_MODEL, section_keys: [], funder: funder.funder || null },
  }

  let llm
  try {
    llm = await invokeJson({
      openai: openaiFactory ? openaiFactory() : null,
      system: `You are ${PERSONA} Output only valid JSON.`,
      prompt,
      temperature: 0.35,
      maxTokens: 6000,
      anthropicModel: PROPOSAL_ANTHROPIC_MODEL,
    })
  } catch (err) {
    return { ...baseResult, error: err?.message || String(err) }
  }

  if (!llm || !llm.ok || !llm.json || typeof llm.json !== 'object') {
    return {
      ...baseResult,
      error: llm?.error?.message || llm?.anthropicError || llm?.openaiError?.message || 'LLM did not return a proposal',
    }
  }

  const normalized = normalizeProposal(llm.json, { kind, rubric })
  if (normalized.sections.length === 0) {
    return { ...baseResult, ...normalized, ok: false, error: 'Proposal draft contained no groundable sections' }
  }

  return {
    ok: true,
    ...normalized,
    meta: {
      provider: llm.provider || null,
      model: PROPOSAL_ANTHROPIC_MODEL,
      section_keys: normalized.sections.map((s) => s.key),
      funder: funder.funder || null,
    },
  }
}

// ── public: persist ──────────────────────────────────────────────────

function getProposalStorageDir() {
  const base = process.env.HAMILTON_PACKET_STORAGE_DIR
    || path.join(os.tmpdir(), 'grantflow-hamilton-packets')
  try { fs.mkdirSync(base, { recursive: true }) } catch { /* ignore */ }
  return base
}

function proposalTitle({ opportunity, grant, proposal }) {
  const opp = opportunity || grant || {}
  const base = opp.title || opp.name || 'Grant Proposal'
  void proposal
  return `${base} — Full Proposal`
}

/**
 * Render the drafted proposal to DOCX + HTML (+ PDF when Playwright is
 * available), save the files, and insert a `hamilton_proposal` document
 * row linked to the profile. Reuses the packet generator's renderers +
 * insert path so the proposal shows up alongside the packet in the
 * profile's Documents list.
 *
 * @returns {Promise<{ proposal_document_id, docx_path, html_path, pdf_path, title }>}
 */
export async function saveProposalDocument(db, {
  profile, opportunity = null, grant = null, proposal, taskId = null, userId = null,
} = {}) {
  if (!db) throw new Error('db required')
  if (!profile?.id) throw new Error('profile required')
  if (!proposal || !Array.isArray(proposal.sections) || proposal.sections.length === 0) {
    throw new Error('proposal with sections required')
  }

  const title = proposalTitle({ opportunity, grant, proposal })

  // Compose the renderable section list. Lead with a funder-alignment
  // summary so a reviewer sees the alignment logic up front, then the
  // drafted narrative sections, then a recommendations appendix.
  const renderSections = []
  const alignment = proposal.funder_alignment || {}
  if ((alignment.requirements?.length || 0) > 0 || (alignment.alignment?.length || 0) > 0) {
    const lines = []
    if (alignment.requirements?.length) {
      lines.push('Funder requirements & priorities identified:')
      for (const r of alignment.requirements) lines.push(`  • ${r}`)
      lines.push('')
    }
    if (alignment.alignment?.length) {
      lines.push('How this proposal aligns:')
      for (const a of alignment.alignment) {
        lines.push(`  • ${a.requirement || '(requirement)'} → ${a.addressed_in || 'narrative'}: ${a.note || ''}`.trim())
      }
    }
    renderSections.push({ heading: 'Funder Alignment', body: lines.join('\n') })
  }

  for (const s of proposal.sections) {
    renderSections.push({ heading: s.title || s.key, body: s.content || '' })
  }

  if (proposal.evidence_gaps?.length) {
    const lines = [
      'Hamilton flagged the following evidence gaps. Supply these in the GrantFlow profile and Hamilton will fill the bracketed placeholders — nothing here is invented.',
      '',
    ]
    for (const g of proposal.evidence_gaps) {
      lines.push(`  • ${g.label}${g.description ? ` — ${g.description}` : ''}`)
    }
    renderSections.push({ heading: 'Evidence Gaps to Resolve', body: lines.join('\n') })
  }

  if (proposal.recommendations?.length) {
    renderSections.push({
      heading: 'Recommendations',
      body: proposal.recommendations.map((r) => `  • ${r}`).join('\n'),
    })
  }

  const html = buildHtml({ title, sections: renderSections, mailingInstructions: null })
  const docxBuf = await buildDocxBuffer({ title, sections: renderSections, mailingInstructions: null })
  const pdfBuf = await packetInternal.tryBuildPdfFromHtml(html)

  const storageDir = getProposalStorageDir()
  const baseSlug = String(title).toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'proposal'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const docxPath = path.join(storageDir, `${baseSlug}_${stamp}.docx`)
  const htmlPath = path.join(storageDir, `${baseSlug}_${stamp}.html`)
  const pdfPath = pdfBuf ? path.join(storageDir, `${baseSlug}_${stamp}.pdf`) : null

  await fs.promises.writeFile(docxPath, docxBuf)
  await fs.promises.writeFile(htmlPath, html)
  if (pdfBuf) await fs.promises.writeFile(pdfPath, pdfBuf)

  const notes = `Full MBA-level proposal drafted by ${PERSONA} task_id=${taskId || 'n/a'} provider=${proposal.meta?.provider || 'n/a'} user_id=${userId || 'n/a'}.`
  const extractedText = renderSections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n')

  // Prefer the PDF as the primary artifact when available (mirrors packet
  // generator); otherwise the DOCX.
  const proposalDocumentId = await packetInternal.insertDocumentRecord(db, {
    profileId: profile.id,
    grantId: grant?.id || null,
    opportunityId: opportunity?.id || null,
    name: `${title} — ${pdfBuf ? 'PDF' : 'DOCX'}`,
    type: 'hamilton_proposal',
    filePath: pdfBuf ? pdfPath : docxPath,
    mimeType: pdfBuf
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileSize: (pdfBuf || docxBuf).length,
    notes,
    extractedText,
  })

  // Always also save the DOCX record when the primary was a PDF, so the
  // owner can edit the narrative.
  if (pdfBuf) {
    try {
      await packetInternal.insertDocumentRecord(db, {
        profileId: profile.id,
        grantId: grant?.id || null,
        opportunityId: opportunity?.id || null,
        name: `${title} — DOCX`,
        type: 'hamilton_proposal',
        filePath: docxPath,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileSize: docxBuf.length,
        notes,
        extractedText,
      })
    } catch { /* best-effort secondary record */ }
  }

  return {
    proposal_document_id: proposalDocumentId,
    docx_path: docxPath,
    html_path: htmlPath,
    pdf_path: pdfPath,
    title,
  }
}

export const _internal = {
  PERSONA,
  PROPOSAL_ANTHROPIC_MODEL,
  resolveProfileKind,
  rubricForProfileKind,
  buildEvidencePack,
  buildFunderRequirements,
  buildProposalPrompt,
  normalizeProposal,
  getProposalStorageDir,
}
