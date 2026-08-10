/**
 * orgLogoFetcher.js
 *
 * Derive an organization's profile picture from its own public website.
 *
 * For organization profiles the most authentic avatar is usually the
 * organization's real logo. This module fetches the homepage, extracts ordered
 * logo candidates, and returns raw bytes plus content type so the caller can
 * persist them through the same durable avatar path used by manual uploads.
 *
 * Extraction priority:
 *   1. og:image / twitter:image
 *   2. largest apple-touch-icon
 *   3. favicon / icon links, then /favicon.ico
 *   4. a prominent image that looks like a logo
 *
 * Security boundary:
 *   - all homepage and image requests use the shared socket-pinned safeFetch
 *     path through safeAvatarFetch;
 *   - every redirect hop is re-resolved and validated;
 *   - private, loopback, link-local, metadata, and unsafe schemes fail closed;
 *   - HTML and image bodies are capped while streaming, before full buffering;
 *   - localhost is permitted only for hermetic tests under NODE_ENV=test.
 */

import * as cheerio from 'cheerio'
import { normalizeHttpUrl, safeAvatarFetch } from './avatarCrawler.js'
import { discardResponseBody, readBufferCapped } from './http/safeFetch.js'

async function discardAndReturn(response, result) {
  await discardResponseBody(response)
  return result
}

const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MIN_IMAGE_BYTES = 100

function resolveUrl(baseUrl, maybeRelative) {
  const raw = String(maybeRelative ?? '').trim()
  if (!raw) return null
  try {
    return new URL(raw, baseUrl).toString()
  } catch {
    return null
  }
}

function parseIconSize(sizesAttr) {
  const raw = String(sizesAttr ?? '').trim().toLowerCase()
  if (!raw || raw === 'any') return 0
  const match = raw.match(/(\d+)\s*x\s*(\d+)/)
  if (!match) return 0
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 0
  return width * height
}

/**
 * Inspect homepage HTML and return unique absolute image candidates in priority
 * order. This parser performs no network I/O.
 */
export function extractLogoCandidates(html, baseUrl) {
  if (!html) return []
  const $ = cheerio.load(html)
  const candidates = []

  const push = (rawUrl, method) => {
    const resolved = resolveUrl(baseUrl, rawUrl)
    if (resolved && !candidates.some((candidate) => candidate.url === resolved)) {
      candidates.push({ url: resolved, method })
    }
  }

  ;[
    $('meta[property="og:image"]').attr('content'),
    $('meta[property="og:image:url"]').attr('content'),
    $('meta[property="og:image:secure_url"]').attr('content'),
    $('meta[name="twitter:image"]').attr('content'),
    $('meta[name="twitter:image:src"]').attr('content'),
    $('link[rel="image_src"]').attr('href'),
  ].forEach((value) => push(value, 'og_image'))

  const appleIcons = []
  $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').each((_, element) => {
    const href = $(element).attr('href')
    if (!href) return
    appleIcons.push({ href, size: parseIconSize($(element).attr('sizes')) })
  })
  appleIcons.sort((left, right) => right.size - left.size)
  appleIcons.forEach((icon) => push(icon.href, 'apple_touch_icon'))

  const linkIcons = []
  $('link[rel="icon"], link[rel="shortcut icon"], link[rel="mask-icon"], link[rel="fluid-icon"]').each(
    (_, element) => {
      const href = $(element).attr('href')
      if (!href) return
      linkIcons.push({ href, size: parseIconSize($(element).attr('sizes')) })
    },
  )
  linkIcons.sort((left, right) => right.size - left.size)
  linkIcons.forEach((icon) => push(icon.href, 'favicon'))
  push('/favicon.ico', 'favicon')

  const bodyImages = []
  $('img[src]').each((_, element) => {
    const src = $(element).attr('src')
    if (!src) return
    const width = parseInt($(element).attr('width') || '0', 10)
    const height = parseInt($(element).attr('height') || '0', 10)
    const alt = String($(element).attr('alt') || '').toLowerCase()
    const className = String($(element).attr('class') || '').toLowerCase()
    const id = String($(element).attr('id') || '').toLowerCase()
    const haystack = `${alt} ${className} ${id} ${src}`.toLowerCase()
    const isLikelyLogo = /logo|brand|header|wordmark/i.test(haystack)
    if (width > 0 && width < 48 && height > 0 && height < 48) return
    bodyImages.push({ src, isLikelyLogo, area: width * height })
  })
  bodyImages.sort((left, right) => {
    if (left.isLikelyLogo !== right.isLikelyLogo) return left.isLikelyLogo ? -1 : 1
    return right.area - left.area
  })
  bodyImages.forEach((image) => push(image.src, 'logo_img'))

  return candidates
}

