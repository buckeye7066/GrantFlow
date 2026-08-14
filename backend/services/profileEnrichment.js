import { buildProfileSignals, summarizeProfileSignals } from './profileHelpers.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { invokeJsonWithFallback } from '../utils/aiProviders.js'
import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js'

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

async function upsertEnrichedSection(db, profileId, sectionKey, data, context) {
  const guarded = await guardProfileSectionForWrite(db, profileId, sectionKey, data, context)
  await db.prepare(
    `
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = excluded.updated_by
    `,
  ).run(profileId, sectionKey, JSON.stringify(guarded.data), 'profile_enrichment_crawler')
  return guarded
}

export async function processProfileEnrichmentJob({ db, job, profileContext, getOpenAI }) {
  const { profile } = profileContext ?? {}
  if (!profile) {
    // Profile deleted or snapshot unhydrated between enqueue and dispatch.
    // Nothing to enrich — honest no-op rather than a failed job + error log.
    return {
      result_count: 0,
      result_meta: { skipped: true, noop_reason: 'profile context unavailable (deleted or unhydrated)' },
    }
  }

  // Validate job and parameters exist
  if (!job || !job.id) {
    throw new Error('Invalid job object')
  }

  // Verify the profile still exists before writing to profile_sections.
  // The snapshot may reference a profile that was deleted after job creation —
  // that's an honest no-op (nothing to enrich), not an error.
  const profileExists = await db
    .prepare('SELECT id FROM profiles WHERE id = ? LIMIT 1')
    .get(profile.id)
  if (!profileExists) {
    return {
      result_count: 0,
      result_meta: { skipped: true, noop_reason: `profile ${profile.id} no longer exists` },
    }
  }

  const parameters = job.parameters ?? {}
  const sectionsParam = parameters.sections
  const sectionsToEnrich = Array.isArray(sectionsParam) && sectionsParam.length > 0 ? sectionsParam : ['basic_information']
  const prompt = typeof parameters.prompt === 'string' ? parameters.prompt.trim() : ''

  const existingRows = await db
    .prepare(
      `
        SELECT section_key, data
        FROM profile_sections
        WHERE profile_id = ?
      `,
    )
    .all(profile.id)

  const existingSections = (existingRows || []).reduce((acc, row) => {
    acc[row.section_key] = safeParseJSON(row.data, {})
    return acc
  }, {})

  // Build signals from the freshly-fetched DB sections so the AI sees the most current profile
  const signalSummary = summarizeProfileSignals(
    profileContext.signals ?? buildProfileSignals({ profile, sections: existingSections }),
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

  let openai = null
  try {
    openai = typeof getOpenAI === 'function' ? getOpenAI() : null
  } catch {
    openai = null
  }

  const result = await invokeJsonWithFallback({
    openai,
    system:
      'You are Anya, the GrantFlow enrichment assistant. Respond with JSON shaped as { "sections": [ { "key": string, "data": object, "notes": string? } ] }. Only include fields you can support with evidence.',
    prompt: JSON.stringify(payload, null, 2),
    temperature: 0.1,
    maxTokens: 1800,
    openaiModel: 'gpt-4o-mini',
  })

  if (!result.ok || !result.json) {
    const warning =
      'AI enrichment unavailable (OpenAI invalid/missing and no Anthropic fallback configured).'
    const failMeta = {
      warning,
      provider: result.provider,
      sections_attempted: sectionsToEnrich,
      reason: result.error ?? 'AI provider unavailable',
    }
    await db.prepare(
      `
        UPDATE crawler_jobs
        SET status = 'completed',
            completed_at = CURRENT_TIMESTAMP,
            result_count = 0,
            result_meta = ?,
            error = NULL
        WHERE id = ?
      `,
    ).run(JSON.stringify(failMeta), job.id)
    return { updated_sections: [], notes: [warning], log: sectionsToEnrich.map((k) => ({ section_key: k, updated_fields: [], notes: warning })) }
  }

  const parsed = result.json
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Profile enrichment response was not a JSON object')
  }

  const sections = Array.isArray(parsed.sections) ? parsed.sections : []
  const updatedSections = []

  const enrichmentLog = []

  // Remove this entire forEach block as it's redundant with the for loop below

  for (const section of sections) {
    if (!section || typeof section !== 'object') {
      enrichmentLog.push({ section_key: null, updated_fields: [], notes: 'Skipped: section entry was not an object' })
      continue
    }
    const sectionKey = section.key
    if (typeof sectionKey !== 'string' || !sectionKey) {
      enrichmentLog.push({ section_key: null, updated_fields: [], notes: 'Skipped: section key missing or not a string' })
      continue
    }
    const data = section.data
    if (!data || typeof data !== 'object') {
      enrichmentLog.push({ section_key: sectionKey, updated_fields: [], notes: 'Skipped: section data missing or not an object' })
      continue
    }

    // Only accept fields the model was explicitly shown (keys present in existing section
    // or explicitly enumerated safe scalars). Never let the model mint new top-level keys
    // that did not already exist in the existing section OR were not in the original payload.
    const existingKeys = new Set(Object.keys(existingSections[sectionKey] ?? {}))
    const payloadSection = payload.sections.find((s) => s.key === sectionKey)
    const allowedKeys = new Set([
      ...existingKeys,
      ...Object.keys(payloadSection?.existing ?? {}),
    ])
    // Strip any key the model invented that we never provided
    const safeData = Object.fromEntries(
      Object.entries(data).filter(([k]) => allowedKeys.has(k)),
    )
    if (Object.keys(safeData).length === 0) {
      enrichmentLog.push({
        section_key: sectionKey,
        updated_fields: [],
        notes: 'AI returned only invented keys – skipped to prevent hallucination',
      })
      continue
    }
    const merged = mergeSection(existingSections[sectionKey], safeData)
    const guarded = await upsertEnrichedSection(db, profile.id, sectionKey, merged, {
      profile,
      sections: existingSections,
    })
    existingSections[sectionKey] = guarded.data
    updatedSections.push(sectionKey)
    enrichmentLog.push({
      section_key: sectionKey,
      updated_fields: Object.keys(data),
      notes: section.notes ?? null,
    })
  }

  const resultMeta = { sections: enrichmentLog, prompt: prompt || null }

  await db.prepare(
    `UPDATE crawler_jobs
     SET status = 'completed',
         completed_at = CURRENT_TIMESTAMP,
         result_count = ?,
         result_meta = ?,
         error = NULL
     WHERE id = ?`
  ).run(updatedSections.length, JSON.stringify(resultMeta), job.id)

  return {
    result_count: updatedSections.length,
    result_meta: resultMeta,
    updated_sections: updatedSections,
    notes: sections.map((section) => section?.notes).filter(Boolean),
    log: enrichmentLog,
  }
}
