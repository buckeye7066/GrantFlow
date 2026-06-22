import { buildProfileSectionPrompt } from '../prompts/profileSections.js'
import { summarizeOpenAIError } from '../utils/openaiClient.js'
import { invokeJsonWithFallback } from '../utils/aiProviders.js'
import { buildFallbackDocumentSummary, applyFallbackUniversityUpdates } from './documentFallbackParser.js'
import { classifyUniversityApplicationForDocument, loadUniversityApplicationsForProfile } from './universityDocumentClassifier.js'
import { extractAndUpsertOpportunitiesFromText } from './extractOpportunitiesFromDocumentText.js'
import { countWords, detectFileType, extractTextWithFallback, normalizeText, scoreExtraction, sha256File } from './documentIngestion/index.js'
import {
  extractBasicInformationHeuristics,
  extractGovernmentAssistanceHeuristics,
  extractMedicalInsuranceHeuristics,
  extractOrganizationDetailsHeuristics,
} from './documentIngestion/heuristics.js'

// Re-export the heuristic helpers so external callers (regression tests
// in tests/unit/, downstream services) can import them directly from
// `backend/services/documentIngestion.js` without having to know the
// internal path under documentIngestion/heuristics.js. This is the
// existing public surface that the documentIngestion-heuristics and
// heuristics-cleveland-end-to-end test suites depend on.
export {
  extractBasicInformationHeuristics,
  extractGovernmentAssistanceHeuristics,
  extractMedicalInsuranceHeuristics,
  extractOrganizationDetailsHeuristics,
}
import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js'
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
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    return new Anthropic({
    apiKey: key,
    timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || 20_000),
    maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || 1),
  })
  } catch (error) { console.error('Failed to load Anthropic SDK:', error); return null; }
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

async function upsertProfileSection(db, profileId, sectionKey, data, documentId) {
  const guarded = await guardProfileSectionForWrite(db, profileId, sectionKey, data)
  await db.prepare(
    `
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = excluded.updated_by
    `,
  ).run(profileId, sectionKey, JSON.stringify(guarded.data), `document:${documentId}`)
  return guarded
}

function buildIngestSummaryFromUpdates(updates, { usedFallback = false, document, extractedText = '' } = {}) {
  if (usedFallback) {
    return buildFallbackDocumentSummary({ document, extractedText })
  }
  if (updates.length > 0) {
    return updates
      .filter((entry) => entry.section_key)
      .map(
        (entry) =>
          `${entry.section_key}: ${entry.updated_fields
            .map((field) => field.replace(/_/g, ' '))
            .join(', ')}`,
      )
      .join(' • ')
  }
  return 'No new structured data extracted from this document.'
}

async function finalizeDocumentIngestRecord(db, documentId, {
  status = 'completed',
  summary,
  aiSectionsLog,
  processingError = null,
}) {
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
}

