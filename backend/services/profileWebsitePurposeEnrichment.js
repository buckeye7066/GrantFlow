import { resolveProfileWebsiteUrl, extractPurposeTermsFromText } from '../config/profileWebsitePurpose.js'
import { safeFetch, readTextCapped } from './http/safeFetch.js'

const MAX_BYTES = 256 * 1024
const CACHE_MS = 7 * 24 * 60 * 60 * 1000

function publicHttpUrl(raw) {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return url
  } catch {
    return null
  }
}

// Extract readable text from an HTML document for KEYWORD matching only — the
// result is tokenised for purpose terms, never rendered, so this is not an HTML
// sanitiser. It is still written defeat-resistant so it cannot be tricked into
// leaking raw markup into the token stream (and so CodeQL's js/bad-tag-filter
// is satisfied): comments are stripped FIRST (a `>` inside `<!-- a > b -->`
// would otherwise end a tag early), and the script/style block matchers
// terminate on their closing tag OR end-of-input, so an unterminated `<script>`
// cannot pass its contents through.
function visibleText(html) {
  return String(html || '')
    // HTML comments first — they may contain `>` that would break tag matching.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    // Script / style blocks, terminated by their close tag or the end of input.
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, ' ')
    .replace(/<style\b[\s\S]*?(?:<\/style\s*>|$)/gi, ' ')
    // Any remaining tag, including an unterminated trailing `<tag` at EOF.
    .replace(/<[^>]*(?:>|$)/g, ' ')
    .replace(/&(?:nbsp|amp|quot|#39);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20_000)
}

/** Bounded, cached website read used before a profile enters matching. */
export async function enrichProfileWebsitePurpose(db, {
  profile,
  sections,
  organization = null,
  fetchImpl,
  resolve,
  now = new Date(),
}) {
  const url = publicHttpUrl(resolveProfileWebsiteUrl({ profile, sections, organization }))
  if (!url) return { status: 'skipped' }
  const cached = sections?.website_purpose || {}
  const checkedAt = Date.parse(cached.checked_at || '')
  if (Number.isFinite(checkedAt) && now.getTime() - checkedAt < CACHE_MS) return { status: 'cached', data: cached }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  let data
  try {
    // Profile URLs are user-controlled. The shared egress choke point resolves
    // every hostname, rejects private/mixed answers, pins the validated socket,
    // and repeats that policy for every redirect before connecting.
    const response = await safeFetch(url.toString(), {
      signal: controller.signal,
      headers: { accept: 'text/html,application/xhtml+xml' },
    }, { fetchImpl, resolve, maxRedirects: 3, timeoutMs: 2500 })
    const type = String(response.headers?.get?.('content-type') || '')
    if (!response.ok || !type.includes('text/html')) return { status: 'unreadable' }
    const length = Number(response.headers?.get?.('content-length') || 0)
    if (length > MAX_BYTES) return { status: 'too_large' }
    const text = visibleText(await readTextCapped(response, MAX_BYTES))
    data = { url: response.grantflowFinalUrl || url.toString(), excerpt: text, terms: extractPurposeTermsFromText(text), checked_at: now.toISOString() }
    await db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, 'website_purpose', ?, 'website_purpose_reader')
      ON CONFLICT(profile_id, section_key) DO UPDATE SET data = excluded.data,
      updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by`).run(profile.id, JSON.stringify(data))
    sections.website_purpose = data
    return { status: 'fetched', data }
  } catch {
    return { status: 'unreadable' }
  } finally {
    clearTimeout(timer)
  }
}
