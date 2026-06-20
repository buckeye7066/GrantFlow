/**
 * orgLogoFetcher.js
 *
 * Derive an organization's profile picture from its OWN public website.
 *
 * For ORGANIZATION profiles the most authentic avatar is the org's real
 * logo, which almost always lives on their homepage. This module fetches
 * the homepage and extracts a logo image, returning the raw BYTES (and
 * content-type) so the caller can persist them through the SAME durable
 * avatar path the manual upload uses (profiles.avatar_data BYTEA + the
 * /uploads read cache). Persisting bytes — not a remote URL — is required
 * by the ephemeral-filesystem pattern: Railway wipes local disk, so the
 * DB BYTEA column is the only durable source of truth.
 *
 * Extraction priority (most → least authoritative for a brand logo):
 *   1. og:image / twitter:image (the site's own social card image)
 *   2. apple-touch-icon (largest declared — these are high-res app icons)
 *   3. link rel="icon" / shortcut icon / mask-icon, then /favicon.ico
 *   4. a prominent <img> that looks like a logo (alt/class/src hints)
 *
 * Safety: SSRF guard (no private/loopback hosts), image-only content
 * types, hard size cap, per-fetch timeout, total redirects followed by
 * the platform fetch. Every failure is reported as a structured reason
 * so the caller can fall back gracefully (AI generation / initials).
 */

import * as cheerio from 'cheerio'
import dns from 'node:dns/promises'
import net from 'node:net'
import { normalizeHttpUrl } from './avatarCrawler.js'

const fetchImpl = globalThis.fetch

const FETCH_TIMEOUT_MS = 12_000
const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // 8MB cap
const MIN_IMAGE_BYTES = 100 // reject empty / 1px tracking junk
const USER_AGENT = 'GrantFlow Org Logo Fetcher/1.0'
const MAX_REDIRECTS = 4

// Fast hostname check for obviously-local names + IP literals. NOT sufficient on
// its own (a public hostname can DNS-resolve to a private IP) — resolvesPrivate()
// below does the authoritative, resolution-based check.
function isPrivateHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase()
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  return false
}

// Is a concrete IP address (v4 or v6, incl. IPv4-mapped IPv6) in a
// private/loopback/link-local/CGNAT/ULA/reserved range that must never be
// fetched server-side (SSRF guard)?
function ipIsPrivate(ipRaw) {
  let ip = String(ipRaw || '').trim().toLowerCase()
  if (!ip) return true
  // Unwrap IPv4-mapped / -compatible IPv6 (::ffff:10.0.0.1, ::ffff:a00:1, etc.)
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) ip = mapped[1]
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map((p) => Number(p))
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true            // link-local
    if (a === 172 && b >= 16 && b <= 31) return true   // private
    if (a === 192 && b === 168) return true            // private
    if (a === 100 && b >= 64 && b <= 127) return true  // CGNAT 100.64/10
    if (a === 192 && b === 0) return true               // 192.0.0/24, 192.0.2/24
    if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
    if (a >= 224) return true                           // multicast / reserved / 255.255.255.255
    return false
  }
  if (net.isIPv6(ip)) {
    if (ip === '::1' || ip === '::') return true        // loopback / unspecified
    if (ip.startsWith('fe80') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true // link-local fe80::/10
    if (/^f[cd]/.test(ip)) return true                  // unique-local fc00::/7
    return false
  }
  return true // not a parseable IP → block
}

