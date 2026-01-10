import { buildProfileSectionPrompt, supportedSectionKeys } from '../prompts/profileSections.js'
import { extractCompletionText } from '../utils/openai.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { extractDocumentFacts } from './documentFactsExtractor.js'

function shouldIncludeUniversityApplications(profile, sections = {}) {
  const type = String(profile?.primary_type ?? '').toLowerCase()
  if (type.includes('student')) return true

  const category = String(sections?.basic_information?.profile_category ?? '').toLowerCase()
  if (category.includes('student')) return true

  const orgType = String(sections?.organization_details?.organization_type ?? '').toLowerCase()
  if (orgType.includes('student')) return true

  return false
}

function getTargetSections(profile, sections = {}) {
  const keys = Array.isArray(supportedSectionKeys) ? supportedSectionKeys.slice() : []
  if (shouldIncludeUniversityApplications(profile, sections)) return keys
  return keys.filter((key) => key !== 'university_applications')
}

function truncateText(text, limit = 16000) {
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
      const existingNormalized = normalizeValue(existingValue)
      if (!existingNormalized) {
        merged[key] = value
        updatedFields.add(key)
        return
      }

      // If existing is very short and incoming is meaningfully richer, prefer incoming.
      if (typeof existingNormalized === 'string' && existingNormalized.length < 25 && value.length >= 50) {
        merged[key] = value
        updatedFields.add(key)
        return
      }

      // If existing doesn't already contain incoming, append (keeps prior manual edits).
      const existingLower = String(existingNormalized).toLowerCase()
      const incomingLower = String(value).toLowerCase()
      if (!existingLower.includes(incomingLower)) {
        merged[key] = `${existingNormalized}\n${value}`.trim()
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
  const targetSections = getTargetSections(profile, sections)

  const docExcerpt = truncateText(
    document.extracted_text ?? document.notes ?? '',
    16000,
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
    // Pass 0 (deterministic facts): extract key identifiers and contact info with regexes.
    try {
      const facts = extractDocumentFacts(docExcerpt || '')
      const factsTarget = [
        { section_key: 'basic_information', data: facts.basic_information },
        { section_key: 'organization_details', data: facts.organization_details },
      ]

      factsTarget.forEach((entry) => {
        if (!entry.data || typeof entry.data !== 'object') return
        const existing = sections[entry.section_key] ?? {}
        const { data: merged, updatedFields } = mergeSectionData(existing, entry.data)
        if (updatedFields.size > 0) {
          upsertProfileSection(db, profile.id, entry.section_key, merged, document.id)
          sections[entry.section_key] = merged
          updates.push({
            section_key: entry.section_key,
            updated_fields: Array.from(updatedFields),
          })
        }
        aiSectionsLog[`${entry.section_key}__facts`] = {
          suggestion: entry.data,
          updated: Array.from(updatedFields),
        }
      })
    } catch (error) {
      console.error('Deterministic document facts extraction failed', error)
    }

    // Pass 1 (high recall): extract a cross-section payload once, then merge into sections.
    // This dramatically improves coverage versus 1-prompt-per-section, while still being conservative about fabrication.
    try {
      const extractionPayload = {
        profile: {
          id: profile.id,
          display_name: profile.display_name,
          primary_type: profile.primary_type,
          tags: profile.tags,
        },
        existing_sections: sections,
        document: {
          id: document.id,
          name: document.name,
          type: document.type,
          extracted_text: docExcerpt || '',
        },
        target_sections: targetSections,
      }

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are an expert information extraction assistant. Extract as much structured information as possible from the document text for the target sections. Do NOT fabricate. Use empty strings/null/false when unknown. Respond as JSON: { "sections": { [section_key]: { ...fields } } }.',
          },
          { role: 'user', content: JSON.stringify(extractionPayload, null, 2) },
        ],
      })

      const raw = extractCompletionText(completion) || '{}'
      const parsed = safeParseJSON(raw, {})
      const extractedSections = parsed && typeof parsed === 'object' ? parsed.sections : null

      if (extractedSections && typeof extractedSections === 'object') {
        for (const sectionKey of targetSections) {
          const suggestion = extractedSections[sectionKey]
          if (!suggestion || typeof suggestion !== 'object') continue

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

          aiSectionsLog[`${sectionKey}__high_recall`] = {
            suggestion,
            updated: Array.from(updatedFields),
          }
        }
      }
    } catch (error) {
      console.error('High-recall document extraction failed', error)
    }

    // Pass 2 (precision): per-section prompts to refine/confirm fields.
    for (const sectionKey of targetSections) {
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
