import { buildProfileSignals, summarizeProfileSignals } from './profileHelpers.js'
import { extractCompletionText } from '../utils/openai.js'
import { safeParseJSON } from '../utils/safeJson.js'

function mergeValues(existingValue, incomingValue) {
  if (incomingValue === undefined || incomingValue === null) {
    return existingValue
  }

  if (typeof incomingValue === 'string') {
    const trimmed = incomingValue.trim()
    if (!trimmed) return existingValue
    if (!existingValue || typeof existingValue !== 'string' || !existingValue.trim()) {
      return trimmed
    }
    if (existingValue.toLowerCase().includes(trimmed.toLowerCase())) {
      return existingValue
    }
    return `${existingValue}\n${trimmed}`.trim()
  }

  if (typeof incomingValue === 'number') {
    return Number.isFinite(incomingValue) ? incomingValue : existingValue
  }

  if (Array.isArray(incomingValue)) {
    const existing = Array.isArray(existingValue) ? existingValue.slice() : []
    const set = new Set(existing.map((entry) => JSON.stringify(entry)))
    incomingValue.forEach((entry) => {
      const key = JSON.stringify(entry)
      if (!set.has(key)) {
        set.add(key)
        existing.push(entry)
      }
    })
    return existing
  }

  if (typeof incomingValue === 'object') {
    const next = { ...(typeof existingValue === 'object' && existingValue ? existingValue : {}) }
    Object.entries(incomingValue).forEach(([key, value]) => {
      next[key] = mergeValues(next[key], value)
    })
    return next
  }

  return existingValue ?? incomingValue
}

function mergeSection(existingSection = {}, incomingSection = {}) {
  const merged = { ...existingSection }
  Object.entries(incomingSection).forEach(([key, value]) => {
    merged[key] = mergeValues(existingSection[key], value)
  })
  return merged
}

function upsertEnrichedSection(db, profileId, sectionKey, data) {
  db.prepare(
    `
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = excluded.updated_by
    `,
  ).run(profileId, sectionKey, JSON.stringify(data), 'profile_enrichment_crawler')
}

export async function processProfileEnrichmentJob({ db, job, profileContext, getOpenAI }) {
  const { profile } = profileContext ?? {}
  if (!profile) {
    throw new Error('profile_enrichment job requires a profile context')
  }

  // Validate job and parameters exist
  if (!job || !job.id) {
    throw new Error('Invalid job object')
  }

  const parameters = job.parameters ?? {}
  const sectionsParam = parameters.sections
  const sectionsToEnrich = Array.isArray(sectionsParam) && sectionsParam.length > 0 ? sectionsParam : ['basic_information']
  const prompt = typeof parameters.prompt === 'string' ? parameters.prompt.trim() : ''

  const existingSections = db
    .prepare(
      `
        SELECT section_key, data
        FROM profile_sections
        WHERE profile_id = ?
      `,
    )
    .all(profile.id)
    .reduce((acc, row) => {
      acc[row.section_key] = safeParseJSON(row.data, {})
      return acc
    }, {})

  const signalSummary = summarizeProfileSignals(
    profileContext.signals ?? buildProfileSignals({ profile, sections: profileContext.sections ?? {} }),
  )

  const payload = {
    job_id: job.id,
    profile: {
      id: profile.id,
      display_name: profile.display_name,
      primary_type: profile.primary_type,
      tags: profile.tags ? safeParseJSON(profile.tags, []) : [],
      summary: signalSummary,
    },
    sections: sectionsToEnrich.map((sectionKey) => ({
      key: sectionKey,
      existing: existingSections[sectionKey] ?? {},
    })),
    instructions:
      prompt ||
      'Enrich these sections with factual, structured data. Never fabricate financials or sensitive personal identifiers.',
  }

  // Validate getOpenAI function exists
  if (!getOpenAI || typeof getOpenAI !== 'function') {
    throw new Error('getOpenAI function is required')
  }

  const openai = getOpenAI()

  let completion
  try {
    completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are Anya, the GrantFlow enrichment assistant. Respond with JSON shaped as { "sections": [ { "key": string, "data": object, "notes": string? } ] }. Only include fields you can support with evidence.',
        },
        {
          role: 'user',
          content: JSON.stringify(payload, null, 2),
        },
      ],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    db.prepare(
      `
        UPDATE crawler_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            result_meta = ?,
            error = ?
        WHERE id = ?
      `,
    ).run(JSON.stringify({ error: message }), message, job.id)
    throw error
  }

  const content = extractCompletionText(completion) || '{}'
  let parsed = {}
  try {
    parsed = safeParseJSON(content, {})
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid parsed JSON - expected object')
    }
  } catch (error) {
    db.prepare(
      `
        UPDATE crawler_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            result_meta = ?,
            error = 'Invalid JSON returned from enrichment model'
        WHERE id = ?
      `,
    ).run(JSON.stringify({ error: 'Invalid JSON returned from enrichment model' }), job.id)
    throw new Error('Profile enrichment response was not valid JSON')
  }

  const sections = Array.isArray(parsed.sections) ? parsed.sections : []
  const updatedSections = []

  const enrichmentLog = []

  sections.forEach((section) => {
    if (!section || typeof section !== 'object') return
    const sectionKey = section.key
    if (typeof sectionKey !== 'string' || !sectionKey) return
    const data = section.data
    if (!data || typeof data !== 'object') return

    const merged = mergeSection(existingSections[sectionKey], data)
    upsertEnrichedSection(db, profile.id, sectionKey, merged)
    existingSections[sectionKey] = merged
    updatedSections.push(sectionKey)
    enrichmentLog.push({
      section_key: sectionKey,
      updated_fields: Object.keys(data),
      notes: section.notes ?? null,
    })
  })

  const resultMeta = {
    sections: enrichmentLog,
    prompt: prompt || null,
  }

  db.prepare(
    `
      UPDATE crawler_jobs
      SET status = 'completed',
          completed_at = CURRENT_TIMESTAMP,
          result_count = ?,
          result_meta = ?,
          error = NULL
      WHERE id = ?
    `,
  ).run(updatedSections.length, JSON.stringify(resultMeta), job.id)

  return {
    updated_sections: updatedSections,
    notes: sections.map((section) => section.notes).filter(Boolean),
    log: enrichmentLog,
  }
}
