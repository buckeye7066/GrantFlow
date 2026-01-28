import fs from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { summarizeOpenAIError } from '../utils/openaiClient.js'
import * as cheerio from 'cheerio'

const fetchImpl = globalThis.fetch

function normalizeHttpUrl(value) {
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

function isPrivateHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase()
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  if (h === '::1') return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const parts = h.split('.').map((p) => Number(p))
    const [a, b] = parts
    if (a === 10) return true
    if (a === 127) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
  }
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

async function tryUseWebsiteCoverPhoto({ profileContext, uploadDir }) {
  const websiteRaw =
    profileContext?.sections?.basic_information?.website ??
    profileContext?.profile?.website ??
    profileContext?.organization?.website ??
    null

  const website = normalizeHttpUrl(websiteRaw)
  if (!website) {
    return { ok: false, reason: 'no_website' }
  }

  // SSRF guard (allow localhost only in tests).
  const allowLocalhost = process.env.NODE_ENV === 'test'
  const websiteHost = new URL(website).hostname
  if (!allowLocalhost && isPrivateHostname(websiteHost)) {
    return { ok: false, reason: 'blocked_private_host' }
  }

  if (!fetchImpl) {
    return { ok: false, reason: 'fetch_unavailable' }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 12_000)
  let res = null
  let finalUrl = website
  try {
    res = await fetchImpl(website, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'GrantFlow Avatar Lookup/1.0',
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    finalUrl = res?.url || website
  } finally {
    clearTimeout(timeoutId)
  }

  if (!res || !res.ok) {
    return { ok: false, reason: 'website_fetch_failed' }
  }

  const contentType = String(res.headers.get('content-type') || '')
  if (!contentType.toLowerCase().includes('text/html')) {
    // Some sites serve HTML as application/octet-stream; still attempt.
  }

  const html = await res.text().catch(() => '')
  const pick = pickWebsiteImageCandidate(html, finalUrl)
  if (!pick?.url) {
    return { ok: false, reason: 'no_cover_meta' }
  }
  const coverUrl = pick.url
  const method = pick.method || 'website_cover'

  const coverHost = new URL(coverUrl).hostname
  if (!allowLocalhost && isPrivateHostname(coverHost)) {
    return { ok: false, reason: 'blocked_private_cover_host' }
  }

  const imgController = new AbortController()
  const imgTimeoutId = setTimeout(() => imgController.abort(), 12_000)
  let imgRes = null
  try {
    imgRes = await fetchImpl(coverUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: imgController.signal,
      headers: {
        'User-Agent': 'GrantFlow Avatar Lookup/1.0',
        Accept: 'image/*,*/*;q=0.8',
      },
    })
  } finally {
    clearTimeout(imgTimeoutId)
  }

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
    coverUrl,
    website: finalUrl,
    method,
  }
}

export async function processAvatarLookupJob({ profileContext, uploadDir, getOpenAI }) {
  const profile = profileContext?.profile
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

  // Preferred behavior: use website cover image if available.
  // This makes the UI button deterministic and matches user intent.
  try {
    const websiteResult = await tryUseWebsiteCoverPhoto({ profileContext, uploadDir })
    if (websiteResult?.ok && websiteResult.avatarUrl) {
      return {
        inserted: 1,
        avatarFilename: websiteResult.avatarFilename,
        avatarUrl: websiteResult.avatarUrl,
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
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))

  return {
    inserted: 1,
    avatarFilename: filename,
    avatarUrl: `/uploads/${filename}`,
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
