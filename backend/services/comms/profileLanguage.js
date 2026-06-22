/**
 * profileLanguage.js — resolve a profile's preferred language for OUTBOUND comms.
 *
 * The frontend LanguageProvider persists the user's choice to the backend via
 * PUT /api/profiles/:id/preferred-language, which stores it in the
 * `profile_sections` table under section_key = 'language_preferences' as JSON
 * { preferred_language: 'es' } (see backend/routes/profiles.js). This is the
 * single source of truth for a profile's language.
 *
 * This helper reads that stored preference and normalizes it to one of the nine
 * supported ISO codes, defaulting to English ('en') whenever it's missing,
 * unparseable, or unsupported. It NEVER throws — comms must degrade to English,
 * not fail.
 */

import { normalizeLanguageCode, DEFAULT_LANGUAGE } from '../../../shared/languages.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('profile-language')

function safeParseJSON(raw, fallback = {}) {
  if (raw === null || raw === undefined) return fallback
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return fallback }
}

/**
 * Resolve the stored preferred language for a profile.
 * @returns {Promise<string>} one of the 9 supported codes; 'en' when unknown.
 */
export async function getProfileLanguage(db, profileId) {
  if (!db || !profileId) return DEFAULT_LANGUAGE
  try {
    const row = await db
      .prepare(
        `SELECT data FROM profile_sections
           WHERE profile_id = ? AND section_key = 'language_preferences' LIMIT 1`,
      )
      .get(String(profileId))
    if (!row) return DEFAULT_LANGUAGE
    const data = safeParseJSON(row.data, {})
    return normalizeLanguageCode(data?.preferred_language)
  } catch (err) {
    // Table/row absent or query error — default to English, but log so the owner
    // can tell a profile's language couldn't be read.
    log.warn('getProfileLanguage failed (defaulting to en)', { error: err?.message })
    return DEFAULT_LANGUAGE
  }
}

/**
 * Resolve the preferred language for a USER (not a profile). Deadline alerts are
 * keyed on the user; we look at any of the user's profiles that has a stored
 * language and take the first one. Defaults to 'en'. Best-effort, never throws.
 *
 * @param {object} db
 * @param {string} userId
 * @returns {Promise<string>}
 */
export async function getUserLanguage(db, userId) {
  if (!db || !userId) return DEFAULT_LANGUAGE
  try {
    const row = await db
      .prepare(
        `SELECT ps.data AS data
           FROM profiles p
           JOIN profile_sections ps
             ON ps.profile_id = p.id AND ps.section_key = 'language_preferences'
          WHERE p.user_id = ?
          LIMIT 1`,
      )
      .get(String(userId))
    if (!row) return DEFAULT_LANGUAGE
    const data = safeParseJSON(row.data, {})
    return normalizeLanguageCode(data?.preferred_language)
  } catch (err) {
    log.warn('getUserLanguage failed (defaulting to en)', { error: err?.message })
    return DEFAULT_LANGUAGE
  }
}
