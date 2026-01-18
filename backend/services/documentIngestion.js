import { buildProfileSectionPrompt } from '../prompts/profileSections.js'
import { extractCompletionText } from '../utils/openai.js'
import { extractTextFromFile } from './documentTextExtraction.js'
import { summarizeOpenAIError } from '../utils/openaiClient.js'

const TARGET_SECTIONS = [
  'basic_information',
  'organization_details',
  'financial_information',
  'government_assistance',
  'health_medical',
  'demographics',
  'family_life',
  'military_service',
  'occupation',
  'location_focus',
  'narrative',
]

function truncateText(text, limit = 4000) {
  if (!text) return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

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

function mergeSectionData(existing = {}, incoming = {}) {
  const merged = { ...existing }
  const updatedFields = new Set()

  Object.entries(incoming).forEach(([key, rawValue]) => {
    if (rawValue === undefined || rawValue === null) return
    const value = normalizeValue(rawValue)
    const existingValue = merged[key]

    if (typeof value === 'string') {
      if (!value) return
      if (!existingValue || !normalizeValue(existingValue)) {
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

function upsertProfileSection(db, profileId, sectionKey, data, documentId) {
  db.prepare(
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

  if (!documentId) {
    throw new Error('document_ingest job missing document_id parameter')
  }

  const document = db
    .prepare('SELECT * FROM documents WHERE id = ?')
    .get(documentId)

  if (!document) {
    throw new Error(`Document ${documentId} not found`)
  }

  db.prepare(
    'UPDATE documents SET processing_status = ?, processing_error = NULL WHERE id = ?',
  ).run('processing', documentId)

  const updates = []
  const profile = profileContext.profile
  const sections = profileContext.sections

  // If we don't have extracted text yet, try again here (handles remote-url ingests and prior failures).
  try {
    if (!document.extracted_text && document.file_path && document.mime_type) {
      const result = await extractTextFromFile({
        filePath: document.file_path,
        mimeType: document.mime_type,
        fileName: document.name,
        ocr: true,
        ocrLanguage: 'eng',
      })
      if (result?.text) {
        db.prepare('UPDATE documents SET extracted_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
          result.text,
          documentId,
        )
        document.extracted_text = result.text
      }
    }
  } catch (error) {
    // Best-effort; we'll proceed and let downstream report "text unavailable".
  }

  const docExcerpt = truncateText(
    document.extracted_text ?? document.notes ?? '',
    5000,
  )

  const documentSummary = [
    {
      id: document.id,
      name: document.name,
      type: document.type,
      status: document.status,
      notes: docExcerpt || 'Document text unavailable.',
    },
  ]

  const aiSectionsLog = {}

  try {
    let openai = null
    try {
      openai = typeof getOpenAI === 'function' ? getOpenAI() : null
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI parsing unavailable.'
      // Degrade gracefully: we can still do OCR + deterministic extraction and mark the document processed.
      aiSectionsLog._openai_client_error = message
      openai = null
    }

    if (!docExcerpt) {
      const message =
        'No extractable text found for this document. If it is scanned, upload a JPG/PNG version to enable OCR.'
      db.prepare(
        `
          UPDATE documents
          SET processing_status = 'failed',
              processing_error = ?
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
          error: message,
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
        upsertProfileSection(db, profile.id, 'basic_information', mergedBasic, document.id)
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
        upsertProfileSection(db, profile.id, 'organization_details', mergedOrg, document.id)
        sections.organization_details = mergedOrg
        updates.push({ section_key: 'organization_details', updated_fields: Array.from(updatedOrg) })
        aiSectionsLog.organization_details = { ...(aiSectionsLog.organization_details || {}), heuristic: heuristicOrg }
      }
    } catch {
      // best-effort
    }

    let fatalOpenAIError = null

    for (const sectionKey of TARGET_SECTIONS) {
      if (!openai) break
      const promptPayload = buildProfileSectionPrompt(sectionKey, {
        profile,
        sections,
        documents: documentSummary,
      })

      if (!promptPayload) continue

      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are an expert data extraction assistant. Respond with valid JSON only.',
            },
            { role: 'user', content: promptPayload.prompt },
          ],
        })

        const raw = extractCompletionText(completion) || '{}'
        let suggestion = {}
        try {
          suggestion = JSON.parse(raw)
        } catch {
          continue
        }

        const existing = sections[sectionKey] ?? {}
        const { data: merged, updatedFields } = mergeSectionData(existing, suggestion)

        if (updatedFields.size > 0) {
          upsertProfileSection(db, profile.id, sectionKey, merged, document.id)
          sections[sectionKey] = merged
          updates.push({
            section_key: sectionKey,
            updated_fields: Array.from(updatedFields),
          })
        }

        aiSectionsLog[sectionKey] = {
          suggestion,
          updated: Array.from(updatedFields),
        }
      } catch (error) {
        const summary = summarizeOpenAIError(error)
        console.error(`Failed to enrich section ${sectionKey}`, summary)

        // If the key is invalid (or access is forbidden), stop and surface the real error.
        if (summary.isAuth) {
          fatalOpenAIError = summary.message
          break
        }
      }
    }

    if (fatalOpenAIError) {
      const message = `AI parsing failed: ${fatalOpenAIError}`
      db.prepare(
        `
          UPDATE documents
          SET processing_status = 'failed',
              processing_error = ?
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
          error: message,
        },
      }
    }

    const status = 'completed'
    const summary =
      updates.length > 0
        ? updates
            .map(
              (entry) =>
                `${entry.section_key}: ${entry.updated_fields
                  .map((field) => field.replace(/_/g, ' '))
                  .join(', ')}`,
            )
            .join(' • ')
        : 'No new structured data extracted from this document.'

    const resultMeta = {
      document_id: documentId,
      profile_id: profile?.id ?? null,
      summary,
      sections_updated: updates,
      total_sections_updated: updates.length,
    }

    db.prepare(
      `
        UPDATE documents
        SET processing_status = ?,
            ai_summary = ?,
            ai_sections = ?,
            processing_error = NULL,
            status = 'processed'
        WHERE id = ?
      `,
    ).run(status, summary, JSON.stringify(aiSectionsLog, null, 2), documentId)

    return {
      inserted: updates.length,
      sections_updated: updates,
      document_id: documentId,
      summary,
      result_count: updates.length,
      result_meta: resultMeta,
    }
  } catch (error) {
    db.prepare(
      `
        UPDATE documents
        SET processing_status = 'failed',
            processing_error = ?
        WHERE id = ?
      `,
    ).run(error instanceof Error ? error.message : String(error), documentId)
    throw error
  }
}