function avatarFetchOptions(options) {
  return {
    allowLocalhost: options.allowLocalhost,
    resolve: options.resolve,
    fetchImpl: options.fetchImpl,
    safeFetchImpl: options.safeFetchImpl,
    signal: options.signal,
  }
}

async function downloadImage(imageUrl, options = {}) {
  const url = normalizeHttpUrl(imageUrl)
  if (!url) return { ok: false, reason: 'invalid_image_url' }

  const fetched = await safeAvatarFetch(
    url,
    'image/*,*/*;q=0.8',
    avatarFetchOptions(options),
  )
  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason === 'blocked_private_host'
        ? 'blocked_private_image_host'
        : 'image_fetch_failed',
    }
  }

  const response = fetched.res
  if (!response) return { ok: false, reason: 'image_fetch_failed' }
  if (!response.ok) return discardAndReturn(response, { ok: false, reason: 'image_fetch_failed' })

  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  const looksImage = contentType.startsWith('image/') || contentType.includes('icon')
  if (!looksImage) return discardAndReturn(response, { ok: false, reason: 'not_image' })

  let imageBody
  try {
    imageBody = await readBufferCapped(response, MAX_IMAGE_BYTES)
  } catch {
    return discardAndReturn(response, { ok: false, reason: 'image_read_failed' })
  }
  if (imageBody.truncated) return { ok: false, reason: 'image_too_large' }
  const buffer = imageBody.buffer
  if (buffer.length < MIN_IMAGE_BYTES) return { ok: false, reason: 'image_too_small' }

  const finalUrl = fetched.finalUrl || url
  let storedContentType = contentType
  if (!storedContentType.startsWith('image/')) {
    storedContentType = finalUrl.toLowerCase().endsWith('.ico') ? 'image/x-icon' : 'image/png'
  }

  return {
    ok: true,
    buffer,
    contentType: storedContentType,
    sourceUrl: finalUrl,
  }
}

/**
 * Fetch an organization's homepage and return its highest-priority usable logo.
 *
 * @param {string} websiteUrl
 * @param {object} [opts]
 * @param {boolean} [opts.allowLocalhost] test-only loopback permission
 * @param {Function} [opts.resolve] test-only DNS resolver
 * @param {Function} [opts.fetchImpl] test-only transport that must honor the pinned agent
 * @param {Function} [opts.safeFetchImpl] test-only safe-fetch replacement
 * @param {AbortSignal} [opts.signal] caller cancellation
 */
export async function fetchOrgLogo(websiteUrl, opts = {}) {
  const allowLocalhost = typeof opts.allowLocalhost === 'boolean'
    ? opts.allowLocalhost
    : process.env.NODE_ENV === 'test'

  const website = normalizeHttpUrl(websiteUrl)
  if (!website) return { ok: false, reason: 'no_website' }

  const options = { ...opts, allowLocalhost }
  const fetched = await safeAvatarFetch(
    website,
    'text/html,application/xhtml+xml',
    avatarFetchOptions(options),
  )
  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason === 'blocked_private_host'
        ? 'blocked_private_host'
        : 'website_fetch_failed',
    }
  }

  const pageResponse = fetched.res
  const finalUrl = fetched.finalUrl || website
  if (!pageResponse) return { ok: false, reason: 'website_fetch_failed' }
  if (!pageResponse.ok) return discardAndReturn(pageResponse, { ok: false, reason: 'website_fetch_failed' })

  let pageBody
  try {
    pageBody = await readBufferCapped(pageResponse, MAX_HTML_BYTES)
  } catch {
    return discardAndReturn(pageResponse, { ok: false, reason: 'website_read_failed' })
  }
  if (pageBody.truncated) return { ok: false, reason: 'website_too_large' }

  const candidates = extractLogoCandidates(pageBody.buffer.toString('utf8'), finalUrl)
  if (candidates.length === 0) return { ok: false, reason: 'no_logo_found' }

  let lastReason = 'no_logo_found'
  for (const candidate of candidates) {
    const result = await downloadImage(candidate.url, options)
    if (result.ok) {
      return {
        ok: true,
        buffer: result.buffer,
        contentType: result.contentType,
        method: candidate.method,
        sourceUrl: result.sourceUrl,
        website: finalUrl,
      }
    }
    lastReason = result.reason
  }

  return { ok: false, reason: lastReason }
}

export default { fetchOrgLogo, extractLogoCandidates }
