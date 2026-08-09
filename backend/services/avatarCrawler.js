import fs from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { summarizeOpenAIError } from '../utils/openaiClient.js'
import { assertSsrfSafeUrl } from '../config/urlRules.js'
import * as cheerio from 'cheerio'

const fetchImpl = globalThis.fetch
const FETCH_TIMEOUT_MS = 12_000
const MAX_REDIRECTS = 4
const USER_AGENT = 'GrantFlow Avatar Lookup/1.0'

/**
 * Map assertSsrfSafeUrl refusals onto the avatar crawler's stable reason vocab
 * so callers/tests that key on `blocked_private_host` keep working.
 */
function mapSsrfReason(reason) {
  const r = String(reason || '')
  if (
    r.startsWith('private_ip:') ||
    r.startsWith('resolves_private:') ||
    r.startsWith('blocked_host:')
  ) {
    return 'blocked_private_host'
  }
  if (r === 'unparseable_url' || r === 'empty_url') return 'invalid_url'
  if (r.startsWith('blocked_scheme:')) return 'blocked_redirect_scheme'
  return r || 'blocked_private_host'
}

/**
 * Per-hop SSRF check. Hostname-string checks alone are not enough: a public
 * DNS name whose A/AAAA record is 169.254.169.254 / 10.x / etc. must also be
 * refused. Delegates to the shared assertSsrfSafeUrl (DNS-resolving) chokepoint
 * used by httpClient / Yana / linkVerification. `allowLocalhost` only exempts
 * loopback for tests — never RFC1918 / link-local / metadata.
 */
async function assertAvatarHopSafe(url, { allowLocalhost = false, assertSafeUrl } = {}) {
  let host
  try {
    host = new URL(url).hostname
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  if (allowLocalhost && isLoopbackHostname(host)) {
    return { ok: true }
  }
  const check = typeof assertSafeUrl === 'function' ? assertSafeUrl : assertSsrfSafeUrl
  const verdict = await check(url)
  if (!verdict?.ok) {
    return { ok: false, reason: mapSsrfReason(verdict?.reason) }
  }
  return { ok: true }
}

export function normalizeHttpUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase()
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  if (h === '127.0.0.1') return true
  return false
}

function resolveUrl(baseUrl, maybeRelative) {
  const raw = String(maybeRelative ?? '').trim()
  if (!raw) return null
  try {
    return new URL(raw, baseUrl).toString()
  } catch {
    return null
  }
}