// Authoritative SSRF check: resolve the host and reject if ANY resolved address
// is private. An IP literal is checked directly; a DNS failure blocks (fail closed).
async function resolvesPrivate(host) {
  const h = String(host || '').trim().toLowerCase()
  if (!h) return true
  if (isPrivateHostname(h)) return true
  if (net.isIP(h)) return ipIsPrivate(h)
  let records = []
  try {
    records = await dns.lookup(h, { all: true })
  } catch {
    return true // can't resolve → fail closed
  }
  if (!records.length) return true
  return records.some((r) => ipIsPrivate(r.address))
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

// apple-touch-icon entries can declare a "sizes" attribute like "180x180".
// Parse the leading dimension so we can prefer the largest (highest-res) icon.
function parseIconSize(sizesAttr) {
  const raw = String(sizesAttr ?? '').trim().toLowerCase()
  if (!raw || raw === 'any') return 0
  const match = raw.match(/(\d+)\s*x\s*(\d+)/)
  if (!match) return 0
  const w = Number(match[1])
  const h = Number(match[2])
  if (!Number.isFinite(w) || !Number.isFinite(h)) return 0
  return w * h
}

/**
 * Inspect homepage HTML and return an ordered list of candidate image
 * URLs (absolute), best first, each tagged with the method that found
 * it. Order encodes the priority documented at the top of the file.
 */
export function extractLogoCandidates(html, baseUrl) {
  if (!html) return []
  const $ = cheerio.load(html)
  const candidates = []

  const push = (rawUrl, method) => {
    const resolved = resolveUrl(baseUrl, rawUrl)
    if (resolved && !candidates.some((c) => c.url === resolved)) {
      candidates.push({ url: resolved, method })
    }
  }

  // 1. og:image / social card.
  ;[
    $('meta[property="og:image"]').attr('content'),
    $('meta[property="og:image:url"]').attr('content'),
    $('meta[property="og:image:secure_url"]').attr('content'),
    $('meta[name="twitter:image"]').attr('content'),
    $('meta[name="twitter:image:src"]').attr('content'),
    $('link[rel="image_src"]').attr('href'),
  ].forEach((v) => push(v, 'og_image'))

  // 2. apple-touch-icon — prefer the LARGEST declared size.
  const appleIcons = []
  $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    appleIcons.push({ href, size: parseIconSize($(el).attr('sizes')) })
  })
  appleIcons.sort((a, b) => b.size - a.size)
  appleIcons.forEach((icon) => push(icon.href, 'apple_touch_icon'))

  // 3. favicon / icon links, then the conventional /favicon.ico location.
  const linkIcons = []
  $('link[rel="icon"], link[rel="shortcut icon"], link[rel="mask-icon"], link[rel="fluid-icon"]').each(
    (_, el) => {
      const href = $(el).attr('href')
      if (!href) return
      linkIcons.push({ href, size: parseIconSize($(el).attr('sizes')) })
    },
  )
  linkIcons.sort((a, b) => b.size - a.size)
  linkIcons.forEach((icon) => push(icon.href, 'favicon'))
  push('/favicon.ico', 'favicon')

  // 4. a prominent <img> that looks like a logo.
  const bodyImages = []
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src')
    if (!src) return
    const w = parseInt($(el).attr('width') || '0', 10)
    const h = parseInt($(el).attr('height') || '0', 10)
    const alt = String($(el).attr('alt') || '').toLowerCase()
    const cls = String($(el).attr('class') || '').toLowerCase()
    const idAttr = String($(el).attr('id') || '').toLowerCase()
    const haystack = `${alt} ${cls} ${idAttr} ${src}`.toLowerCase()
    const isLikelyLogo = /logo|brand|header|wordmark/i.test(haystack)
    // Skip obvious tracking pixels / spacers.
    if (w > 0 && w < 48 && h > 0 && h < 48) return
    bodyImages.push({ src, isLikelyLogo, area: w * h })
  })
  bodyImages.sort((a, b) => {
    if (a.isLikelyLogo !== b.isLikelyLogo) return a.isLikelyLogo ? -1 : 1
    return b.area - a.area
  })
  bodyImages.forEach((img) => push(img.src, 'logo_img'))

  return candidates
}

async function fetchOnce(url, accept) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual', // we follow manually so we can re-validate every hop
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

