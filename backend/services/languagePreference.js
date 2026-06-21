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
  SUPPORTED_LANGUAGE_CODES,
  normalizeLanguageCode,
  isSupportedLanguage,
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

/**
 * Read-only scan that makes the per-profile `preferred_language` setting
 * OBSERVABLE to the agents — the same shape the Hamilton session-readiness
 * scan uses so it slots straight into Anya (a tool she can call) and Sam (which
 * mines `findings[]` into Mission Control diagnostics).
 *
 * What it surfaces:
 *   - how many scanned profiles set an explicit, non-default language, and the
 *     per-language distribution, so the choice is visible system-wide;
 *   - a LOW finding for any profile whose stored `preferred_language` is a
 *     non-empty but UNSUPPORTED code — those silently fall back to English, so
 *     the user picked a language and is still being answered in English. That's
 *     a real (otherwise invisible) data-integrity bug worth catching.
 *
 * Best-effort and never throws: a missing table / bad JSON resolves to an
 * "all clear" result so Sam's status endpoint always responds.
 *
 * @param {object} db
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{ok:boolean, summary:string, profiles_scanned:number,
 *   explicit_non_default:number, by_language:Record<string,number>,
 *   findings:Array<object>}>}
 */
export async function scanProfileLanguageReadiness(db, { limit = 1000 } = {}) {
  const empty = {
    ok: true,
    summary: 'No profiles to scan.',
    profiles_scanned: 0,
    explicit_non_default: 0,
    by_language: {},
    findings: [],
  }
  if (!db) return { ...empty, ok: false, summary: 'no db' }

  let rows = []
  try {
    rows = await db
      .prepare(
        `SELECT p.id, p.display_name, ps.data
           FROM profiles p
           LEFT JOIN profile_sections ps
             ON ps.profile_id = p.id AND ps.section_key = ?
          WHERE p.status IS NULL OR p.status <> 'deleted'
          ORDER BY p.updated_at DESC
          LIMIT ?`,
      )
      .all(LANGUAGE_SECTION_KEY, Math.max(1, Math.min(Number(limit) || 1000, 5000)))
    if (!Array.isArray(rows)) rows = []
  } catch {
    // profiles / profile_sections absent on a bare db → nothing to scan.
    return empty
  }

  const byLanguage = {}
  const findings = []
  let explicitNonDefault = 0

  for (const row of rows) {
    if (!row?.data) continue
    let raw = null
    try {
      raw = JSON.parse(row.data)?.preferred_language
    } catch {
      continue
    }
    if (raw === null || raw === undefined || String(raw).trim() === '') continue

    const stored = String(raw).trim()
    if (!isSupportedLanguage(stored)) {
      // The user picked a language we no longer (or never) supported. It
      // silently degrades to English — surface it so it can be corrected.
      findings.push({
        severity: 'low',
        category: 'profile_language',
        title: `Unsupported language code stored: "${stored}"`,
        description: `Profile ${row.id} stored preferred_language="${stored}", which is not in SUPPORTED_LANGUAGE_CODES (${SUPPORTED_LANGUAGE_CODES.join(', ')}). It is being answered in English instead of the chosen language.`,
        evidence: { profile_id: row.id, stored_value: stored },
        recommended_fix: `Re-set the language via PUT /api/profiles/${row.id}/preferred-language with a supported code, or clear the language_preferences section.`,
        confidence: 0.95,
      })
      continue
    }

    const code = normalizeLanguageCode(stored)
    byLanguage[code] = (byLanguage[code] || 0) + 1
    if (code !== DEFAULT_LANGUAGE) explicitNonDefault += 1
  }

  const summaryParts = []
  if (explicitNonDefault > 0) {
    summaryParts.push(
      `${explicitNonDefault} profile(s) set a non-English language (${Object.entries(byLanguage)
        .filter(([code]) => code !== DEFAULT_LANGUAGE)
        .map(([code, n]) => `${languageEnglishName(code)}:${n}`)
        .join(', ') || 'none'})`,
    )
  }
  if (findings.length > 0) {
    summaryParts.push(`${findings.length} profile(s) have an unsupported language code (degrading to English)`)
  }

  return {
    ok: true,
    summary: summaryParts.length
      ? summaryParts.join('; ') + '.'
      : `Scanned ${rows.length} profile(s); all stored language preferences are valid.`,
    profiles_scanned: rows.length,
    explicit_non_default: explicitNonDefault,
    by_language: byLanguage,
    findings,
  }
}