async function fetchOnce(url, accept) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetchImpl(url, {
      method: 'GET',
      // Manual redirects so every hop can be re-validated (validate-then-follow
      // with redirect:'follow' lets a public first hop 302 into link-local /
      // metadata IPs inside undici where the hostname guard never runs).
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
      },
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * SSRF-safe fetch: re-check EVERY hop (scheme + hostname + DNS→private) and
 * never auto-follow redirects. Returns { ok, res, finalUrl } or { ok:false, reason }.
 *
 * The 0563eb97 fix closed validate-then-follow into literal private IPs, but
 * still only inspected the hostname string. A public name whose DNS resolves
 * to link-local/metadata bypassed that guard — this path now uses the same
 * DNS-resolving assertSsrfSafeUrl chokepoint as the rest of the SSRF wave.
 */
export async function safeAvatarFetch(startUrl, accept, {
  allowLocalhost = false,
  assertSafeUrl = null,
} = {}) {
  let current = startUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const hopCheck = await assertAvatarHopSafe(current, { allowLocalhost, assertSafeUrl })
    if (!hopCheck.ok) return hopCheck
    let res
    try {
      res = await fetchOnce(current, accept)
    } catch {
      return { ok: false, reason: 'fetch_failed' }
    }
    const status = res.status
    if (status >= 300 && status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return { ok: true, res, finalUrl: current }
      const next = resolveUrl(current, loc)
      if (!next) return { ok: false, reason: 'invalid_redirect' }
      if (!/^https?:\/\//i.test(next)) return { ok: false, reason: 'blocked_redirect_scheme' }
      current = next
      continue
    }
    return { ok: true, res, finalUrl: current }
  }
  return { ok: false, reason: 'too_many_redirects' }
}

function pickWebsiteImageCandidate(html, baseUrl) {
  if (!html) return null
  const $ = cheerio.load(html)

  const coverCandidates = [
    $('meta[property="og:image"]').attr('content'),
    $('meta[property="og:image:url"]').attr('content'),
    $('meta[name="twitter:image"]').attr('content'),
    $('meta[name="twitter:image:src"]').attr('content'),
    $('link[rel="image_src"]').attr('href'),
  ]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)

  for (const candidate of coverCandidates) {
    const resolved = resolveUrl(baseUrl, candidate)
    if (resolved) return { url: resolved, method: 'website_cover' }
  }

  // Fallback: large body images (logos, hero images, profile photos)
  // Look for <img> elements with explicit size hints that suggest a meaningful image.
  const bodyImages = []
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src')
    if (!src) return
    const w = parseInt($(el).attr('width') || '0', 10)
    const h = parseInt($(el).attr('height') || '0', 10)
    const alt = String($(el).attr('alt') || '').toLowerCase()
    const cls = String($(el).attr('class') || '').toLowerCase()
    // Prefer images that look like logos, headshots, or hero images
    const isLikelyAvatar = /logo|brand|header|hero|portrait|headshot|photo|avatar|profile/i.test(alt + ' ' + cls + ' ' + src)
    // Skip tiny tracking pixels and spacer images
    if (w > 0 && w < 48 && h > 0 && h < 48) return
    const resolved = resolveUrl(baseUrl, src)
    if (resolved) bodyImages.push({ url: resolved, isLikelyAvatar, w, h })
  })
  // Sort: prefer likely avatars first, then by size (larger is better)
  bodyImages.sort((a, b) => {
    if (a.isLikelyAvatar !== b.isLikelyAvatar) return a.isLikelyAvatar ? -1 : 1
    return (b.w * b.h) - (a.w * a.h)
  })
  if (bodyImages.length > 0) {
    return { url: bodyImages[0].url, method: 'website_body_image' }
  }

  // Fallback: icon links (logos / favicons)
  const iconCandidates = [
    $('link[rel="apple-touch-icon"]').attr('href'),
    $('link[rel="apple-touch-icon-precomposed"]').attr('href'),
    $('link[rel="icon"]').attr('href'),
    $('link[rel="shortcut icon"]').attr('href'),
    $('link[rel="mask-icon"]').attr('href'),
  ]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)

  for (const candidate of iconCandidates) {
    const resolved = resolveUrl(baseUrl, candidate)
    if (resolved) return { url: resolved, method: 'website_icon' }
  }

  // Last resort: common favicon location
  const originFavicon = resolveUrl(baseUrl, '/favicon.ico')
  if (originFavicon) return { url: originFavicon, method: 'website_icon' }

  return null
}

function extensionFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('image/png')) return 'png'
  if (ct.includes('image/webp')) return 'webp'
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return 'jpg'
  if (ct.includes('image/gif')) return 'gif'
  return 'jpg'
}

async function tryDownloadDirectUrl(imageUrl, uploadDir) {
  const url = normalizeHttpUrl(imageUrl)
  if (!url) return { ok: false, reason: 'invalid_url' }

  if (!fetchImpl) return { ok: false, reason: 'fetch_unavailable' }

  const fetched = await safeAvatarFetch(url, 'image/*,*/*;q=0.8', { allowLocalhost: false })
  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason === 'blocked_private_host' ? 'blocked_private_host' : 'fetch_failed',
    }
  }
  const res = fetched.res
  if (!res || !res.ok) return { ok: false, reason: 'fetch_failed' }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase()
  if (!contentType.startsWith('image/')) return { ok: false, reason: 'not_image' }

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 10 * 1024 * 1024) return { ok: false, reason: 'too_large' }
  if (buf.length < 100) return { ok: false, reason: 'too_small' }

  const ext = extensionFromContentType(contentType)
  const filename = `${Date.now()}-${randomUUID()}.${ext}`
  const filePath = join(uploadDir, filename)
  fs.writeFileSync(filePath, buf)

  return {
    ok: true,
    avatarFilename: filename,
    avatarUrl: `/uploads/${filename}`,
    // Durable persistence: Railway's /uploads disk is EPHEMERAL — the caller
    // (crawlerDispatcher) must store these bytes to profiles.avatar_data or
    // the logo silently vanishes on the next redeploy.
    avatarBuffer: buf,
    avatarContentType: contentType,
  }
}

export function extractProfileWebsite(profileContext) {
  const sections = profileContext?.sections ?? {}
  const candidates = [
    profileContext?.website_hint,
    sections.basic_information?.website,
    sections.organization_details?.website,
    profileContext?.profile?.website,
    profileContext?.organization?.website,
  ]

  for (const raw of candidates) {
    const normalized = normalizeHttpUrl(raw)
    if (normalized) return normalized
  }

  const contactInfo = profileContext?.organization?.contact_info
  if (contactInfo) {
    let parsed = contactInfo
    if (typeof contactInfo === 'string') {
      try {
        parsed = JSON.parse(contactInfo)
      } catch {
        parsed = null
      }
    }
    const fromContact = normalizeHttpUrl(parsed?.website)
    if (fromContact) return fromContact
  }

  return null
}