async function syncProfileDisplayNameFromSections(db, profileId, sections) {
  if (!profileId || !sections) return
  try {
    const profile = await db.prepare('SELECT display_name FROM profiles WHERE id = ? LIMIT 1').get(profileId)
    const current = String(profile?.display_name || '').trim()
    const looksAutoGenerated =
      !current ||
      /new profile/i.test(current) ||
      /\.(pdf|docx?|png|jpe?g)$/i.test(current) ||
      /grantflow|public_info|filled/i.test(current)

    if (!looksAutoGenerated) return

    const candidate =
      String(sections.basic_information?.full_name || '').trim() ||
      String(sections.organization_details?.organization_name || '').trim() ||
      null

    if (!candidate || candidate.length < 3) return

    await db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run(candidate.slice(0, 200), profileId)
    try {
      await db.prepare('UPDATE profiles SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(profileId)
    } catch {
      // updated_at column may not exist on legacy/test schemas
    }
  } catch (error) {
    console.warn('[documentIngestion] syncProfileDisplayNameFromSections failed:', error?.message || error)
  }
}

async function applyDeterministicSectionExtracts({
  db,
  profile,
  sections,
  document,
  updates,
  aiSectionsLog,
}) {
  const sourceText = document.extracted_text ?? document.notes ?? ''

  const heuristicBasic = extractBasicInformationHeuristics(sourceText)
  const { data: mergedBasic, updatedFields: updatedBasic } = mergeSectionData(
    sections.basic_information ?? {},
    heuristicBasic,
  )
  if (updatedBasic.size > 0) {
    if (!profile?.id) throw new Error('Profile ID required for section updates')
    await upsertProfileSection(db, profile.id, 'basic_information', mergedBasic, document.id)
    sections.basic_information = mergedBasic
    updates.push({ section_key: 'basic_information', updated_fields: Array.from(updatedBasic) })
    aiSectionsLog.basic_information = { ...(aiSectionsLog.basic_information || {}), heuristic: heuristicBasic }
  }

  const heuristicOrg = extractOrganizationDetailsHeuristics(sourceText)
  const { data: mergedOrg, updatedFields: updatedOrg } = mergeSectionData(
    sections.organization_details ?? {},
    heuristicOrg,
  )
  if (updatedOrg.size > 0) {
    if (!profile?.id) throw new Error('Profile ID required for section updates')
    await upsertProfileSection(db, profile.id, 'organization_details', mergedOrg, document.id)
    sections.organization_details = mergedOrg
    updates.push({ section_key: 'organization_details', updated_fields: Array.from(updatedOrg) })
    aiSectionsLog.organization_details = { ...(aiSectionsLog.organization_details || {}), heuristic: heuristicOrg }
  }

  const heuristicInsurance = extractMedicalInsuranceHeuristics(sourceText)
  const { data: mergedIns, updatedFields: updatedIns } = mergeSectionData(
    sections.medical_insurance ?? {},
    heuristicInsurance,
  )
  if (updatedIns.size > 0) {
    if (!profile?.id) throw new Error('Profile ID required for section updates')
    await upsertProfileSection(db, profile.id, 'medical_insurance', mergedIns, document.id)
    sections.medical_insurance = mergedIns
    updates.push({ section_key: 'medical_insurance', updated_fields: Array.from(updatedIns) })
    aiSectionsLog.medical_insurance = { ...(aiSectionsLog.medical_insurance || {}), heuristic: heuristicInsurance }
  }

  const heuristicGov = extractGovernmentAssistanceHeuristics(sourceText)
  if (Object.keys(heuristicGov).length > 0) {
    const { data: mergedGov, updatedFields: updatedGov } = mergeSectionData(
      sections.government_assistance ?? {},
      heuristicGov,
    )
    if (heuristicGov.other_programs) {
      const existingPrograms = String(sections.government_assistance?.other_programs ?? '').trim()
      if (existingPrograms) {
        const parts = new Set(
          existingPrograms
            .split(/[,;\n]/)
            .map((p) => p.trim())
            .filter(Boolean),
        )
        for (const p of String(heuristicGov.other_programs).split(/,\s*/)) {
          if (p) parts.add(p.trim())
        }
        const unioned = Array.from(parts).join(', ')
        if (unioned !== existingPrograms) {
          mergedGov.other_programs = unioned
          updatedGov.add('other_programs')
        } else {
          mergedGov.other_programs = existingPrograms
        }
      }
    }
    if (updatedGov.size > 0) {
      if (!profile?.id) throw new Error('Profile ID required for section updates')
      await upsertProfileSection(db, profile.id, 'government_assistance', mergedGov, document.id)
      sections.government_assistance = mergedGov
      updates.push({
        section_key: 'government_assistance',
        updated_fields: Array.from(updatedGov),
      })
      aiSectionsLog.government_assistance = {
        ...(aiSectionsLog.government_assistance || {}),
        heuristic: heuristicGov,
      }
    }
  }
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
    if (!docExcerpt) {
      const message =
        'No extractable text found for this document. If it is scanned, upload a JPG/PNG version to enable OCR.'
      await finalizeDocumentIngestRecord(db, documentId, {
        status: 'completed',
        summary: message,
        aiSectionsLog: { _empty_text: true },
        processingError: message,
      })
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
        },
      }
    }

    // Deterministic extraction always runs — even when LLM parsing is disabled
    // by tier or caller flags — so uploaded forms still populate profile sections.
    try {
      await applyDeterministicSectionExtracts({
        db,
        profile,
        sections,
        document,
        updates,
        aiSectionsLog,
      })
      await syncProfileDisplayNameFromSections(db, profile?.id, sections)
    } catch (error) {
      console.warn('[documentIngestion] deterministic section extract failed:', error?.message || error)
    }

    // Extraction-only mode (skip LLM parsing, but keep heuristic section writes above).
    if (!enableAi) {
      const summary = buildIngestSummaryFromUpdates(updates)
      aiSectionsLog._mode = 'heuristics_only'
      await finalizeDocumentIngestRecord(db, documentId, {
        summary,
        aiSectionsLog,
      })
      const oppUpdate = updates.find((u) => u.type === 'opportunities')
      return {
        inserted: updates.length,
        sections_updated: updates.filter((u) => u.section_key),
        document_id: documentId,
        summary,
        result_count: updates.length,
        result_meta: {
          document_id: documentId,
          profile_id: profile?.id ?? null,
          extraction_status: extractRecord?.status ?? null,
          confidence: extractConfidence,
          opportunities_added: oppUpdate?.inserted ?? 0,
          heuristics_only: true,
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
          if (!profile?.id) throw new Error('Profile ID required for section updates'); if (!profile?.id) throw new Error('Profile ID required for section updates'); await upsertProfileSection(db, profile.id, sectionKey, merged, document.id)
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
              model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
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
              if (!profile?.id) throw new Error('Profile ID required for section updates'); if (!profile?.id) throw new Error('Profile ID required for section updates'); await upsertProfileSection(db, profile.id, sectionKey, merged, document.id)
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

    await syncProfileDisplayNameFromSections(db, profile?.id, sections)

    // Now that the document's content is parsed into profile_sections (where
    // Hamilton's autofill reads), re-check her waiting tasks: any field she
    // flagged that this document just filled is resolved and the task
    // auto-resumes — "parse the doc → Hamilton knows what to place where →
    // Hamilton continues". Best-effort: never fail ingestion on the reconcile.
    if (profile?.id && updates.length > 0) {
      try {
        const { reconcileProfileAfterParse } = await import('./hamilton/applicationTaskStore.js')
        await reconcileProfileAfterParse(db, { profileId: profile.id })
      } catch { /* never block ingestion on the Hamilton reconcile */ }
    }

    // Owner requirement (b): if this document/URL is a COMPLETED application for a
    // known funding-source portal (e.g. a completed FAFSA link), mark that portal
    // complete-but-NOT-merged so the Portals dashboard reflects it and the weekly
    // reminder keeps nudging until it's merged. Best-effort: never fail ingestion.
    if (profile?.id) {
      try {
        const { detectAndMarkCompletedApplications } = await import('./hamilton/portalCompletionDetector.js')
        await detectAndMarkCompletedApplications(db, {
          profileId: profile.id,
          documentId,
          grantId: document.grant_id || null,
          fileUrl: document.file_url || null,
          text: document.extracted_text ?? document.notes ?? '',
          fileName: document.name || null,
        })
      } catch { /* never block ingestion on portal-completion detection */ }
    }

    const usedFallback = Boolean(openaiUnavailableMessage || openAIWarning)
    const summary = buildIngestSummaryFromUpdates(updates, {
      usedFallback,
      document,
      extractedText: document.extracted_text ?? document.notes ?? '',
    })

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

    await finalizeDocumentIngestRecord(db, documentId, {
      summary,
      aiSectionsLog,
      processingError,
    })

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
