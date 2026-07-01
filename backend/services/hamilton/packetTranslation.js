/**
 * packetTranslation.js
 *
 * Translates a Hamilton application packet into a profile's chosen language.
 *
 * Part of the GLOBAL bilingual-documents rule: every packet Hamilton generates
 * is saved in English AND, when the profile's `preferred_language` names a
 * non-English language, a translated copy in that language. See
 * hamiltonApplicationPacketGenerator.generateAndSavePacket.
 *
 * Translation is best-effort. The English packet is always saved first; if the
 * AI translation fails or times out, the translated copy is simply skipped and
 * the caller logs it — the applicant never loses their primary document.
 */

import { invokeJsonWithFallback, getOpenAIOptional } from '../../utils/aiProviders.js'

// English display name (used in the prompt) keyed by short code.
const LANGUAGE_DISPLAY_NAMES = {
  ru: 'Russian',
  es: 'Spanish',
  uk: 'Ukrainian',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  zh: 'Chinese (Simplified)',
  vi: 'Vietnamese',
  ar: 'Arabic',
  ko: 'Korean',
  tl: 'Tagalog',
  pl: 'Polish',
}

// Native label appended to the document NAME so English and translated copies
// are distinct rows in the profile's Documents list (and dedup keys).
const LANGUAGE_NATIVE_LABELS = {
  ru: 'Русский',
  es: 'Español',
  uk: 'Українська',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  zh: '中文',
  vi: 'Tiếng Việt',
  ar: 'العربية',
  ko: '한국어',
  tl: 'Tagalog',
  pl: 'Polski',
}

/**
 * Normalize a raw language value to a short code, or null when the value means
 * "English / no translation" (null, empty, 'en', 'english', 'eng').
 * @returns {string|null}
 */
export function normalizeLanguage(lang) {
  const raw = String(lang ?? '').trim().toLowerCase()
  if (!raw) return null
  // Accept 'ru', 'ru-RU', 'russian', etc.
  const code = raw.split(/[-_]/)[0]
  if (code === 'en' || code === 'eng' || raw === 'english') return null
  // Map a few full names to codes.
  const byName = {
    russian: 'ru', spanish: 'es', ukrainian: 'uk', french: 'fr', german: 'de',
    portuguese: 'pt', chinese: 'zh', vietnamese: 'vi', arabic: 'ar', korean: 'ko',
    tagalog: 'tl', filipino: 'tl', polish: 'pl',
  }
  if (byName[raw]) return byName[raw]
  return code
}

/** English display name for a language code (falls back to the code itself). */
export function languageDisplayName(code) {
  const c = normalizeLanguage(code)
  if (!c) return 'English'
  return LANGUAGE_DISPLAY_NAMES[c] || c
}

/** Native label for a language code, used in the document name suffix. */
export function languageNativeLabel(code) {
  const c = normalizeLanguage(code)
  if (!c) return ''
  return LANGUAGE_NATIVE_LABELS[c] || (LANGUAGE_DISPLAY_NAMES[c] || c)
}

function coerceSections(value, fallback) {
  if (!Array.isArray(value)) return fallback
  return value.map((s, i) => ({
    heading: typeof s?.heading === 'string' && s.heading.trim() ? s.heading : (fallback[i]?.heading ?? ''),
    body: typeof s?.body === 'string' ? s.body : (fallback[i]?.body ?? ''),
  }))
}

/**
 * Translate a packet's user-facing text into the target language.
 *
 * @param {{ title: string, sections: Array<{heading:string, body:string}>, instructions?: string[] }} packet
 * @param {string} targetLang - short code or language name (normalized internally)
 * @param {{ invoke?: Function, openai?: any }} [deps] - injectable for tests
 * @returns {Promise<{ title: string, sections: Array<{heading,body}>, instructions: string[] }>}
 * @throws when no language is set or translation fails (caller treats as skip)
 */
export async function translatePacketContent(packet, targetLang, deps = {}) {
  const code = normalizeLanguage(targetLang)
  if (!code) throw new Error('translatePacketContent: no non-English target language')

  const title = String(packet?.title ?? '')
  const sections = Array.isArray(packet?.sections) ? packet.sections : []
  const instructions = Array.isArray(packet?.instructions) ? packet.instructions : []

  const invoke = deps.invoke || invokeJsonWithFallback
  const openai = deps.openai !== undefined ? deps.openai : getOpenAIOptional()

  const languageName = languageDisplayName(code)
  const system =
    `You are a professional translator. Translate the JSON packet from English into ${languageName}. ` +
    `Return the SAME JSON shape and keys. Translate every human-readable string value. ` +
    `Do NOT translate or alter: text inside square brackets like [ MISSING — ... ] (keep verbatim), ` +
    `email addresses, URLs, phone numbers, monetary amounts, dates, and proper names of people/schools/organizations. ` +
    `Preserve line breaks and list structure. Return ONLY the JSON object.`

  const payload = {
    title,
    sections: sections.map((s) => ({ heading: String(s?.heading ?? ''), body: String(s?.body ?? '') })),
    instructions: instructions.map((l) => String(l ?? '')),
  }

  // Size the token budget to the input so long packets are not truncated.
  const approxInputChars = JSON.stringify(payload).length
  const maxTokens = Math.min(8000, Math.max(1500, Math.ceil(approxInputChars / 2)))

  const result = await invoke({
    openai,
    system,
    prompt: JSON.stringify(payload),
    temperature: 0.1,
    maxTokens,
  })

  if (!result?.ok || !result.json || typeof result.json !== 'object') {
    throw new Error(
      `translation failed (${result?.provider || 'none'}): ${result?.anthropicError || result?.openaiError || result?.error?.message || 'no output'}`,
    )
  }

  const json = result.json
  return {
    title: typeof json.title === 'string' && json.title.trim() ? json.title : title,
    sections: coerceSections(json.sections, payload.sections),
    instructions: Array.isArray(json.instructions)
      ? json.instructions.map((l, i) => (typeof l === 'string' ? l : payload.instructions[i] ?? ''))
      : payload.instructions,
  }
}

export const _internal = { LANGUAGE_DISPLAY_NAMES, LANGUAGE_NATIVE_LABELS, coerceSections }
