import fs from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { summarizeOpenAIError } from '../utils/openaiClient.js'
import {
  discardResponseBody,
  readBufferCapped,
  safeFetch,
  SsrfBlockedError,
} from './http/safeFetch.js'
import * as cheerio from 'cheerio'

const FETCH_TIMEOUT_MS = 12_000
const MAX_REDIRECTS = 4
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const USER_AGENT = 'GrantFlow Avatar Lookup/1.0'

/** Map shared SSRF refusals onto the avatar crawler's stable reason vocabulary. */
function mapSsrfReason(reason) {
  const value = String(reason || '')
  if (
    value.startsWith('private_ip:') ||
    value.startsWith('resolves_private:') ||
    value.startsWith('blocked_host:')
  ) return 'blocked_private_host'
  if (value === 'empty_url' || value === 'unparseable_url') return 'invalid_url'
  if (value.startsWith('unparseable_redirect')) return 'invalid_redirect'
  if (value.startsWith('blocked_scheme:')) return 'blocked_redirect_scheme'
  if (value.startsWith('too_many_redirects:')) return 'too_many_redirects'
  if (value === 'embedded_credentials') return 'blocked_embedded_credentials'
  if (value.startsWith('dns_')) return 'dns_failed'
  return value || 'fetch_failed'
}

async function discardAndReturn(res, result) {
  if (res) await discardResponseBody(res)
  return result
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

function resolveUrl(baseUrl, maybeRelative) {
  const raw = String(maybeRelative ?? '').trim()
  if (!raw) return null
  try {
    return new URL(raw, baseUrl).toString()
  } catch {
    return null
  }
}

/**
 * Avatar egress delegates to GrantFlow's single socket-pinned safeFetch
 * chokepoint. DNS is resolved once per hop, the approved address is pinned to
 * the connection, redirects are revalidated, and one deadline spans the chain.
 * Test-only transport/resolver injection is forwarded to safeFetch.
 */
export async function safeAvatarFetch(startUrl, accept, options = {}) {
  const egress = typeof options.safeFetchImpl === 'function'
    ? options.safeFetchImpl
    : safeFetch
  try {
    const res = await egress(
      startUrl,
      {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: accept,
        },
      },
      {
        maxRedirects: MAX_REDIRECTS,
        timeoutMs: FETCH_TIMEOUT_MS,
        signal: options.signal,
        resolve: options.resolve,
        fetchImpl: options.fetchImpl,
        allowTestLoopback:
          options.allowLocalhost === true && process.env.NODE_ENV === 'test',
      },
    )
    return {
      ok: true,
      res,
      finalUrl: res?.grantflowFinalUrl || startUrl,
    }
  } catch (error) {
    const message = String(error?.message || '')
    if (
      error instanceof SsrfBlockedError ||
      error?.name === 'SsrfBlockedError' ||
      message.startsWith('ssrf_blocked:')
    ) {
      const reason = error?.reason || message.replace(/^ssrf_blocked:/, '')
      return { ok: false, reason: mapSsrfReason(reason) }
    }
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'fetch_timeout_or_cancelled' : 'fetch_failed',
    }
  }
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

  const fetched = await safeAvatarFetch(url, 'image/*,*/*;q=0.8', { allowLocalhost: false })
  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason === 'blocked_private_host' ? 'blocked_private_host' : 'fetch_failed',
    }
  }
  const res = fetched.res
  if (!res) return { ok: false, reason: 'fetch_failed' }
  if (!res.ok) return discardAndReturn(res, { ok: false, reason: 'fetch_failed' })

  const contentType = String(res.headers.get('content-type') || '').toLowerCase()
  if (!contentType.startsWith('image/')) {
    return discardAndReturn(res, { ok: false, reason: 'not_image' })
  }

  let imageBody
  try {
    imageBody = await readBufferCapped(res, MAX_IMAGE_BYTES)
  } catch {
    return { ok: false, reason: 'image_body_read_failed' }
  }
  if (imageBody.truncated) return { ok: false, reason: 'too_large' }
  const buf = imageBody.buffer
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
  if (!res) return { ok: false, reason: 'website_fetch_failed' }
  if (!res.ok) {
    return discardAndReturn(res, { ok: false, reason: 'website_fetch_failed' })
  }

  let htmlBody
  try {
    htmlBody = await readBufferCapped(res, MAX_HTML_BYTES)
  } catch {
    return { ok: false, reason: 'website_body_read_failed' }
  }
  if (htmlBody.truncated) {
    return { ok: false, reason: 'website_body_too_large' }
  }
  const html = htmlBody.buffer.toString('utf8')
  const pick = pickWebsiteImageCandidate(html, finalUrl)
  if (!pick?.url) {
    return { ok: false, reason: 'no_cover_meta' }
  }
  const coverUrl = pick.url
  const method = pick.method || 'website_cover'

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
  if (!imgRes) return { ok: false, reason: 'cover_fetch_failed' }
  if (!imgRes.ok) {
    return discardAndReturn(imgRes, { ok: false, reason: 'cover_fetch_failed' })
  }

  const imgType = String(imgRes.headers.get('content-type') || '').toLowerCase()
  if (!imgType.startsWith('image/') && !imgType.includes('icon')) {
    return discardAndReturn(imgRes, { ok: false, reason: 'cover_not_image' })
  }

  let imageBody
  try {
    imageBody = await readBufferCapped(imgRes, MAX_IMAGE_BYTES)
  } catch {
    return { ok: false, reason: 'cover_body_read_failed' }
  }
  if (imageBody.truncated) return { ok: false, reason: 'cover_too_large' }
  const buf = imageBody.buffer

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
