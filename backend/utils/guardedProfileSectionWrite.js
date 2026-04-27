import crypto from 'crypto'
import { safeParseJSON } from './safeJson.js'
import { createLogger } from './logger.js'
import { guardProfileSectionPayload } from './profileSuggestionGuards.js'

const log = createLogger('profile-section-guard')

function evidenceHash(value) {
  const raw = String(value || '')
  if (!raw) return null
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

export function logProfileSectionRejections(profileId, sectionKey, rejected = []) {
  for (const item of rejected) {
    log.warn('[profile-section-guard] rejected field', {
      profile_id: profileId,
      section_key: sectionKey,
      key: item.key,
      reason: item.reason,
      evidence_hash: evidenceHash(item.evidence),
    })
  }
}

export async function loadProfileSectionGuardContext(db, profileId) {
  let profile = { id: profileId }
  try {
    const row = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (row) profile = row
  } catch {
    // Some one-off scripts construct profile_sections before the full profile table is available.
  }

  let sections = {}
  try {
    const rows = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId)
    sections = Object.fromEntries((rows || []).map((row) => [row.section_key, safeParseJSON(row.data, {})]))
  } catch {
    sections = {}
  }

  return { profile, sections }
}

export async function guardProfileSectionForWrite(db, profileId, sectionKey, data, context = {}) {
  const loaded = context.profile && context.sections ? context : await loadProfileSectionGuardContext(db, profileId)
  const guarded = guardProfileSectionPayload(data, {
    profile: loaded.profile,
    sections: { ...(loaded.sections ?? {}), [sectionKey]: data },
    sectionKey,
    existing: loaded.sections?.[sectionKey] ?? {},
  })
  logProfileSectionRejections(profileId, sectionKey, guarded.rejected)
  return guarded
}