// SSRF-safe fetch: validates the host (via DNS resolution) BEFORE every request,
// follows redirects manually (capped), and re-validates each hop's Location host.
// Returns { ok, res, finalUrl } or { ok:false, reason }.
async function safeFetch(startUrl, accept, { allowLocalhost }) {
  let current = startUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let host
    try { host = new URL(current).hostname } catch { return { ok: false, reason: 'invalid_url' } }
    if (!allowLocalhost && await resolvesPrivate(host)) {
      return { ok: false, reason: 'blocked_private_host' }
    }
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
      // Only http(s) redirects are followed (blocks file:/gopher:/etc.).
      if (!/^https?:\/\//i.test(next)) return { ok: false, reason: 'blocked_redirect_scheme' }
      current = next
      continue
    }
    return { ok: true, res, finalUrl: current }
  }
  return { ok: false, reason: 'too_many_redirects' }
}

async function downloadImage(imageUrl, { allowLocalhost }) {
  const url = normalizeHttpUrl(imageUrl)
  if (!url) return { ok: false, reason: 'invalid_image_url' }

  const fetched = await safeFetch(url, 'image/*,*/*;q=0.8', { allowLocalhost })
  if (!fetched.ok) {
    return { ok: false, reason: fetched.reason === 'blocked_private_host' ? 'blocked_private_image_host' : 'image_fetch_failed' }
  }
  const res = fetched.res
  if (!res || !res.ok) return { ok: false, reason: 'image_fetch_failed' }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase()
  // .ico files are sometimes served with non-image content types; accept the
  // common image/* family plus icon variants.
  const looksImage = contentType.startsWith('image/') || contentType.includes('icon')
  if (!looksImage) return { ok: false, reason: 'not_image' }

  let buf = null
  try {
    buf = Buffer.from(await res.arrayBuffer())
  } catch {
    return { ok: false, reason: 'image_read_failed' }
  }
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'image_too_large' }
  if (buf.length < MIN_IMAGE_BYTES) return { ok: false, reason: 'image_too_small' }

  // Normalize the stored content type to a concrete image/* value.
  let storedContentType = contentType
  if (!storedContentType.startsWith('image/')) {
    storedContentType = url.toLowerCase().endsWith('.ico') ? 'image/x-icon' : 'image/png'
  }

  return { ok: true, buffer: buf, contentType: storedContentType, sourceUrl: url }
}

/**
 * Fetch an org's homepage and return the best logo image bytes.
 *
 * @param {string} websiteUrl - the org's website (any form; normalized here)
 * @param {object} [opts]
 * @param {boolean} [opts.allowLocalhost] - allow loopback hosts (tests only)
 * @returns {Promise<
 *   | { ok: true, buffer: Buffer, contentType: string, method: string, sourceUrl: string, website: string }
 *   | { ok: false, reason: string }
 * >}
 */
export async function fetchOrgLogo(websiteUrl, opts = {}) {
  // Explicit caller intent wins over the test-env convenience default: passing
  // allowLocalhost:false forces the SSRF guard on even under NODE_ENV=test.
  const allowLocalhost =
    typeof opts.allowLocalhost === 'boolean' ? opts.allowLocalhost : process.env.NODE_ENV === 'test'

  if (!fetchImpl) return { ok: false, reason: 'fetch_unavailable' }

  const website = normalizeHttpUrl(websiteUrl)
  if (!website) return { ok: false, reason: 'no_website' }

  // Fetch the homepage HTML through the SSRF-safe fetcher (validates every hop).
  const fetched = await safeFetch(website, 'text/html,application/xhtml+xml', { allowLocalhost })
  if (!fetched.ok) {
    return { ok: false, reason: fetched.reason === 'blocked_private_host' ? 'blocked_private_host' : 'website_fetch_failed' }
  }
  const pageRes = fetched.res
  const finalUrl = fetched.finalUrl || website
  if (!pageRes || !pageRes.ok) return { ok: false, reason: 'website_fetch_failed' }

  let html = ''
  try {
    html = await pageRes.text()
  } catch {
    html = ''
  }

  const candidates = extractLogoCandidates(html, finalUrl)
  if (candidates.length === 0) {
    return { ok: false, reason: 'no_logo_found' }
  }

  // Try candidates in priority order until one downloads as a usable image.
  let lastReason = 'no_logo_found'
  for (const candidate of candidates) {
    const result = await downloadImage(candidate.url, { allowLocalhost })
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
