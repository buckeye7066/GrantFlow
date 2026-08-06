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
  // html.duckduckgo.com/html/?q=… is the no-JS results endpoint our own
  // webSearchEngine queries — same results-page shape, same rule.
  /\bduckduckgo\.com\/html\/?\?/i, // audit:allow placeholder
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
  //
  // The canonical list lives in SEARCH_ENGINE_URL_PATTERNS (above). We spread
  // it in here so the placeholder-URL gate (isPlaceholderUrl → pickRealUrl →
  // assessReality) and the isSearchEngineUrl() helper can never drift apart:
  // adding an engine in one place covers BOTH the reality gate and the
  // content/junk filter. (Previously this list duplicated only google/bing/
  // yahoo and silently let yandex/baidu/ecosia search URLs through.)
  ...SEARCH_ENGINE_URL_PATTERNS,
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

/**
 * Is the given IP literal in a private / loopback / link-local / reserved range
 * that an outbound crawl or link-check must never reach? Covers IPv4 and the
 * common IPv6 cases (including IPv4-mapped ::ffff:a.b.c.d).
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true // fail closed
  let addr = ip.trim().toLowerCase()

  // IPv4-mapped IPv6 (::ffff:192.168.0.1) → evaluate the embedded v4.
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) addr = mapped[1]

  if (addr.includes(':')) {
    // IPv6
    if (addr === '::1' || addr === '::') return true // loopback / unspecified
    if (addr.startsWith('fe80')) return true // link-local
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true // unique-local fc00::/7
    if (addr.startsWith('ff')) return true // multicast ff00::/8
    if (addr.startsWith('2001:db8')) return true // documentation-only 2001:db8::/32
    return false
  }

  const parts = addr.split('.')
  if (parts.length !== 4) return true // not a clean dotted-quad → fail closed
  const o = parts.map((p) => Number(p))
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = o
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 0) return true // 0.0.0.0/8
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && b === 51 && o[2] === 100) return true // documentation TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true // documentation TEST-NET-3
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmarking
  if (a >= 224) return true // multicast / reserved (224.0.0.0/3)
  return false
}

/**
 * SSRF gate for outbound fetches against untrusted/ingested URLs.
 *
 * Validates scheme (http/https only), rejects known metadata/loopback hostnames,
 * and — crucially — resolves the hostname via DNS and rejects if ANY resolved
 * address is private/loopback/link-local (defeats hostnames that point at
 * internal infrastructure). Call this BEFORE fetching crawled/ingested URLs.
 *
 * NOTE: callers that follow redirects should re-validate each hop's URL, since
 * this only checks the initial target.
 *
 * @param {string} url
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function assertSsrfSafeUrl(url) {
  if (!url || typeof url !== 'string') return { ok: false, reason: 'empty_url' }
  let parsed
  try {
    parsed = new URL(url.trim())
  } catch {
    return { ok: false, reason: 'unparseable_url' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `blocked_scheme:${parsed.protocol}` }
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (SSRF_BLOCKED_HOSTS.has(host)) return { ok: false, reason: `blocked_host:${host}` }

  // If the host is already an IP literal, check it directly (no DNS needed).
  const isIpLiteral = /^[0-9.]+$/.test(host) || host.includes(':')
  if (isIpLiteral) {
    return isPrivateIp(host) ? { ok: false, reason: `private_ip:${host}` } : { ok: true }
  }

  // Resolve the hostname and reject if any address is private.
  try {
    const dns = await import('node:dns')
    const records = await dns.promises.lookup(host, { all: true })
    if (!records.length) return { ok: false, reason: 'dns_no_records' }
    for (const r of records) {
      if (isPrivateIp(r.address)) return { ok: false, reason: `resolves_private:${r.address}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `dns_error:${err?.code || err?.message || 'unknown'}` }
  }
}

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

// ── Tenant-slug portal platforms + funder plausibility ──────────────────
//
// Multi-tenant scholarship/application platforms where the FIRST hostname
// label is the INSTITUTION's tenant slug (`<school>.academicworks.com`,
// `<school>.scholarships.ngwebsolutions.com`). On these hosts the slug IS an
// identity claim about which institution the portal belongs to — so a portal
// URL whose slug cannot be explained by the funder's own name is positive
// evidence of a WRONG-INSTITUTION link (the cpcc-for-Cleveland-State class,
// live walkthrough 2026-08-03: an opportunity attributed to "Cleveland State
// Community College" (TN) carried https://cpcc.academicworks.com/ — Central
// Piedmont Community College, NC).
//
// Deliberately conservative: hosts NOT on this list are 'undecidable', never
// 'implausible' — a funder's own domain routinely shares no letters with its
// legal name (olemiss.edu / University of Mississippi, tn.gov / Tennessee
// Student Assistance Corporation), so flagging outside tenant platforms would
// manufacture false alarms. This is the Yana lead-contact posture: only a
// POSITIVE mismatch is acted on; silence is not a verdict.

export const TENANT_SLUG_PORTAL_PLATFORMS = Object.freeze([
  'academicworks.com',
  'awardspring.com',
  'communityforce.com',
  'scholarshipuniverse.com',
  'smapply.io',
  'smapply.org',
  'fluidreview.com',
  'ngwebsolutions.com',
])

/**
 * If `url` lives on a tenant-slug portal platform, return
 * `{ platform, slug }`; otherwise null. The bare platform host (no tenant
 * label) returns `{ platform, slug: '' }`.
 */
