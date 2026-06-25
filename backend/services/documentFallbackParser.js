import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js'
import { createLogger } from '../utils/logger.js'
const qualityLog = createLogger('services:documentFallbackParser')

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function findMoneyAmounts(text) {
  const t = String(text || '')
  const matches = []
  const re = /\$[\s]*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/g
  let m
  while ((m = re.exec(t))) {
    const raw = m[0]
    const num = Number(String(m[1]).replace(/,/g, ''))
    if (Number.isFinite(num)) matches.push({ raw, value: num })
    if (matches.length >= 10) break
  }
  return matches
}

function detectDecision(text) {
  const t = normalizeText(text)
  if (!t) return null

  if (t.includes('waitlist') || t.includes('wait-listed') || t.includes('wait listed')) return 'waitlisted'
  if (t.includes('defer') || t.includes('deferred')) return 'deferred'
  if (t.includes('deny') || t.includes('not admitted') || t.includes('we regret') || t.includes('unable to offer')) return 'denied'
  if (
    t.includes('congratulations') ||
    t.includes('pleased to offer you admission') ||
    t.includes('offer you admission') ||
    t.includes('admitted') ||
    t.includes('accepted')
  )
    return 'accepted'

  return null
}

function detectScholarshipAmount(text) {
  const t = normalizeText(text)
  const amounts = findMoneyAmounts(text)
  if (amounts.length === 0) return null

  // Prefer amounts near “scholarship/award/grant”
  const keywords = ['scholarship', 'award', 'grant', 'merit', 'tuition']
  for (const amt of amounts) {
    const idx = t.indexOf(String(amt.raw).toLowerCase().replace(/\s+/g, ' '))
    if (idx === -1) continue
    const window = t.slice(Math.max(0, idx - 80), Math.min(t.length, idx + 80))
    if (keywords.some((k) => window.includes(k))) {
      return amt
    }
  }

  // Fallback: largest amount (often scholarship/award), flagged as low-confidence.
  const sorted = amounts.slice().sort((a, b) => b.value - a.value)
  if (!sorted[0]) return null
  return { ...sorted[0], lowConfidence: true }
}

export function buildFallbackDocumentSummary({ document, extractedText }) {
  const decision = detectDecision(extractedText)
  const scholarship = detectScholarshipAmount(extractedText)

  const parts = []
  if (document?.university_application_name) {
    parts.push(`School: ${document.university_application_name}`)
  }
  if (decision) {
    parts.push(`Decision: ${decision}`)
  }
  if (scholarship) {
    parts.push(`Possible award: ${scholarship.raw}`)
  }
  if (parts.length === 0) {
    return 'Parsed locally (AI unavailable). No structured fields detected.'
  }
  return `Parsed locally (AI unavailable). ${parts.join(' • ')}`
}

export async function applyFallbackUniversityUpdates({ db, profileId, document, extractedText }) {
  const applicationId = document?.university_application_id
  if (!profileId || !applicationId) return { updated: false, updated_fields: [] }

  const row = await db
    .prepare(
      `
        SELECT data
        FROM profile_sections
        WHERE profile_id = ?
          AND section_key = 'university_applications'
        LIMIT 1
      `,
    )
    .get(profileId)

  if (!row?.data) return { updated: false, updated_fields: [] }

  let parsed
  try {
    parsed = JSON.parse(row.data)
  } catch (parseErr) {
    qualityLog.error(
      '[documentFallbackParser] Failed to parse university_applications JSON',
      { profileId, applicationId, error: String(parseErr) }
    )
    return { updated: false, updated_fields: [] }
  }

  const apps = Array.isArray(parsed?.applications) ? parsed.applications : []
  const idx = apps.findIndex((a) => String(a?.id) === String(applicationId))
  if (idx === -1) return { updated: false, updated_fields: [] }

  const app = { ...(apps[idx] || {}) }
  const updatedFields = new Set()

  const decision = detectDecision(extractedText)
  if (decision && app.status !== decision) {
    app.status = decision
    updatedFields.add('status')
  }

  const scholarship = detectScholarshipAmount(extractedText)
  if (scholarship) {
    // Add/complete a pipeline stage if present.
    const pipeline = Array.isArray(app.financial_aid_pipeline) ? app.financial_aid_pipeline.slice() : []
    const label = 'Scholarship letter received'
    const existingStageIndex = pipeline.findIndex((s) => String(s?.label || '').toLowerCase() === label.toLowerCase())
    const now = new Date().toISOString().slice(0, 10)
    const confidenceNote = scholarship.lowConfidence
      ? `Possible award amount (low confidence â no keyword context): ${scholarship.raw}`
      : `Detected award amount: ${scholarship.raw}`
    const nextStage =
      existingStageIndex === -1
        ? {
            id: `stage_${Math.random().toString(36).slice(2, 10)}`,
            label,
            status: scholarship.lowConfidence ? 'needs_review' : 'completed',
            due_date: null,
            completed_at: scholarship.lowConfidence ? null : now,
            notes: confidenceNote,
          }
        : {
            ...pipeline[existingStageIndex],
            status: scholarship.lowConfidence
              ? pipeline[existingStageIndex]?.status || 'needs_review'
              : 'completed',
            completed_at: scholarship.lowConfidence
              ? pipeline[existingStageIndex]?.completed_at || null
              : pipeline[existingStageIndex]?.completed_at || now,
            notes:
              pipeline[existingStageIndex]?.notes ||
              confidenceNote,
          }

    if (existingStageIndex === -1) pipeline.push(nextStage)
    else pipeline.splice(existingStageIndex, 1, nextStage)

    app.financial_aid_pipeline = pipeline
    updatedFields.add('financial_aid_pipeline')
  }

  if (updatedFields.size === 0) return { updated: false, updated_fields: [] }

  const nextApps = apps.slice()
  nextApps.splice(idx, 1, app)
  const nextPayload = { ...(parsed || {}), applications: nextApps }

  const guarded = await guardProfileSectionForWrite(db, profileId, 'university_applications', nextPayload)
  await db
    .prepare(
      `
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, 'university_applications', ?, ?)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = excluded.updated_by
    `,
    )
    .run(profileId, JSON.stringify(guarded.data), `document:${document?.id ?? 'unknown'}`)

  return { updated: true, updated_fields: Array.from(updatedFields) }
}

