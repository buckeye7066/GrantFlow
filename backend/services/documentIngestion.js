import { buildProfileSectionPrompt } from '../prompts/profileSections.js'
import { summarizeOpenAIError } from '../utils/openaiClient.js'
import { invokeJsonWithFallback } from '../utils/aiProviders.js'
import { buildFallbackDocumentSummary, applyFallbackUniversityUpdates } from './documentFallbackParser.js'
import { classifyUniversityApplicationForDocument, loadUniversityApplicationsForProfile } from './universityDocumentClassifier.js'
import { extractAndUpsertOpportunitiesFromText } from './extractOpportunitiesFromDocumentText.js'
import { countWords, detectFileType, extractTextWithFallback, normalizeText, scoreExtraction, sha256File } from './documentIngestion/index.js'
import {
  ensureDocumentExtract,
  getDocumentExtract,
  markDocumentExtractFailed,
  markDocumentExtractProcessing,
  saveDocumentExtractResult,
  tryReuseExtractByHash,
} from './documentIngestion/documentExtractStore.js'

const TARGET_SECTIONS = [
  'basic_information',
  'organization_details',
  'financial_information',
  'government_assistance',
  'health_medical',
  'medical_insurance',
  'medical_history',
  'nonprofit_compliance',
  'demographics',
  'family_life',
  'military_service',
  'occupation',
  'small_business_details',
  'location_focus',
  'education',
  'employment',
  'housing',
  'family',
  'programs_services',
  'university_applications',
  'narrative',
]

function truncateText(text, limit = 4000) {
  if (!text) return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

function normalizeEnableAi(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

async function createAnthropicClient() {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim()
  if (!key) return null
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  return new Anthropic({
    apiKey: key,
    timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || 20_000),
    maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || 1),
  })
}

