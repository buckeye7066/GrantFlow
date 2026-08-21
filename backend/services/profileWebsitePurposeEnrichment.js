import { resolveProfileWebsiteUrl, extractPurposeTermsFromText } from '../config/profileWebsitePurpose.js'

const MAX_BYTES = 256 * 1024
const CACHE_MS = 7 * 24 * 60 * 60 * 1000

function publicHttpUrl(raw) {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null
    if (/^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(host)) return null
    return url
  } catch {
    return null
  }
}

function visibleText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|quot|#39);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20_000)
}

/** Bounded, cached website read used before a profile enters matching. */
export async function enrichProfileWebsitePurpose(db, { profile, sections, fetchImpl = globalThis.fetch, now = new Date() }) {
  const url = publicHttpUrl(resolveProfileWebsiteUrl({ profile, sections }))
  if (!url || typeof fetchImpl !== 'function') return { status: 'skipped' }
  const cached = sections?.website_purpose || {}
  const checkedAt = Date.parse(cached.checked_at || '')
  if (Number.isFinite(checkedAt) && now.getTime() - checkedAt < CACHE_MS) return { status: 'cached', data: cached }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  let data
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'text/html,application/xhtml+xml' },
    })
    const type = String(response.headers?.get?.('content-type') || '')
    if (!response.ok || !type.includes('text/html')) return { status: 'unreadable' }
    const length = Number(response.headers?.get?.('content-length') || 0)
    if (length > MAX_BYTES) return { status: 'too_large' }
    const text = visibleText((await response.text()).slice(0, MAX_BYTES))
    data = { url: url.toString(), excerpt: text, terms: extractPurposeTermsFromText(text), checked_at: now.toISOString() }
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

