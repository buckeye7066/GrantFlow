import { createLogger } from '../utils/logger.js'
const qualityLog = createLogger('services:universityDocumentClassifier')
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenizeName(name) {
  const stop = new Set([
    'the',
    'of',
    'and',
    'at',
    'for',
    'in',
    'on',
    'university',
    'college',
    'school',
    'institute',
    'state',
    'campus',
    'department',
    'program',
  ])
  return normalizeText(name)
    .split(' ')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !stop.has(t))
}

function scoreSchoolMatch({ schoolName, haystack }) {
  const school = normalizeText(schoolName)
  const text = normalizeText(haystack)
  if (!school || !text) return { score: 0, reason: 'no_text' }

  // Strong signal: exact substring match on the full school name.
  if (text.includes(school)) {
    return { score: 100, reason: 'exact_name_substring' }
  }

  const tokens = tokenizeName(schoolName)
  if (tokens.length === 0) return { score: 0, reason: 'no_tokens' }

  let matched = 0
  for (const token of tokens) {
    if (text.includes(token)) matched += 1
  }

  const ratio = matched / tokens.length
  const score = Math.round(ratio * 85) // leave headroom for exact matches
  return { score, reason: `token_overlap:${matched}/${tokens.length}` }
}

export async function loadUniversityApplicationsForProfile(db, profileId) {
  if (!profileId) return []
  try {
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
      // Profile IDs are hex strings (lower(hex(randomblob(16)))) — they contain
      // a–f, so the old `.replace(/[^0-9]/g, '')` mangled the id and the lookup
      // never matched. Use the id verbatim (trimmed).
      .get(String(profileId).trim())
    if (!row?.data) return []
    try {
      const parsed = JSON.parse(row.data)
      const apps = Array.isArray(parsed?.applications) ? parsed.applications : []
      return apps
        .map((app) => ({
          id: app?.id ?? null,
          name: app?.name ?? '',
        }))
        .filter((a) => a.id && a.name)
    } catch (error) {
      qualityLog.error('Failed to parse university applications data:', error)
      return []
    }
  } catch (error) {
    qualityLog.error(
      'Failed to load university applications for profile from database:',
      error,
    )
    return []
  }
}

export function classifyUniversityApplicationForDocument({
  applications,
  documentName,
  extractedText,
}) {
  const haystack = `${documentName || ''}\n\n${extractedText || ''}`
  const scored = (applications || [])
    .map((app) => {
      const { score, reason } = scoreSchoolMatch({ schoolName: app.name, haystack })
      return { ...app, score, reason }
    })
    .sort((a, b) => b.score - a.score)

  const best = scored[0] ?? null
  const second = scored[1] ?? null

  if (!best) return null

  // Thresholds: require a meaningful match and avoid ambiguous ties.
  if (best.score < 70) return null
  if (second && second.score >= 70 && best.score - second.score < 10) return null

  return {
    id: best.id,
    name: best.name,
    score: best.score,
    reason: best.reason,
  }
}

