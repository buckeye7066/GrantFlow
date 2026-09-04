/**
 * Deterministic requirement/claim coverage for proposal drafts.
 *
 * This is the enforcement layer, not an LLM opinion. A mandatory requirement
 * is addressed only when the caller points to text that actually exists in the
 * draft. A high-risk applicant claim is supported only when its cited quote
 * actually exists in the stored profile evidence. Missing proof blocks a
 * transition to `final`; the service never fabricates a replacement.
 */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { loadActiveProfileMemoryContext } from './profileMemoryContext.js'

const APPLICANT_EVIDENCE_SOURCE_TYPES = [
  'profile',
  'profile_section',
  'profile_memory',
  'document',
  'manual_attestation',
]

export const RequirementResponseSchema = z.object({
  requirement_id: z.string().trim().min(1).max(240),
  response_excerpt: z.string().trim().min(1).max(20_000),
  response_text: z.string().trim().min(1).max(500_000).optional(),
  page_count: z.number().int().positive().max(10_000).optional(),
  status: z.enum(['addressed', 'partial', 'not_applicable']).default('addressed'),
  applicant_evidence: z.array(z.object({
    source_type: z.enum(APPLICANT_EVIDENCE_SOURCE_TYPES),
    source_id: z.string().trim().min(1).max(240),
    quote_text: z.string().trim().min(1).max(8_000),
  })).max(30).default([]),
})

export const ClaimEvidenceSchema = z.object({
  claim: z.string().trim().min(1).max(4_000),
  evidence: z.array(z.object({
    source_type: z.enum(APPLICANT_EVIDENCE_SOURCE_TYPES),
    source_id: z.string().trim().min(1).max(240),
    quote_text: z.string().trim().min(1).max(8_000),
  })).min(1).max(30),
})

export const GroundedDraftAuditInputSchema = z.object({
  draft_text: z.string().trim().min(1).max(500_000),
  requirement_responses: z.array(RequirementResponseSchema).max(2_000).default([]),
  claim_evidence: z.array(ClaimEvidenceSchema).max(1_000).default([]),
})

