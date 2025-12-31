import { buildProfileSectionPrompt } from '../prompts/profileSections.js'
import { extractCompletionText } from '../utils/openai.js'

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

  const openai = getOpenAI()
  const updates = []
  const profile = profileContext.profile
  const sections = profileContext.sections

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
    for (const sectionKey of TARGET_SECTIONS) {
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
        console.error(`Failed to enrich section ${sectionKey}`, error)
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