function extractAnthropicText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts
    .map((part) => {
      if (typeof part?.text === 'string') return part.text
      if (typeof part === 'string') return part
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

// IMPORTANT: OCR is handled by the ingestion pipeline (tesseract / cloud OCR providers).
// We intentionally do NOT use an LLM vision model as an OCR fallback.

function extractFirstMatch(text, regex) {
  if (!text) return null
  const match = String(text).match(regex)
  const value = match?.[1] ?? match?.[0]
  const normalized = typeof value === 'string' ? value.trim() : null
  return normalized || null
}

function extractLabeledValue(text, labelRegex) {
  // e.g. /(?:EIN|Tax ID)\s*[:#-]\s*([0-9-]{9,})/i
  if (!text) return null
  const regex = new RegExp(`${labelRegex.source}\\s*[:#\\-]?\\s*([^\\n\\r]{2,80})`, labelRegex.flags)
  const m = String(text).match(regex)
  const value = m?.[1]?.trim()
  return value || null
}

function extractBasicInformationHeuristics(text) {
  const source = String(text || '')

  const email = extractFirstMatch(source, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  const phone = extractFirstMatch(
    source,
    /(\+?1[\s.-]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/,
  )
  const website = extractFirstMatch(
    source,
    /\bhttps?:\/\/[^\s)]+/i,
  )

  const fullName =
    extractLabeledValue(source, /(?:full\s+name|name|applicant)\b/i) ||
    extractFirstMatch(source, /^\s*([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,4})\s*$/m)

  const address =
    extractLabeledValue(source, /(?:address|mailing\s+address)\b/i) ||
    null

  return {
    full_name: fullName || '',
    email: email || '',
    phone: phone || '',
    website: website || '',
    address: address || '',
    notes: '',
  }
}

function extractOrganizationDetailsHeuristics(text) {
  const source = String(text || '')

  const ein =
    extractFirstMatch(source, /(?:\bEIN\b|\bTax\s*ID\b)[^0-9]*([0-9]{2}-[0-9]{7})/i) ||
    extractLabeledValue(source, /\bEIN\b/i)

  const uei =
    extractFirstMatch(source, /(?:\bUEI\b|\bUnique\s+Entity\s+ID\b)[^A-Z0-9]*([A-Z0-9]{12})/i) ||
    extractLabeledValue(source, /\bUEI\b/i)

  const cage =
    extractFirstMatch(source, /(?:\bCAGE\b|\bCAGE\s*Code\b)[^A-Z0-9]*([A-Z0-9]{5})/i) ||
    extractLabeledValue(source, /\bCAGE(?:\s*Code)?\b/i)

  return {
    organization_type: '',
    ein: ein || '',
    uei: uei || '',
    cage_code: cage || '',
    annual_budget: null,
    staff_count: null,
    mission: '',
  }
}
function normalizeValue(value) {
  if (typeof value === 'string') {
    return value.trim()
  }
  return value
}

function isLikelyIdentifier(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return false
  if (raw.length < 5 || raw.length > 40) return false
  if (/\s/.test(raw)) return false
  if (!/[0-9]/.test(raw)) return false
  if (!/^[A-Za-z0-9-]+$/.test(raw)) return false
  return true
}

function shouldOverrideString({ key, existingValue, incomingValue }) {
  const existing = typeof existingValue === 'string' ? existingValue.trim() : ''
  const incoming = typeof incomingValue === 'string' ? incomingValue.trim() : ''
  if (!incoming) return false

  // Sensitive identifier fields: prefer explicit, id-like tokens over narrative text.
  if (key === 'member_id' || key === 'group_id') {
    if (isLikelyIdentifier(incoming) && !isLikelyIdentifier(existing)) return true
  }

  return false
}

function mergeSectionData(existing = {}, incoming = {}) {
  const merged = { ...existing }
  const updatedFields = new Set()

  Object.entries(incoming).forEach(([key, rawValue]) => {
    if (rawValue === undefined || rawValue === null) return
    const value = normalizeValue(rawValue)
    const existingValue = merged[key]

    if (typeof value === 'string') {
      if (!value) return
      if (!existingValue || !normalizeValue(existingValue) || shouldOverrideString({ key, existingValue, incomingValue: value })) {
        merged[key] = value
        updatedFields.add(key)
      }
      return
    }

    if (typeof value === 'number') {
      if (Number.isFinite(value) && (!Number.isFinite(existingValue) || existingValue === null)) {
        merged[key] = value
        updatedFields.add(key)
      }
      return
    }

    if (typeof value === 'boolean') {
      if (value && !existingValue) {
        merged[key] = true
        updatedFields.add(key)
      } else if (existingValue === undefined) {
        merged[key] = value
        if (value) updatedFields.add(key)
      }
      return
    }

    if (Array.isArray(value)) {
      const existingArr = Array.isArray(existingValue) ? existingValue : []
      const fallback = new Set(existingArr.map((entry) => normalizeValue(entry)))
      let added = false
      value.forEach((entry) => {
        const normalized = normalizeValue(entry)
        if (!normalized) return
        if (!fallback.has(normalized)) {
          fallback.add(normalized)
          added = true
        }
      })
      if (added) {
        merged[key] = Array.from(fallback)
        updatedFields.add(key)
      } else if (!existingValue) {
        merged[key] = Array.from(fallback)
      }
      return
    }

    if (typeof value === 'object' && value) {
      const existingObj = typeof existingValue === 'object' && existingValue ? existingValue : {}
      const nestedResult = mergeSectionData(existingObj, value)
      merged[key] = nestedResult.data
      if (nestedResult.updatedFields.size > 0) {
        updatedFields.add(key)
      }
      return
    }
  })

  return { data: merged, updatedFields }
}

function extractMedicalInsuranceHeuristics(text) {
  const raw = String(text || '')
  const singleLine = raw.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()

  const extractLineValue = (labelRegex) => {
    const re = new RegExp(`(?:^|[\\r\\n])\\s*${labelRegex.source}\\s*[:#\\-]?\\s*([^\\r\\n]+)`, labelRegex.flags)
    const m = raw.match(re)
    return m?.[1]?.trim() || null
  }

  const extractIdFromRemainder = (remainder) => {
    if (!remainder) return null
    return extractFirstMatch(String(remainder), /([A-Z0-9-]{6,40})/i)
  }

  const medicaidNumber =
    extractIdFromRemainder(
      extractLineValue(/\bMedicaid\s*(?:Number|No\.|ID|#|Member\s*ID)\b/i) ||
        extractFirstMatch(singleLine, /\bMedicaid\s*(?:Number|No\.|ID|#|Member\s*ID)\b\s*[:#-]?\s*([A-Z0-9-]{6,40})\b/i),
    ) ||
    extractFirstMatch(singleLine, /\bMedicaid\s+([A-Z]{2,6}\d{4,20})\b/i) ||
    null

  const memberId =
    extractIdFromRemainder(
      extractLineValue(/\b(?:Member|Subscriber)\s*(?:ID|Number|No\.|#)\b/i) ||
        extractFirstMatch(singleLine, /\b(?:Member|Subscriber)\s*(?:ID|Number|No\.|#)\b\s*[:#-]?\s*([A-Z0-9-]{6,40})\b/i),
    ) ||
    medicaidNumber

  const groupId =
    extractIdFromRemainder(
      extractLineValue(/\bGroup\s*(?:ID|Number|No\.|#)\b/i) ||
        extractFirstMatch(singleLine, /\bGroup\s*(?:ID|Number|No\.|#)\b\s*[:#-]?\s*([A-Z0-9-]{4,40})\b/i),
    ) || null

  const provider =
    extractLineValue(/\bInsurance\s+provider\b/i) ||
    extractFirstMatch(singleLine, /\bInsurance\s+provider\b\s*[:#-]?\s*([A-Za-z][A-Za-z0-9 .,'/-]{2,60})/i) ||
    (/\bMedicaid\b/i.test(singleLine) ? 'Medicaid' : null)

  const planType =
    extractFirstMatch(extractLineValue(/\bPlan\s+type\b/i) || '', /\b(Medicaid|Medicare|Marketplace|HMO|PPO)\b/i) ||
    extractFirstMatch(singleLine, /\bPlan\s+type\b\s*[:#-]?\s*(Medicaid|Medicare|Marketplace|HMO|PPO)\b/i) ||
    (/\bMedicaid\b/i.test(singleLine) ? 'Medicaid' : null)

  const planName =
    extractLineValue(/\bPlan\s+name\b/i) ||
    extractFirstMatch(singleLine, /\bPlan\s+name\b\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9 .,'/-]{2,80})/i) ||
    null

  return {
    insurance_provider: provider ? String(provider).replace(/\bPlan\s+name\b.*$/i, '').trim() : '',
    plan_name: planName ? String(planName).replace(/\bPlan\s+type\b.*$/i, '').trim() : '',
    plan_type: planType || '',
    member_id: memberId || '',
    group_id: groupId || '',
  }
}

async function upsertProfileSection(db, profileId, sectionKey, data, documentId) {
  await db.prepare(
    `
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = excluded.updated_by
    `,
  ).run(profileId, sectionKey, JSON.stringify(data), `document:${documentId}`)
}

export async function processDocumentIngestionJob({
  db,
  job,
  profileContext,
  getOpenAI,
  uploadDir,
}) {
  const params = job.parameters ?? {}
  const documentId = params.document_id
  const handwriting = params.handwriting === true
  const enableAi = normalizeEnableAi(params.enable_ai)
  const addToOpportunities = params.add_to_opportunities === true

  if (!documentId) {
    throw new Error('document_ingest job missing document_id parameter')
  }

  const document = await db
    .prepare('SELECT * FROM documents WHERE id = ?')
    .get(documentId)

  if (!document) {
    throw new Error(`Document ${documentId} not found`)
  }

  await db.prepare(
    `
      UPDATE documents
      SET processing_status = ?,
          processing_error = NULL,
          -- Self-heal legacy/invalid document statuses (Postgres enforces a CHECK constraint).
          status = CASE
            WHEN status IN ('draft', 'review', 'final', 'submitted') THEN status
            ELSE 'draft'
          END
      WHERE id = ?
    `,
  ).run('processing', documentId)

  const updates = []
  const profile = profileContext.profile
  const sections = profileContext.sections
  let extractRecord = null
  let extractConfidence = 0.0

  // Canonical extraction pipeline (async worker):
  // - Always extract text (PDF/DOCX/TXT)
  // - OCR fallback for scanned PDFs + images
  // - Persist a canonical DocumentExtract record + confidence/provenance
  try {
    const legacyText = normalizeText(document.extracted_text || '')

    const detected = detectFileType({
      filePath: document.file_path,
      mimeType: document.mime_type,
      fileName: document.name,
    })

    const fileHash = document.file_path ? await sha256File(document.file_path).catch(() => null) : null
    extractRecord = await ensureDocumentExtract(db, {
      documentId,
      sourceType: detected.source_type,
      fileHash,
    })

    // Legacy fast-path: if we already have extracted_text but no file path to re-process,
    // persist a canonical DocumentExtract row from that text and proceed.
    if (legacyText && !document.file_path) {
      const finished = new Date().toISOString()
      const meta = {
        source_type: detected.source_type || 'text',
        methods_used: ['legacy_text'],
        pages: null,
        char_count: legacyText.length,
        word_count: countWords(legacyText),
        warnings: ['Using legacy documents.extracted_text'],
        ocr_used: false,
        started_at: finished,
        finished_at: finished,
        provenance: {
          extractor: 'grantflow-document-ingestion',
          version: '1',
          ocr_provider: null,
          timestamps: { started_at: finished, finished_at: finished },
        },
      }
      const confidence = scoreExtraction({ ...meta, text: legacyText })
      await saveDocumentExtractResult(db, documentId, {
        text: legacyText,
        ocr_text: null,
        meta,
        confidence,
      })
      extractRecord = await getDocumentExtract(db, documentId)
    }

    // Caching: reuse an existing ready extract for identical file hash.
    if (fileHash) {
      const reused = await tryReuseExtractByHash(db, { fileHash, documentId })
      if (reused?.status === 'ready') {
        extractRecord = reused
      }
    }

    if (!extractRecord || extractRecord.status !== 'ready') {
      await markDocumentExtractProcessing(db, documentId, new Date().toISOString())
      const result = await extractTextWithFallback({
        filePath: document.file_path,
        mimeType: document.mime_type,
        fileName: document.name,
        ocrLanguage: 'eng',
        handwriting,
      })
      await saveDocumentExtractResult(db, documentId, result)
      extractRecord = await getDocumentExtract(db, documentId)
    }

    const canonicalText = String(extractRecord?.text || '').trim()
    extractConfidence = typeof extractRecord?.confidence === 'number' ? extractRecord.confidence : 0.0

    if (!canonicalText) {
      const message =
        'No readable text could be extracted. If this is a scanned PDF, ensure OCR is enabled (or use OCR_PROVIDER=aws_textract in production) and re-upload.'
      await markDocumentExtractFailed(db, documentId, {
        warnings: [message],
        finishedAtIso: new Date().toISOString(),
      })
      await db.prepare(
        `
          UPDATE documents
          SET processing_status = 'failed',
              processing_error = ?,
              extracted_text = NULL,
              status = CASE
                WHEN status IN ('draft', 'review', 'final', 'submitted') THEN status
                ELSE 'draft'
              END
          WHERE id = ?
        `,
      ).run(message, documentId)
      return {
        inserted: 0,
        sections_updated: [],
        document_id: documentId,
        summary: message,
        result_count: 0,
        result_meta: {
          document_id: documentId,
          profile_id: profile?.id ?? null,
          summary: message,
          extraction_status: 'failed',
        },
      }
    }

    // Back-compat: keep documents.extracted_text populated for downstream readers (download/print/UI).
    try {
      await db.prepare(
        `
          UPDATE documents
          SET extracted_text = ?,
              processing_status = 'completed',
              processing_error = NULL,
              updated_at = CURRENT_TIMESTAMP,
              status = CASE
                WHEN status IN ('draft', 'review', 'final', 'submitted') THEN status
                ELSE 'draft'
              END
          WHERE id = ?
        `,
      ).run(canonicalText, documentId)
    } catch (error) {
      // Unit tests use minimal schemas that may omit updated_at.
      if (String(error?.message || '').includes('no such column: updated_at')) {
        await db.prepare(
          `
            UPDATE documents
            SET extracted_text = ?,
                processing_status = 'completed',
                processing_error = NULL,
                status = CASE
                  WHEN status IN ('draft', 'review', 'final', 'submitted') THEN status
                  ELSE 'draft'
                END
            WHERE id = ?
          `,
        ).run(canonicalText, documentId)
      } else {
        throw error
      }
    }

    document.extracted_text = canonicalText

    if (addToOpportunities && canonicalText) {
      try {
        const oppResult = await extractAndUpsertOpportunitiesFromText(db, canonicalText)
        updates.push({
          type: 'opportunities',
          inserted: oppResult.inserted,
          skipped: oppResult.skipped,
          errors: oppResult.errors?.length ? oppResult.errors : undefined,
        })
      } catch (oppErr) {
        updates.push({
          type: 'opportunities',
          error: oppErr instanceof Error ? oppErr.message : String(oppErr),
        })
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markDocumentExtractFailed(db, documentId, { warnings: [message] })
    await db.prepare(
      `
        UPDATE documents
        SET processing_status = 'failed',
            processing_error = ?,
            status = CASE
              WHEN status IN ('draft', 'review', 'final', 'submitted') THEN status
              ELSE 'draft'
            END
        WHERE id = ?
      `,
    ).run(message, documentId)
    throw error
  }

  let docExcerpt = truncateText(document.extracted_text ?? document.notes ?? '', 5000)

  const documentSummary = [
    {
      id: document.id,
      name: document.name,
      type: document.type,
      status: document.status,
      notes: (() => {
        const base = docExcerpt || 'Document text unavailable.'
        if (enableAi && extractConfidence < 0.70) {
          return `WARNING: Document may be incomplete (confidence ${(extractConfidence ?? 0).toFixed(2)}). Use caution.\n\n${base}`
        }
        return base
      })(),
    },
  ]

  const aiSectionsLog = {}

  try {
    // Extraction-only mode (do not run AI parsing).
    if (!enableAi) {
      const oppUpdate = updates.find((u) => u.type === 'opportunities')
      return {
        inserted: 0,
        sections_updated: [],
        document_id: documentId,
        summary: 'Document text extracted.',
        result_count: 0,
        result_meta: {
          document_id: documentId,
          profile_id: profile?.id ?? null,
          extraction_status: extractRecord?.status ?? null,
          confidence: extractConfidence,
          opportunities_added: oppUpdate?.inserted ?? 0,
        },
      }
    }

    // Safety gating: if the extract is unreliable, we MAY still run AI parsing,
    // but must explicitly warn and avoid overconfident claims.
    const confidenceWarning =
      enableAi && extractConfidence < 0.70
        ? `Document may be incomplete (confidence ${(extractConfidence ?? 0).toFixed(2)}). ` +
          'Only extract facts that are explicitly present in the text; do not guess. Consider re-uploading a higher-quality file.'
        : null

    if (confidenceWarning) {
      aiSectionsLog._confidence_warning = confidenceWarning
    }

    // Auto-classify existing docs (in case they were uploaded without a school selection).
    if (!document.university_application_id && profile?.id && document.extracted_text) {
      try {
        const apps = await loadUniversityApplicationsForProfile(db, profile.id)
        const match = classifyUniversityApplicationForDocument({
          applications: apps,
          documentName: document.name,
          extractedText: document.extracted_text,
        })
        if (match) {
          try {
            await db.prepare(
              `
                UPDATE documents
                SET university_application_id = ?,
                    university_application_name = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `,
            ).run(match.id, match.name, documentId)
          } catch (error) {
            if (String(error?.message || '').includes('no such column: updated_at')) {
              await db.prepare(
                `
                  UPDATE documents
                  SET university_application_id = ?,
                      university_application_name = ?
                  WHERE id = ?
                `,
              ).run(match.id, match.name, documentId)
            } else {
              throw error
            }
          }
          document.university_application_id = match.id
          document.university_application_name = match.name
        }
      } catch {
        // best effort
      }
    }

    let openai = null
    let openaiUnavailableMessage = null
    try {
      openai = typeof getOpenAI === 'function' ? getOpenAI() : null
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI parsing unavailable.'
      // Degrade gracefully: we can still do OCR + deterministic extraction.
      aiSectionsLog._openai_client_error = message
      openaiUnavailableMessage = message
      openai = null
    }

    if (!docExcerpt) {
      const message =
        'No extractable text found for this document. If it is scanned, upload a JPG/PNG version to enable OCR.'
      await db.prepare(
        `
          UPDATE documents
          SET processing_status = 'completed',
              ai_summary = ?,
              processing_error = ?,
              status = CASE
                WHEN status IN ('draft', 'review', 'final', 'submitted') THEN status
                ELSE 'draft'
              END
          WHERE id = ?
        `,
      ).run(message, message, documentId)
      return {
        inserted: 0,
        sections_updated: [],
        document_id: documentId,
        summary: message,
        result_count: 0,
        result_meta: {
          document_id: documentId,
          profile_id: profile?.id ?? null,
          summary: message,
          used_fallback: true,
          openai_unavailable: Boolean(openaiUnavailableMessage),
        },
      }
    }

    // Deterministic extraction (works even when the model provider is down).
    try {
      const heuristicBasic = extractBasicInformationHeuristics(document.extracted_text ?? document.notes ?? '')
      const { data: mergedBasic, updatedFields: updatedBasic } = mergeSectionData(
        sections.basic_information ?? {},
        heuristicBasic,
      )
      if (updatedBasic.size > 0) {
        await upsertProfileSection(db, profile.id, 'basic_information', mergedBasic, document.id)
        sections.basic_information = mergedBasic
        updates.push({ section_key: 'basic_information', updated_fields: Array.from(updatedBasic) })
        aiSectionsLog.basic_information = { ...(aiSectionsLog.basic_information || {}), heuristic: heuristicBasic }
      }

      const heuristicOrg = extractOrganizationDetailsHeuristics(document.extracted_text ?? document.notes ?? '')
      const { data: mergedOrg, updatedFields: updatedOrg } = mergeSectionData(
        sections.organization_details ?? {},
        heuristicOrg,
      )
      if (updatedOrg.size > 0) {
        await upsertProfileSection(db, profile.id, 'organization_details', mergedOrg, document.id)
        sections.organization_details = mergedOrg
        updates.push({ section_key: 'organization_details', updated_fields: Array.from(updatedOrg) })
        aiSectionsLog.organization_details = { ...(aiSectionsLog.organization_details || {}), heuristic: heuristicOrg }
      }

      const heuristicInsurance = extractMedicalInsuranceHeuristics(document.extracted_text ?? document.notes ?? '')
      const { data: mergedIns, updatedFields: updatedIns } = mergeSectionData(
        sections.medical_insurance ?? {},
        heuristicInsurance,
      )
      if (updatedIns.size > 0) {
        await upsertProfileSection(db, profile.id, 'medical_insurance', mergedIns, document.id)
        sections.medical_insurance = mergedIns
        updates.push({ section_key: 'medical_insurance', updated_fields: Array.from(updatedIns) })
        aiSectionsLog.medical_insurance = { ...(aiSectionsLog.medical_insurance || {}), heuristic: heuristicInsurance }
      }
    } catch {
      // best-effort
    }

    let openAIWarning = null
    const hasAnyAiProvider = Boolean(openai || process.env.ANTHROPIC_API_KEY)

    for (const sectionKey of TARGET_SECTIONS) {
      if (!hasAnyAiProvider) break
      const promptPayload = buildProfileSectionPrompt(sectionKey, {
        profile,
        sections,
        documents: documentSummary,
      })

      if (!promptPayload) continue

      try {
        const result = await invokeJsonWithFallback({
          openai,
          system: 'You are an expert data extraction assistant. Respond with valid JSON only.',
          prompt: promptPayload.prompt,
          temperature: 0.1,
          maxTokens: 1200,
          openaiModel: 'gpt-4o-mini',
        })

        if (!result.ok || !result.json) {
          const openaiAuth = result?.openaiError?.isAuth
          const errorMessage =
            (result?.openaiError?.message || result?.anthropicError?.message || result?.error?.message || 'AI parsing failed')
          aiSectionsLog[sectionKey] = { error: errorMessage, provider: result?.provider ?? 'fallback' }
          if (openaiAuth) {
            openAIWarning = result.openaiError.message
            aiSectionsLog._openai_auth_error = result.openaiError.message
          }
          // Stop trying AI if both providers are failing; deterministic fallback continues below.
          if (!openai && !process.env.ANTHROPIC_API_KEY) break
          if (result?.anthropicError) break
          continue
        }

        const suggestion = result.json

        const existing = sections[sectionKey] ?? {}
        const { data: merged, updatedFields } = mergeSectionData(existing, suggestion)

        if (updatedFields.size > 0) {
          await upsertProfileSection(db, profile.id, sectionKey, merged, document.id)
          sections[sectionKey] = merged
          updates.push({
            section_key: sectionKey,
            updated_fields: Array.from(updatedFields),
          })
        }

        aiSectionsLog[sectionKey] = {
          suggestion,
          updated: Array.from(updatedFields),
          provider: result.provider,
        }
      } catch (error) {
        const summary = summarizeOpenAIError(error)
        console.error(`Failed to enrich section ${sectionKey}`, summary)
        if (summary.isAuth) {
          openAIWarning = summary.message
          aiSectionsLog._openai_auth_error = summary.message
          openai = null
        }
        // If AI is unstable, stop looping to avoid repeated failures.
        break
      }
    }

    // Anthropic fallback: if OpenAI is missing/invalid, try extracting structured JSON via Anthropic.
    // This keeps AI-assisted parsing working even when OPENAI_API_KEY is invalid.
    if (!openai) {
      const anthropic = await createAnthropicClient()
      if (anthropic) {
        aiSectionsLog._ai_provider_fallback = 'anthropic'

        for (const sectionKey of TARGET_SECTIONS) {
          const promptPayload = buildProfileSectionPrompt(sectionKey, {
            profile,
            sections,
            documents: documentSummary,
          })
          if (!promptPayload) continue

          try {
            const response = await anthropic.messages.create({
              model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
              max_tokens: 1200,
              temperature: 0.1,
              system: 'You are an expert data extraction assistant. Respond with valid JSON only.',
              messages: [{ role: 'user', content: promptPayload.prompt }],
            })

            const raw = extractAnthropicText(response) || '{}'
            let suggestion = {}
            try {
              suggestion = JSON.parse(raw)
            } catch {
              continue
            }

            const existing = sections[sectionKey] ?? {}
            const { data: merged, updatedFields } = mergeSectionData(existing, suggestion)

            if (updatedFields.size > 0) {
              await upsertProfileSection(db, profile.id, sectionKey, merged, document.id)
              sections[sectionKey] = merged
              updates.push({
                section_key: sectionKey,
                updated_fields: Array.from(updatedFields),
              })
            }

            aiSectionsLog[sectionKey] = {
              suggestion,
              updated: Array.from(updatedFields),
              provider: 'anthropic',
            }
          } catch (error) {
            // Keep best-effort behavior; do not fail the whole ingestion job.
            aiSectionsLog._anthropic_error = error?.message || String(error)
          }
        }
      }
    }

    // University deterministic parsing is useful even without AI (or when AI doesn't produce structured updates).
    const shouldRunUniversityFallback = Boolean(!openai || openAIWarning || openaiUnavailableMessage || updates.length === 0)
    if (shouldRunUniversityFallback) {
      const fallbackUniversityUpdate = await applyFallbackUniversityUpdates({
        db,
        profileId: profile?.id ?? null,
        document,
        extractedText: document.extracted_text ?? document.notes ?? '',
      })

      if (fallbackUniversityUpdate.updated) {
        updates.push({
          section_key: 'university_applications',
          updated_fields: fallbackUniversityUpdate.updated_fields,
        })
      }
    }

    const usedFallback = Boolean(openaiUnavailableMessage || openAIWarning)
    const status = 'completed'
    const summary = usedFallback
      ? buildFallbackDocumentSummary({
          document,
          extractedText: document.extracted_text ?? document.notes ?? '',
        })
      : updates.length > 0
          ? updates
              .map(
                (entry) =>
                  `${entry.section_key}: ${entry.updated_fields
                    .map((field) => field.replace(/_/g, ' '))
                    .join(', ')}`,
              )
              .join(' • ')
          : 'No new structured data extracted from this document.'

    const oppUpdate = updates.find((u) => u.type === 'opportunities')
    const resultMeta = {
      document_id: documentId,
      profile_id: profile?.id ?? null,
      summary,
      sections_updated: updates,
      total_sections_updated: updates.length,
      used_fallback: usedFallback,
      openai_unavailable: Boolean(openaiUnavailableMessage),
      openai_error: openAIWarning || openaiUnavailableMessage || null,
      opportunities_added: oppUpdate?.inserted ?? 0,
    }

    const processingError = (openAIWarning || openaiUnavailableMessage)
      ? `AI parsing unavailable: ${openAIWarning || openaiUnavailableMessage}`
      : null

    await db.prepare(
      `
        UPDATE documents
        SET processing_status = ?,
            ai_summary = ?,
            ai_sections = ?,
            processing_error = ?,
            status = CASE
              WHEN status IN ('draft', 'review', 'final', 'submitted') THEN status
              ELSE 'draft'
            END
        WHERE id = ?
      `,
    ).run(status, summary, JSON.stringify(aiSectionsLog, null, 2), processingError, documentId)

    return {
      inserted: updates.length,
      sections_updated: updates,
      document_id: documentId,
      summary,
      result_count: updates.length,
      result_meta: resultMeta,
    }
  } catch (error) {
    await db.prepare(
      `
        UPDATE documents
        SET processing_status = 'failed',
            processing_error = ?,
            status = CASE
              WHEN status IN ('draft', 'review', 'final', 'submitted') THEN status
              ELSE 'draft'
            END
        WHERE id = ?
      `,
    ).run(error instanceof Error ? error.message : String(error), documentId)
    throw error
  }
}