export function tenantPortalSlug(url) {
  const host = extractHostname(url)
  if (!host) return null
  for (const platform of TENANT_SLUG_PORTAL_PLATFORMS) {
    if (host === platform) return { platform, slug: '' }
    if (host.endsWith('.' + platform)) {
      const prefix = host.slice(0, -(platform.length + 1))
      const slug = prefix.split('.')[0] || ''
      return { platform, slug }
    }
  }
  return null
}

/** Words of a funder/institution name, lowercased, order preserved. */
function funderNameWords(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Can `slug` be read as an ordered concatenation of PREFIXES of the funder's
 * own name words (words skippable, each contributing >= 1 leading char)?
 *
 * This is the whole-name discipline of the Yana lead-contact rule
 * (enforceLeadContactPlausibility, CLAUDE.md invariants table) applied to a
 * tenant slug: identity is argued from the WHOLE name, never from one shared
 * word. A legitimate tenant slug is an abbreviation of the institution's own
 * name — an initialism ("mtsu" ← Middle Tennessee State University), a
 * prefix blend ("clscc" ← CLeveland State Community College), or the name
 * itself ("clevelandstatecc"). "cpcc" cannot be decomposed from "Cleveland
 * State Community College" (no word starts with p), which is exactly the
 * wrong-institution signature. Errs toward 'plausible' on coincidence
 * (a false "plausible" keeps today's behavior; a false "implausible" would
 * blank a real link).
 */
export function slugMatchesFunderName(slug, funderName) {
  const s = String(slug || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!s) return false
  const words = funderNameWords(funderName)
  if (!words.length) return false
  // Whole-name containment fast path: slug contains a distinctive full word.
  // (Kept minimal — the decomposition below already covers whole words.)
  // dp[i] = set of word indexes usable next, tracked as: can slug[0..i) be
  // decomposed using words[0..j)? Standard ordered-subsequence prefix DP.
  const n = s.length
  const m = words.length
  // reachable[i][j] = slug[0..i) decomposable consuming words up to index j (exclusive)
  const reachable = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(false))
  reachable[0][0] = true
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (!reachable[i][j]) continue
      // Skip word j entirely.
      if (j < m) reachable[i][j + 1] = true
      // Consume a prefix (>= 1 char) of word j at slug position i.
      if (i < n && j < m) {
        const w = words[j]
        const maxLen = Math.min(w.length, n - i)
        for (let len = 1; len <= maxLen; len++) {
          if (s.startsWith(w.slice(0, len), i)) {
            reachable[i + len][j + 1] = true
          } else {
            break // prefixes grow char-by-char; first mismatch ends the run
          }
        }
      }
    }
  }
  for (let j = 0; j <= m; j++) {
    if (reachable[n][j]) return true
  }
  return false
}

// Name TOKENS that make a funder name an INSTITUTION-identity claim. A donor
// name ("Adams Family Foundation", "Bank of America", "Hoyer Law Group")
// legitimately lives on a SCHOOL's tenant portal — prod audit 2026-08-03
// found 118 tenant-platform catalog rows and the donor-sponsored majority are
// CORRECT links — so a slug mismatch against a donor name proves nothing.
// Only a funder that names an institution (token-level: 'college',
// 'university', … — "NursingColleges.com" does NOT tokenize to 'college')
// can falsify a tenant slug.
const INSTITUTION_NAME_TOKENS = new Set([
  'college', 'colleges', 'university', 'universities', 'institute', 'academy', 'seminary', 'conservatory',
])

/** Does this funder name claim to BE an institution (vs a donor/program)? */
export function funderNameIsInstitution(funderName) {
  return funderNameWords(funderName).some((w) => INSTITUTION_NAME_TOKENS.has(w))
}

/**
 * Does this portal URL plausibly belong to the named funder/institution?
 *
 * Returns 'plausible' | 'implausible' | 'undecidable'.
 *  - 'implausible' ONLY on positive evidence: the URL is a tenant-slug
 *    platform host, the funder name is itself an INSTITUTION name, and the
 *    slug cannot be explained by that whole name (see slugMatchesFunderName).
 *    That is the cpcc-for-Cleveland-State signature: two institution
 *    identities that disagree.
 *  - Anything else — non-tenant host, bare platform host, missing funder
 *    name, donor-named funder on a school portal — is 'undecidable'
 *    (we learned nothing; never treat that as a denial).
 */
export function portalUrlFunderPlausibility(url, funderName) {
  const tenant = tenantPortalSlug(url)
  if (!tenant || !tenant.slug) return 'undecidable'
  if (!String(funderName || '').trim()) return 'undecidable'
  if (slugMatchesFunderName(tenant.slug, funderName)) return 'plausible'
  return funderNameIsInstitution(funderName) ? 'implausible' : 'undecidable'
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