async function tryUseWebsiteCoverPhoto({ profileContext, uploadDir }) {
  const website = extractProfileWebsite(profileContext)
  if (!website) {
    return { ok: false, reason: 'no_website' }
  }

  // SSRF guard (allow localhost only in tests). Explicit false still wins.
  const allowLocalhost = process.env.NODE_ENV === 'test'

  if (!fetchImpl) {
    return { ok: false, reason: 'fetch_unavailable' }
  }

  const fetched = await safeAvatarFetch(website, 'text/html,application/xhtml+xml', {
    allowLocalhost,
  })
  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason === 'blocked_private_host' ? 'blocked_private_host' : 'website_fetch_failed',
    }
  }
  const res = fetched.res
  const finalUrl = fetched.finalUrl || website
  if (!res || !res.ok) {
    return { ok: false, reason: 'website_fetch_failed' }
  }

  const html = await res.text().catch(() => '')
  const pick = pickWebsiteImageCandidate(html, finalUrl)
  if (!pick?.url) {
    return { ok: false, reason: 'no_cover_meta' }
  }
  const coverUrl = pick.url
  const method = pick.method || 'website_cover'

  // Cover URLs are page-derived (untrusted). Re-run the DNS-resolving hop
  // check before the image fetch so a meta tag pointing at a public name
  // that resolves to metadata cannot skip the guard.
  const coverHop = await assertAvatarHopSafe(coverUrl, { allowLocalhost })
  if (!coverHop.ok) {
    return {
      ok: false,
      reason: coverHop.reason === 'blocked_private_host'
        ? 'blocked_private_cover_host'
        : coverHop.reason,
    }
  }

  const imgFetched = await safeAvatarFetch(coverUrl, 'image/*,*/*;q=0.8', { allowLocalhost })
  if (!imgFetched.ok) {
    return {
      ok: false,
      reason:
        imgFetched.reason === 'blocked_private_host'
          ? 'blocked_private_cover_host'
          : 'cover_fetch_failed',
    }
  }
  const imgRes = imgFetched.res
  if (!imgRes || !imgRes.ok) {
    return { ok: false, reason: 'cover_fetch_failed' }
  }

  const imgType = String(imgRes.headers.get('content-type') || '').toLowerCase()
  if (!imgType.startsWith('image/') && !imgType.includes('icon')) {
    return { ok: false, reason: 'cover_not_image' }
  }

  const buf = Buffer.from(await imgRes.arrayBuffer())
  // Safety cap: 10MB
  if (buf.length > 10 * 1024 * 1024) {
    return { ok: false, reason: 'cover_too_large' }
  }

  const ext = extensionFromContentType(imgType)
  const filename = `${Date.now()}-${randomUUID()}.${ext}`
  const filePath = join(uploadDir, filename)
  fs.writeFileSync(filePath, buf)

  return {
    ok: true,
    avatarFilename: filename,
    avatarUrl: `/uploads/${filename}`,
    // Durable persistence (ephemeral-disk trap) — see tryDownloadDirectUrl.
    avatarBuffer: buf,
    avatarContentType: imgType,
    coverUrl,
    website: finalUrl,
    method,
  }
}

