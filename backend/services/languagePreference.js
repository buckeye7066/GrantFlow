/**
 * languagePreference.js — backend helpers for the user's preferred language.
 *
 * The choice is the VERY FIRST thing Anya asks during onboarding. It is stored
 * at the profile level in the `language_preferences` profile_sections row:
 *   { preferred_language: 'es' }
 *
 * These helpers let every user-facing AI prompt (Anya chat, proposal drafting,
 * summaries, the portal-login suggester's user-facing text, etc.) pull the
 * preferred language and emit a strong "respond ONLY in <language>" directive so
 * the whole experience runs in the user's chosen language. English is the
 * behaviour-preserving default — when nothing is stored, prompts get no extra
 * directive and continue to respond in English exactly as before.
 */

import {
  DEFAULT_LANGUAGE,
  normalizeLanguageCode,
  languageEnglishName,
} from '../../shared/languages.js'

export const LANGUAGE_SECTION_KEY = 'language_preferences'

/**
 * Read the preferred language code for a profile from its
 * `language_preferences` section. Best-effort and never throws — any failure
 * (no db, missing table/row, bad JSON) resolves to English so the default path
 * is never broken.
 *
 * @param {object} db    a prepared-statement-capable db handle
 * @param {string} profileId
 * @returns {string} an ISO code from SUPPORTED_LANGUAGE_CODES (default 'en')
 */
export function getProfilePreferredLanguage(db, profileId) {
  if (!db || !profileId) return DEFAULT_LANGUAGE
  try {
    const row = db
      .prepare(
        `SELECT data FROM profile_sections
         WHERE profile_id = ? AND section_key = ? LIMIT 1`,
      )
      .get(profileId, LANGUAGE_SECTION_KEY)
    if (!row || !row.data) return DEFAULT_LANGUAGE
    const parsed = JSON.parse(row.data)
    return normalizeLanguageCode(parsed?.preferred_language)
  } catch {
    return DEFAULT_LANGUAGE
  }
}

/**
 * Async sibling of {@link getProfilePreferredLanguage} for call sites whose db
 * adapter returns a Promise from `.get()` (the Postgres path). Awaits the row
 * before parsing. Best-effort — defaults to English on any failure.
 */
export async function getProfilePreferredLanguageAsync(db, profileId) {
  if (!db || !profileId) return DEFAULT_LANGUAGE
  try {
    const row = await db
      .prepare(
        `SELECT data FROM profile_sections
         WHERE profile_id = ? AND section_key = ? LIMIT 1`,
      )
      .get(profileId, LANGUAGE_SECTION_KEY)
    if (!row || !row.data) return DEFAULT_LANGUAGE
    const parsed = JSON.parse(row.data)
    return normalizeLanguageCode(parsed?.preferred_language)
  } catch {
    return DEFAULT_LANGUAGE
  }
}

/** Async sibling of {@link buildLanguageDirectiveForProfile}. */
export async function buildLanguageDirectiveForProfileAsync(db, profileId) {
  return buildLanguageDirective(await getProfilePreferredLanguageAsync(db, profileId))
}

/**
 * Build the language directive block to append to an AI system/user prompt.
 * Returns an empty string for English (default path stays byte-for-byte the
 * same), and a strong, unambiguous instruction otherwise.
 *
 * @param {string} code an ISO code (will be normalized)
 * @returns {string}
 */
export function buildLanguageDirective(code) {
  const normalized = normalizeLanguageCode(code)
  if (normalized === DEFAULT_LANGUAGE) return ''
  const name = languageEnglishName(normalized)
  return [
    '',
    `## Language`,
    `The user's preferred language is ${name} (${normalized}).`,
    `Respond ONLY in ${name}. Write every word the user will read — greetings,`,
    `explanations, questions, button-like suggestions, and summaries — in ${name}.`,
    `Keep proper nouns, organization names, URLs, and code identifiers as-is.`,
    `Do not switch back to English unless the user explicitly asks you to.`,
    '',
  ].join('\n')
}

/**
 * Convenience: resolve a profile's language then build the directive in one call.
 */
export function buildLanguageDirectiveForProfile(db, profileId) {
  return buildLanguageDirective(getProfilePreferredLanguage(db, profileId))
}
