/**
 * Centralized URL validation rules.
 *
 * ALL placeholder domains, social media domains, blocked patterns, and
 * URL validation logic lives here. Every file that checks whether a URL
 * is "real" MUST import from this module.
 *
 * Anti-drift rule: if you add a new blocked domain or pattern, add it
 * here — do not scatter it into crawlers, routes, or components.
 */

// ── Placeholder hostnames (never valid for funding opportunities) ───────

export const PLACEHOLDER_HOSTNAMES = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.gov',
  'placeholder.com',
  'placeholder.org',
  'test.com',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
])

// ── Social media / non-actionable domains ───────────────────────────────
// These are informational but not funding application portals.

export const NON_ACTIONABLE_DOMAINS = new Set([
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'linkedin.com',
  'youtube.com',
  'tiktok.com',
  'reddit.com',
  'pinterest.com',
  'snapchat.com',
  'threads.net',
  'medium.com',
])

// ── Generic search-engine result URLs ───────────────────────────────────
// Mission rule (Phase G): no direct opportunity may be displayed with a
// Google/Bing/etc search URL as its application_url — that's not a real
// funding source, it's a guess the crawler turned into a click. These
// patterns trip BOTH placeholder rejection (so the crawler never inserts
// such a row) AND the smoke script's per-opportunity URL audit.
//
// Each entry is an *intentional* validator literal — admin auditor must
// treat as allowed-placeholders, not findings.

export const SEARCH_ENGINE_URL_PATTERNS = [
  /\bgoogle\.com\/search\b/i, // audit:allow placeholder
  /\bgoogle\.com\/url\?/i, // audit:allow placeholder
  /\bbing\.com\/search\b/i, // audit:allow placeholder
  /\bduckduckgo\.com\/\?q=/i, // audit:allow placeholder
  /\bduckduckgo\.com\/\?.*&q=/i, // audit:allow placeholder
  /\byahoo\.com\/search\b/i, // audit:allow placeholder
  /\byandex\.\w+\/search\b/i, // audit:allow placeholder
  /\bbaidu\.com\/s\?/i, // audit:allow placeholder
  /\becosia\.org\/search\b/i, // audit:allow placeholder
]

/**
 * Mission rule (Phase G): a direct funding URL must not be a generic
 * search-engine result page. Returns true if the URL clearly points to
 * a search results page rather than a real funding portal.
 */
export function isSearchEngineUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false
  for (const rx of SEARCH_ENGINE_URL_PATTERNS) {
    if (rx.test(url)) return true
  }
  return false
}

// ── URL regex patterns that indicate placeholder/invalid URLs ───────────
// Each literal below is an *intentional* validator denylist entry. Admin
// auditor scanners must treat these as allowed-placeholders, not findings.

export const INVALID_URL_PATTERNS = [
  /example\.(com|org|net|gov)/i, // audit:allow placeholder
  /localhost(:\d+)?/i, // audit:allow placeholder
  /127\.0\.0\.1/, // audit:allow placeholder
  /0\.0\.0\.0/, // audit:allow placeholder
  /placeholder/i, // audit:allow placeholder
  /^javascript:/i, // audit:allow placeholder
  /^data:/i, // audit:allow placeholder
  /^file:/i, // audit:allow placeholder
  /^mailto:/i, // audit:allow placeholder
  // Phase G — generic search-engine result URLs are never a real
  // funding portal. Reject at ingest so they can never be saved as a
  // direct opportunity's application_url.
  /\bgoogle\.com\/search\b/i, // audit:allow placeholder
  /\bgoogle\.com\/url\?/i, // audit:allow placeholder
  /\bbing\.com\/search\b/i, // audit:allow placeholder
  /\bduckduckgo\.com\/\?/i, // audit:allow placeholder
  /\byahoo\.com\/search\b/i, // audit:allow placeholder
]

// ── Placeholder text patterns (used in title/description validation) ────
// Same convention: each pattern is an intentional validator literal.

export const PLACEHOLDER_TEXT_PATTERNS = [
  /lorem\s+ipsum/i, // audit:allow placeholder
  /\bplaceholder\b/i, // audit:allow placeholder
  /\bcoming\s+soon\b/i, // audit:allow placeholder
  /\btbd\b/i, // audit:allow placeholder
  /\bto\s+be\s+determined\b/i, // audit:allow placeholder
  /\btest\s+(opportunity|grant|program)\b/i, // audit:allow placeholder
  /\bn\/?a\b/i, // audit:allow placeholder
  /\bsample\s+(opportunity|grant|program)\b/i, // audit:allow placeholder
]

// ── SSRF protection (for document/proxy fetches, NOT funding URLs) ──────

export const SSRF_BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.169.254',  // AWS metadata
  '100.100.100.200',  // Alibaba metadata
  'metadata.google.internal',
])

// ── Link verification skip list ─────────────────────────────────────────
// These domains should not be HEAD-checked by the link verifier.

export const LINK_VERIFICATION_SKIP_DOMAINS = [
  'example.com',
  'example.org',
  'placeholder.com',
  'localhost',
]

// ── Helper functions ────────────────────────────────────────────────────

/**
 * Extract hostname from a URL string, lowercased.
 * Returns empty string on failure.
 */
export function extractHostname(url) {
  if (!url || typeof url !== 'string') return ''
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    const m = url.match(/(?:https?:\/\/)?(?:www\.)?([^/?#\s]+)/)
    return m ? m[1].toLowerCase() : ''
  }
}

/**
 * Check if a URL is a placeholder/invalid URL.
 * This is the single canonical check — use this everywhere.
 */
export function isPlaceholderUrl(url) {
  if (!url || typeof url !== 'string') return true
  const trimmed = url.trim()
  if (!trimmed) return true

  // Must be http or https
  if (!/^https?:\/\//i.test(trimmed)) return true

  // Check against invalid patterns
  for (const pattern of INVALID_URL_PATTERNS) {
    if (pattern.test(trimmed)) return true
  }

  // Check hostname against placeholder list
  const hostname = extractHostname(trimmed)
  if (PLACEHOLDER_HOSTNAMES.has(hostname)) return true

  return false
}

/**
 * Check if a URL points to a non-actionable domain (social media, etc.).
 */
export function isNonActionableUrl(url) {
  if (!url) return false
  const hostname = extractHostname(url)
  return NON_ACTIONABLE_DOMAINS.has(hostname)
}

/**
 * Check if text contains placeholder content.
 */
export function isPlaceholderText(text) {
  if (!text || typeof text !== 'string') return false
  return PLACEHOLDER_TEXT_PATTERNS.some((p) => p.test(text))
}

/**
 * Pick the best real URL from an opportunity's URL fields.
 * Returns null if no valid URL found.
 */
export function pickRealUrl(opportunity) {
  if (!opportunity) return null
  const candidates = [
    opportunity.application_url,
    opportunity.apply_url,
    opportunity.url,
    opportunity.source_url,
    opportunity.evidence_url,
  ]
  for (const url of candidates) {
    if (url && !isPlaceholderUrl(url)) return url
  }
  return null
}