function parseJson(value, fallback = []) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function normalizeForMatch(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function quoteExists(haystack, quote) {
  const source = normalizeForMatch(haystack)
  const needle = normalizeForMatch(quote)
  return Boolean(needle) && source.includes(needle)
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

const FIRST_PERSON = /\b(I|we|our|my|us)\b/i
const THIRD_PERSON_APPLICANT = /\b(?:the\s+)?(?:applicant|organization|nonprofit|company|business|school|district|church|agency|clinic|program)\b/i
const NUMERIC_OR_FINANCIAL = /(?:\$\s?\d|\b\d+(?:\.\d+)?\s?(?:%|percent|people|students|clients|families|years?|awards?|programs?|employees?)\b)/i
const CREDENTIAL_OR_IDENTITY = /\b(?:licensed|certified|accredited|veteran|first[- ]generation|lgbtq|gay|lesbian|bisexual|transgender|native american|american indian|hispanic|latino|black|african[- ]american|disabled|woman-owned|minority-owned)\b/i
const OUTCOME_OR_HISTORY = /\b(?:achieved|served|delivered|increased|decreased|reduced|raised|received|awarded|founded|operat(?:ed|ing) since|track record)\b/i
const FUTURE_OR_ASPIRATIONAL = /\b(?:will|would|plans? to|aims? to|expects? to|targets?|goals? to|seeks? to|proposes? to|intends? to|hopes? to|projected|anticipated)\b/i

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Detect established applicant facts in first or verified third person. */
export function detectHighRiskApplicantClaims(draftText, { applicantNames = [] } = {}) {
  const seen = new Set()
  const claims = []
  const names = (applicantNames || []).map((value) => String(value || '').trim()).filter(Boolean)
  const applicantNamePattern = names.length
    ? new RegExp(names.map(escapeRegExp).join('|'), 'i')
    : null
  for (const sentence of splitSentences(draftText)) {
    const applicantSubject = FIRST_PERSON.test(sentence)
      || THIRD_PERSON_APPLICANT.test(sentence)
      || Boolean(applicantNamePattern?.test(sentence))
    if (!applicantSubject) continue
    const establishedSignal = NUMERIC_OR_FINANCIAL.test(sentence)
      || CREDENTIAL_OR_IDENTITY.test(sentence)
      || OUTCOME_OR_HISTORY.test(sentence)
    if (!establishedSignal) continue
    // Future numeric targets are plans, not claims of achieved history. A
    // sentence with an independently historical/credential signal is retained.
    if (
      FUTURE_OR_ASPIRATIONAL.test(sentence)
      && !OUTCOME_OR_HISTORY.test(sentence)
      && !CREDENTIAL_OR_IDENTITY.test(sentence)
    ) continue
    const key = normalizeForMatch(sentence)
    if (seen.has(key)) continue
    seen.add(key)
    claims.push(sentence.slice(0, 4_000))
  }
  return claims
}

function normalizeRequirement(row) {
  return {
    id: String(row.id),
    canonical_key: row.canonical_key,
    requirement_type: row.requirement_type,
    title: row.title || null,
    requirement_text: row.requirement_text,
    mandatory: row.mandatory === true || row.mandatory === 1,
    status: row.status || 'active',
    normalized_value: parseJson(row.normalized_value ?? row.normalized_value_json, {}),
    citations: Array.isArray(row.citations) ? row.citations : parseJson(row.citations_json, []),
  }
}

function finitePositive(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function firstConstraintValue(value, keys) {
  for (const key of keys) {
    const direct = value?.[key]
    if (direct !== undefined && direct !== null && direct !== '') return direct
  }
  for (const nested of ['budget', 'cost_share', 'match', 'format', 'response']) {
    const object = value?.[nested]
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue
    for (const key of keys) {
      const candidate = object[key]
      if (candidate !== undefined && candidate !== null && candidate !== '') return candidate
    }
  }
  return null
}

function countWords(value) {
  return (String(value || '').trim().match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu) || []).length
}

function numericValues(value) {
  const matches = String(value || '').match(/-?\d[\d,]*(?:\.\d+)?/g) || []
  return matches.map((token) => Number(token.replaceAll(',', ''))).filter(Number.isFinite)
}

function containsNumericValue(text, expected) {
  const target = Number(String(expected).replace(/[$,%\s,]/g, ''))
  if (!Number.isFinite(target)) return false
  return numericValues(text).some((value) => Math.abs(value - target) <= Math.max(0.0001, Math.abs(target) * 0.000001))
}

function normalizeDocumentNames(normalizedValue) {
  const raw = firstConstraintValue(normalizedValue, [
    'required_documents', 'required_document', 'documents', 'document', 'document_type',
  ])
  const values = Array.isArray(raw) ? raw : (raw ? [raw] : [])
  return values.map((value) => String(value || '').trim()).filter(Boolean)
}

function documentMatches(expected, document) {
  const needle = normalizeForMatch(expected).replace(/[^a-z0-9]+/g, ' ').trim()
  if (!needle) return false
  const haystack = normalizeForMatch(
    `${document?.name || document?.filename || ''} ${document?.type || ''} ${document?.mime_type || ''}`,
  ).replace(/[^a-z0-9]+/g, ' ')
  const tokens = needle.split(/\s+/).filter((token) => token.length > 2)
  return haystack.includes(needle) || (tokens.length > 0 && tokens.every((token) => haystack.includes(token)))
}

function validateTypeSpecificConstraints(requirement, response, availableDocuments) {
  const normalized = requirement.normalized_value || {}
  const errors = []
  const responseText = response?.response_text || response?.response_excerpt || ''
  const maxWords = finitePositive(firstConstraintValue(normalized, ['max_words', 'word_limit', 'maximum_words']))
  const maxPages = finitePositive(firstConstraintValue(normalized, ['max_pages', 'page_limit', 'maximum_pages']))
  const question = firstConstraintValue(normalized, ['question', 'question_text', 'prompt'])
  const requiredDocuments = normalizeDocumentNames(normalized)
  const numericConstraints = [
    ['budget_amount', ['budget_amount', 'total_budget', 'requested_amount', 'amount']],
    ['match_amount', ['match_amount', 'cost_share_amount', 'matching_amount']],
    ['match_percentage', ['match_percentage', 'cost_share_percentage']],
  ].map(([label, keys]) => [label, firstConstraintValue(normalized, keys)])
    .filter(([, value]) => value !== null)
  const needsCompleteResponse = Boolean(maxWords || maxPages || question || numericConstraints.length)

  if (needsCompleteResponse && !response?.response_text) {
    errors.push('complete_response_text_required_for_constraint_validation')
  }
  if (maxWords && response?.response_text && countWords(response.response_text) > maxWords) {
    errors.push(`max_words_exceeded:${countWords(response.response_text)}>${maxWords}`)
  }
  if (maxPages) {
    const deterministicPages = response?.response_text?.includes('\f')
      ? response.response_text.split('\f').length
      : response?.page_count
    if (!deterministicPages) errors.push('page_count_required_for_max_pages')
    else if (deterministicPages > maxPages) errors.push(`max_pages_exceeded:${deterministicPages}>${maxPages}`)
  }
  if (question && !String(response?.response_text || '').trim()) {
    errors.push('question_response_required')
  }
  for (const [label, expected] of numericConstraints) {
    if (!containsNumericValue(responseText, expected)) errors.push(`${label}_not_addressed:${expected}`)
  }
  for (const expected of requiredDocuments) {
    if (!(availableDocuments || []).some((document) => documentMatches(expected, document))) {
      errors.push(`required_document_missing:${expected}`)
    }
  }
  return { errors, requiredDocuments }
}

function evidenceSourceIndex(sources = []) {
  const index = new Map()
  for (const source of sources) {
    const sourceType = String(source?.source_type || '').trim()
    const sourceId = String(source?.source_id || '').trim()
    if (!sourceType || !sourceId) continue
    index.set(`${sourceType}:${sourceId}`, JSON.stringify(source?.value ?? null))
  }
  return index
}

function evidenceEntriesAreGrounded(entries, sources) {
  if (!Array.isArray(entries) || entries.length === 0) return false
  const index = sources instanceof Map ? sources : evidenceSourceIndex(sources)
  return entries.every((entry) => {
    const exactSource = index.get(`${entry.source_type}:${entry.source_id}`)
    return exactSource !== undefined && quoteExists(exactSource, entry.quote_text)
  })
}

/**
 * Build the deterministic matrix. `requirements` and `profileEvidenceSources`
 * must come from stored rows; caller declarations are treated as untrusted.
 */
export function buildGroundedDraftCoverage({
  draftText,
  requirements = [],
  requirementResponses = [],
  claimEvidence = [],
  profileEvidenceSources = [],
  applicantNames = [],
  availableDocuments = [],
} = {}) {
  const input = GroundedDraftAuditInputSchema.parse({
    draft_text: draftText,
    requirement_responses: requirementResponses,
    claim_evidence: claimEvidence,
  })
  const profileEvidenceIndex = evidenceSourceIndex(profileEvidenceSources)
  const draft = input.draft_text
  const responses = new Map(input.requirement_responses.map((row) => [row.requirement_id, row]))
  const matrix = []

  for (const rawRequirement of requirements) {
    const requirement = normalizeRequirement(rawRequirement)
    if (requirement.status !== 'active') continue
    const response = responses.get(requirement.id)
    let coverageStatus = 'missing'
    let responseExcerpt = null
    let applicantEvidence = []
    const validationErrors = []

    if (response) {
      responseExcerpt = response.response_excerpt
      applicantEvidence = response.applicant_evidence
      if (!quoteExists(draft, responseExcerpt)) {
        validationErrors.push('response_excerpt_not_found_in_draft')
        coverageStatus = 'missing'
      } else if (response.response_text && !quoteExists(draft, response.response_text)) {
        validationErrors.push('complete_response_text_not_found_in_draft')
        coverageStatus = 'missing'
      } else if (response.status === 'not_applicable') {
        coverageStatus = requirement.mandatory ? 'partial' : 'not_applicable'
        if (requirement.mandatory) validationErrors.push('mandatory_requirement_cannot_be_unilaterally_waived')
      } else {
        coverageStatus = response.status
      }

      if (applicantEvidence.length > 0 && !evidenceEntriesAreGrounded(applicantEvidence, profileEvidenceIndex)) {
        validationErrors.push('applicant_evidence_quote_not_found')
        coverageStatus = coverageStatus === 'addressed' ? 'partial' : coverageStatus
      }
    }

    const constraintAudit = validateTypeSpecificConstraints(requirement, response, availableDocuments)
    validationErrors.push(...constraintAudit.errors)
    if (!response && constraintAudit.requiredDocuments.length > 0 && constraintAudit.errors.length === 0) {
      coverageStatus = 'addressed'
    }
    if (constraintAudit.errors.length > 0 && coverageStatus === 'addressed') coverageStatus = 'partial'

    matrix.push({
      requirement_id: requirement.id,
      canonical_key: requirement.canonical_key,
      requirement_type: requirement.requirement_type,
      title: requirement.title,
      requirement_text: requirement.requirement_text,
      normalized_value: requirement.normalized_value,
      mandatory: requirement.mandatory,
      coverage_status: coverageStatus,
      response_excerpt: responseExcerpt,
      applicant_evidence: applicantEvidence,
      requirement_citations: requirement.citations,
      validation_errors: validationErrors,
    })
  }

  const claimDeclarations = new Map(
    input.claim_evidence.map((row) => [normalizeForMatch(row.claim), row]),
  )
  const unsupportedClaims = []
  const supportedClaims = []
  for (const claim of detectHighRiskApplicantClaims(draft, { applicantNames })) {
    const declaration = claimDeclarations.get(normalizeForMatch(claim))
    if (!declaration) {
      unsupportedClaims.push({ claim, reason: 'no_evidence_citation' })
      continue
    }
    if (!evidenceEntriesAreGrounded(declaration.evidence, profileEvidenceIndex)) {
      unsupportedClaims.push({ claim, reason: 'evidence_quote_not_found_in_profile' })
      continue
    }
    supportedClaims.push({ claim, evidence: declaration.evidence })
  }

  const mandatoryMissing = matrix.filter((row) => row.mandatory && row.coverage_status !== 'addressed')
  const constraintViolations = matrix.filter((row) => row.validation_errors.length > 0)
  const requirementsMissing = matrix.length === 0
  const canFinalize = !requirementsMissing
    && mandatoryMissing.length === 0
    && unsupportedClaims.length === 0
    && constraintViolations.length === 0
  return {
    can_finalize: canFinalize,
    matrix,
    supported_claims: supportedClaims,
    unsupported_claims: unsupportedClaims,
    blockers: [
      ...(requirementsMissing ? [{
        code: 'SOLICITATION_REQUIREMENTS_REQUIRED',
        label: 'No validated solicitation requirements are linked to this application.',
      }] : []),
      ...mandatoryMissing.map((row) => ({
        code: 'MANDATORY_REQUIREMENT_NOT_ADDRESSED',
        requirement_id: row.requirement_id,
        label: row.title || row.requirement_text.slice(0, 180),
      })),
      ...unsupportedClaims.map((row) => ({
        code: 'UNSUPPORTED_APPLICANT_CLAIM',
        claim: row.claim,
        reason: row.reason,
      })),
      ...constraintViolations.map((row) => ({
        code: 'REQUIREMENT_CONSTRAINT_VIOLATION',
        requirement_id: row.requirement_id,
        label: row.title || row.requirement_text.slice(0, 180),
        violations: row.validation_errors,
      })),
    ],
    summary: {
      requirements_linked: !requirementsMissing,
      requirements_total: matrix.length,
      mandatory_total: matrix.filter((row) => row.mandatory).length,
      addressed: matrix.filter((row) => row.coverage_status === 'addressed').length,
      partial: matrix.filter((row) => row.coverage_status === 'partial').length,
      missing: matrix.filter((row) => row.coverage_status === 'missing').length,
      unsupported_claims: unsupportedClaims.length,
      constraint_violations: constraintViolations.length,
    },
  }
}

export async function loadStoredProfileEvidence(db, profileId) {
  if (!profileId) return { text: '', sources: [], applicantNames: [] }
  const profile = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(profileId)
  const sections = await db.prepare(
    'SELECT section_key, data FROM profile_sections WHERE profile_id = ? ORDER BY section_key',
  ).all(profileId)
  let memoryEntries = []
  try {
    memoryEntries = await loadActiveProfileMemoryContext(db, { profileId })
  } catch (error) {
    // Memory is additive and may be unavailable during a rolling deploy. Only
    // the exact missing-table state degrades to an empty source list; every
    // other read error remains loud.
    if (!/no such table:\s*profile_memory_|relation ["']?profile_memory_.*does not exist/i.test(String(error?.message || ''))) {
      throw error
    }
  }
  const sources = [
    { source_type: 'profile', source_id: profileId, label: profile?.display_name || 'Applicant profile', value: profile || {} },
    ...(sections || []).map((row) => ({
      source_type: 'profile_section',
      source_id: `${profileId}:${row.section_key}`,
      label: String(row.section_key).replaceAll('_', ' '),
      value: parseJson(row.data, {}),
    })),
    ...memoryEntries.map((entry) => ({
      source_type: 'profile_memory',
      source_id: entry.id,
      label: entry.title || entry.memory_key,
      memory_key: entry.memory_key,
      title: entry.title,
      kind: entry.kind,
      revision: entry.current_revision,
      value: entry.value,
    })),
  ]
  const applicantNames = [
    profile?.display_name,
    profile?.name,
    profile?.legal_name,
    profile?.organization_name,
  ].map((value) => String(value || '').trim()).filter(Boolean)
  const evidenceText = sources.map(({ source_type, source_id, value }) => ({
    source_type,
    source_id,
    value,
  }))
  return {
    text: JSON.stringify(evidenceText),
    sources,
    applicantNames: [...new Set(applicantNames)],
  }
}

function hasVerifiedDurableBytes(document) {
  const bytes = document?.file_bytes
  const byteLength = Buffer.isBuffer(bytes) || bytes instanceof Uint8Array ? bytes.byteLength : 0
  const expectedHash = String(document?.content_hash || '').trim().toLowerCase()
  if (byteLength <= 0 || !/^[a-f0-9]{64}$/.test(expectedHash)) return false
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex') === expectedHash
}

export async function loadAvailableApplicationDocuments(db, application) {
  const rows = []
  if (application.resolved_pipeline_grant_id) {
    try {
      rows.push(...await db.prepare(
        `SELECT id, name, type, mime_type, status, version, content_hash, file_bytes
           FROM documents
          WHERE profile_id = ? AND grant_id = ?
          ORDER BY updated_at DESC`,
      ).all(application.profile_id, application.resolved_pipeline_grant_id))
    } catch (error) {
      if (!/no such table|does not exist/i.test(String(error?.message || ''))) throw error
    }
  }
  return rows.filter(hasVerifiedDurableBytes).map(({ file_bytes: _bytes, ...document }) => document)
}

export async function loadLatestRequirementsForApplication(db, applicationId) {
  const application = await db.prepare(
    `SELECT a.*,
            COALESCE(a.opportunity_id, g.funding_opportunity_id) AS resolved_opportunity_id,
            COALESCE(a.pipeline_grant_id, g.id) AS resolved_pipeline_grant_id
       FROM grant_applications a
       LEFT JOIN grants g ON g.id = a.pipeline_grant_id
      WHERE a.id = ? LIMIT 1`,
  ).get(applicationId)
  if (!application) return { application: null, solicitation: null, requirements: [] }

  const solicitation = application.resolved_opportunity_id
    ? await db.prepare(
        `SELECT s.*, v.id AS latest_version_id, v.version_number
           FROM opportunity_solicitations s
           JOIN solicitation_versions v ON v.id = (
             SELECT v2.id FROM solicitation_versions v2
              WHERE v2.solicitation_id = s.id
              ORDER BY v2.version_number DESC LIMIT 1
           )
          WHERE s.profile_id = ? AND s.opportunity_id = ?
          ORDER BY s.updated_at DESC LIMIT 1`,
      ).get(application.profile_id, application.resolved_opportunity_id)
    : null

  if (!solicitation?.latest_version_id) return { application, solicitation: null, requirements: [] }
  const requirements = await loadRequirementsForVersion(db, solicitation.latest_version_id)
  return { application, solicitation, requirements }
}

/**
 * Fetch every active requirement on a solicitation version, with its citations
 * grouped onto it. Extracted so the application-keyed loader above and the
 * opportunity-keyed loader below cannot drift apart — the citation shape is
 * what makes a requirement quotable rather than paraphrased, and two copies of
 * this query is exactly how one side silently loses that.
 */
async function loadRequirementsForVersion(db, versionId) {
  if (!versionId) return []
  const rows = await db.prepare(
    `SELECT r.*,
            c.id AS citation_id, c.quote_text, c.char_start, c.char_end,
            c.page_number, c.source_url, ch.chunk_index
       FROM solicitation_requirements r
       LEFT JOIN requirement_citations c ON c.requirement_id = r.id
       LEFT JOIN solicitation_chunks ch ON ch.id = c.chunk_id
      WHERE r.version_id = ? AND r.status = 'active'
      ORDER BY r.requirement_type, r.canonical_key, c.char_start`,
  ).all(versionId)

  const grouped = new Map()
  for (const row of rows || []) {
    let requirement = grouped.get(row.id)
    if (!requirement) {
      requirement = { ...row, citations: [] }
      grouped.set(row.id, requirement)
    }
    if (row.citation_id) {
      requirement.citations.push({
        id: row.citation_id,
        quote_text: row.quote_text,
        char_start: row.char_start,
        char_end: row.char_end,
        page_number: row.page_number,
        source_url: row.source_url,
        chunk_index: row.chunk_index,
      })
    }
  }
  return [...grouped.values()]
}

/**
 * The same stored, citation-backed requirements, addressed the way HAMILTON can
 * address them.
 *
 * WHY THIS EXISTS: the compliance-matrix system was reachable only through
 * `loadLatestRequirementsForApplication(db, applicationId)`, keyed on a
 * `grant_applications` row. Hamilton's autonomous path has no such row — it
 * works from an `application_tasks` row plus an opportunity/grant — so grepping
 * backend/services/hamilton/ for `solicitation_requirements` returned nothing
 * and every Hamilton draft was written WITHOUT reference to the funder's own
 * stated questions, limits, attachments and evaluation criteria. The analysis
 * engine existed; the drafting agent simply could not reach it.
 *
 * Returns [] when the funder's solicitation has never been parsed, so callers
 * degrade to the loose opportunity text rather than failing.
 */
export async function loadLatestRequirementsForOpportunity(db, { profileId, opportunityId } = {}) {
  if (!db || !profileId || !opportunityId) return { solicitation: null, requirements: [] }
  const solicitation = await db.prepare(
    `SELECT s.*, v.id AS latest_version_id, v.version_number
       FROM opportunity_solicitations s
       JOIN solicitation_versions v ON v.id = (
         SELECT v2.id FROM solicitation_versions v2
          WHERE v2.solicitation_id = s.id
          ORDER BY v2.version_number DESC LIMIT 1
       )
      WHERE s.profile_id = ? AND s.opportunity_id = ?
      ORDER BY s.updated_at DESC LIMIT 1`,
  ).get(String(profileId), String(opportunityId))
  if (!solicitation?.latest_version_id) return { solicitation: null, requirements: [] }
  const requirements = await loadRequirementsForVersion(db, solicitation.latest_version_id)
  return { solicitation, requirements }
}

export async function auditDraftAgainstStoredRequirements(db, {
  applicationId,
  draftText,
  requirementResponses = [],
  claimEvidence = [],
} = {}) {
  if (!applicationId) throw new Error('applicationId is required')
  const stored = await loadLatestRequirementsForApplication(db, applicationId)
  if (!stored.application) {
    const error = new Error('Application not found')
    error.code = 'APPLICATION_NOT_FOUND'
    error.status = 404
    throw error
  }
  const profileEvidence = await loadStoredProfileEvidence(db, stored.application.profile_id)
  const availableDocuments = await loadAvailableApplicationDocuments(db, stored.application)
  return {
    application: stored.application,
    solicitation: stored.solicitation,
    audit: buildGroundedDraftCoverage({
      draftText,
      requirements: stored.requirements,
      requirementResponses,
      claimEvidence,
      profileEvidenceSources: profileEvidence.sources,
      applicantNames: profileEvidence.applicantNames,
      availableDocuments,
    }),
  }
}

/** Upsert the auditable matrix after the draft row itself exists. */
export async function persistDraftRequirementCoverage(db, {
  applicationId,
  draftId,
  audit,
} = {}) {
  if (!draftId || !audit) throw new Error('draftId and audit are required')
  const unsupportedJson = JSON.stringify(audit.unsupported_claims || [])
  for (const row of audit.matrix || []) {
    await db.prepare(
      `INSERT INTO draft_requirement_coverage
        (id, application_id, draft_id, requirement_id, coverage_status,
         response_excerpt, applicant_evidence_json, requirement_citations_json,
         unsupported_claims_json, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(draft_id, requirement_id) DO UPDATE SET
         application_id = excluded.application_id,
         coverage_status = excluded.coverage_status,
         response_excerpt = excluded.response_excerpt,
         applicant_evidence_json = excluded.applicant_evidence_json,
         requirement_citations_json = excluded.requirement_citations_json,
         unsupported_claims_json = excluded.unsupported_claims_json,
         verified_at = excluded.verified_at,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(
      randomUUID(), applicationId ?? null, draftId, row.requirement_id,
      row.coverage_status, row.response_excerpt ?? null,
      JSON.stringify(row.applicant_evidence || []),
      JSON.stringify(row.requirement_citations || []), unsupportedJson,
      audit.can_finalize ? new Date().toISOString() : null,
    )
  }
  return audit
}

export async function resolveApplicationIdForGrant(db, grantId) {
  if (!grantId) return null
  const row = await db.prepare(
    `SELECT id FROM grant_applications
      WHERE pipeline_grant_id = ?
      ORDER BY updated_at DESC LIMIT 1`,
  ).get(grantId)
  return row?.id || null
}

export default {
  buildGroundedDraftCoverage,
  detectHighRiskApplicantClaims,
  loadStoredProfileEvidence,
  loadLatestRequirementsForApplication,
  auditDraftAgainstStoredRequirements,
  persistDraftRequirementCoverage,
  resolveApplicationIdForGrant,
}