export async function processAvatarLookupJob({ profileContext, uploadDir, getOpenAI, job }) {
  const websiteHint = job?.parameters?.website_hint ?? null
  const effectiveContext = websiteHint
    ? { ...profileContext, website_hint: websiteHint }
    : profileContext

  const profile = effectiveContext?.profile
  if (!profile) {
    // Never fail the job: avatar lookup is a cosmetic enhancement.
    return {
      inserted: 0,
      result_count: 0,
      result_meta: {
        ok: false,
        reason: 'missing_profile_context',
        message: 'Avatar generation skipped (missing profile context).',
      },
    }
  }

  // Step 1: If the profile already has an external avatar URL (not a local /uploads/ path),
  // try to download it directly. This handles OAuth profile photos, manually entered URLs, etc.
  try {
    const existingUrl = profile.avatar_url ? String(profile.avatar_url).trim() : ''
    if (existingUrl && /^https?:\/\//i.test(existingUrl) && !existingUrl.includes('/uploads/')) {
      const directResult = await tryDownloadDirectUrl(existingUrl, uploadDir)
      if (directResult?.ok && directResult.avatarUrl) {
        return {
          inserted: 1,
          avatarFilename: directResult.avatarFilename,
          avatarUrl: directResult.avatarUrl,
          avatarBuffer: directResult.avatarBuffer ?? null,
          avatarContentType: directResult.avatarContentType ?? null,
          result_meta: {
            ok: true,
            method: 'direct_url_download',
            image_url_used: existingUrl,
          },
        }
      }
    }
  } catch (error) {
    console.warn('[avatarCrawler] Direct URL download failed; trying website', error?.message || String(error))
  }

  // Step 2: Use website cover image if available.
  // This makes the UI button deterministic and matches user intent.
  try {
    const websiteResult = await tryUseWebsiteCoverPhoto({ profileContext: effectiveContext, uploadDir })
    if (websiteResult?.ok && websiteResult.avatarUrl) {
      return {
        inserted: 1,
        avatarFilename: websiteResult.avatarFilename,
        avatarUrl: websiteResult.avatarUrl,
        avatarBuffer: websiteResult.avatarBuffer ?? null,
        avatarContentType: websiteResult.avatarContentType ?? null,
        result_meta: {
          ok: true,
          method: websiteResult.method || 'website_cover',
          website_used: websiteResult.website ?? null,
          image_url_used: websiteResult.coverUrl ?? null,
        },
      }
    }
  } catch (error) {
    // best-effort; fall back to OpenAI generation
    console.warn('[avatarCrawler] Website cover fetch failed; falling back to OpenAI', error?.message || String(error))
  }

  let openai = null
  try {
    openai = typeof getOpenAI === 'function' ? getOpenAI() : null
  } catch (error) {
    openai = null
  }
  if (!openai) {
    // Fallback: do not fail the job. The UI already has a default avatar.
    return {
      inserted: 0,
      result_count: 0,
      result_meta: {
        ok: false,
        reason: 'no_website_cover_and_openai_unavailable',
        message:
          'Avatar lookup could not find a website cover image and OpenAI is not configured. Using default avatar.',
      },
    }
  }
  const prompt = buildAvatarPrompt(profile)
  let response = null
  try {
    response = await openai.images.generate({
      model: 'gpt-image-1',
      prompt,
      size: '512x512',
      response_format: 'b64_json',
    })
  } catch (error) {
    let summary = { isAuth: false, message: 'Unknown OpenAI error' }
    try {
      summary = summarizeOpenAIError(error)
    } catch {
      // ignore summarizer failures; we'll fall back to a safe message
      const message = error instanceof Error ? error.message : String(error)
      summary = { isAuth: /incorrect api key|invalid api key|unauthorized|401/i.test(message), message }
    }

    const message = error instanceof Error ? error.message : String(error)
    const isAuth =
      Boolean(summary?.isAuth) || /incorrect api key|invalid api key|unauthorized|401/i.test(message)

    if (isAuth) {
      return {
        inserted: 0,
        result_count: 0,
        result_meta: {
          ok: false,
          reason: 'openai_auth_failed',
          message:
            'Avatar generation unavailable (OpenAI authentication failed). Verify OPENAI_API_KEY and image model access.',
        },
      }
    }
    return {
      inserted: 0,
      result_count: 0,
      result_meta: {
        ok: false,
        reason: 'openai_error',
        message: `Avatar generation failed: ${summary?.message || message}`,
      },
    }
  }

  const base64 = response?.data?.[0]?.b64_json
  if (!base64) {
    // Never fail the job: keep crawler pipeline moving.
    return {
      inserted: 0,
      result_count: 0,
      result_meta: {
        ok: false,
        reason: 'openai_no_content',
        message: 'Avatar generation returned no image content. Using default avatar.',
      },
    }
  }

  const filename = `${Date.now()}-${randomUUID()}.png`
  const filePath = join(uploadDir, filename)
  const generatedBuf = Buffer.from(base64, 'base64')
  fs.writeFileSync(filePath, generatedBuf)

  return {
    inserted: 1,
    avatarFilename: filename,
    avatarUrl: `/uploads/${filename}`,
    // Durable persistence (ephemeral-disk trap) — see tryDownloadDirectUrl.
    avatarBuffer: generatedBuf,
    avatarContentType: 'image/png',
    result_meta: {
      ok: true,
      method: 'openai_generated',
    },
  }
}

function buildAvatarPrompt(profile) {
  const parts = []
  parts.push(`Professional headshot portrait photograph of ${profile.display_name}`)
  if (profile.primary_type) {
    parts.push(`Profile type: ${profile.primary_type.replace(/_/g, ' ')}`)
  }
  parts.push('Facing camera, soft lighting, neutral background, high-resolution, realistic photo style')
  return parts.join('. ')
}
