import { buildProfileSectionPrompt } from '../prompts/profileSections.js'
import { extractCompletionText } from '../utils/openai.js'
import { extractTextFromFile } from './documentTextExtraction.js'
import { summarizeOpenAIError } from '../utils/openaiClient.js'
import { invokeJsonWithFallback } from '../utils/aiProviders.js'
import { promises as fsp } from 'node:fs'
import { buildFallbackDocumentSummary, applyFallbackUniversityUpdates } from './documentFallbackParser.js'
import { classifyUniversityApplicationForDocument, loadUniversityApplicationsForProfile } from './universityDocumentClassifier.js'

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

function isImageMime(mimeType) {
  const safe = String(mimeType || '').toLowerCase().trim()
  return safe.startsWith('image/') || safe === 'application/octet-stream'
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

async function extractTextFromImageWithVision({ openai, filePath, mimeType }) {
  if (!openai) return null
  if (!filePath) return null

  const buffer = await fsp.readFile(filePath)
  // Guard: avoid pushing huge base64 payloads to the model.
  if (buffer.length > 8 * 1024 * 1024) {
    return null
  }

  const safeMime = String(mimeType || 'image/png').trim() || 'image/png'
  const base64 = buffer.toString('base64')
  const url = `data:${safeMime};base64,${base64}`

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.0,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Extract all readable text from this image. Preserve line breaks. Return plain text only (no markdown, no JSON). If nothing is readable, return an empty string.',
          },
          { type: 'image_url', image_url: { url } },
        ],
      },
    ],
  })

  const text = String(extractCompletionText(completion) || '').trim()
  return text || null
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

  // If we don't have extracted text yet, try again here (handles remote-url ingests and prior failures).
  try {
    if (!document.extracted_text && document.file_path && document.mime_type) {
      const result = await extractTextFromFile({
        filePath: document.file_path,
        mimeType: document.mime_type,
        fileName: document.name,
        ocr: true,
        handwriting,
        ocrLanguage: 'eng',
      })
      if (result?.text) {
        await db.prepare('UPDATE documents SET extracted_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
          result.text,
          documentId,
        )
        document.extracted_text = result.text
      }
    }
  } catch (error) {
    // Best-effort; we'll proceed and let downstream report "text unavailable".
  }

  let docExcerpt = truncateText(document.extracted_text ?? document.notes ?? '', 5000)

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
          await db.prepare(
            `
              UPDATE documents
              SET university_application_id = ?,
                  university_application_name = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `,
          ).run(match.id, match.name, documentId)
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

    // If this is an image (screenshots/handwriting) and OCR didn't yield text, use a vision pass as a fallback.
    try {
      const current = String(document.extracted_text || '').trim()
      const handwriting = Boolean(params?.handwriting)
      const shouldTryVision =
        openai &&
        document.file_path &&
        isImageMime(document.mime_type) &&
        (handwriting || !current || current.length < 40)

      if (shouldTryVision) {
        const visionText = await extractTextFromImageWithVision({
          openai,
          filePath: document.file_path,
          mimeType: document.mime_type,
        })
        if (visionText) {
          await db
            .prepare('UPDATE documents SET extracted_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(visionText, documentId)
          document.extracted_text = visionText
          docExcerpt = truncateText(document.extracted_text ?? document.notes ?? '', 5000)
        }
      }
    } catch {
      // best-effort; fall through
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

    const resultMeta = {
      document_id: documentId,
      profile_id: profile?.id ?? null,
      summary,
      sections_updated: updates,
      total_sections_updated: updates.length,
      used_fallback: usedFallback,
      openai_unavailable: Boolean(openaiUnavailableMessage),
      openai_error: openAIWarning || openaiUnavailableMessage || null,
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
