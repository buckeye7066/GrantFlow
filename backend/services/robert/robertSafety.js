/**
 * robertSafety.js
 *
 * Pure safety primitives for Robert. NO file or network side effects —
 * this module is intentionally tiny so unit tests can reuse it without
 * mocks.
 *
 * Provides:
 *   - readEnvBool / readEnvInt / readEnvString — env helpers with safe defaults
 *   - getRobertConfig() — the single source of truth for runtime safety flags
 *   - maskSecrets() — redacts API keys / bearer tokens / env-var assignments
 *   - isPlaceholderUrl / isSearchEngineUrl / isProbableLoanProduct /
 *     isProbableMatchingFunds / isExpiredDeadline — Robert-side filters that
 *     compose with (NOT replace) the canonical opportunityPolicy gate
 *   - rateLimitGuard helpers for an injected DB-backed bucket
 */

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------
export function readEnvBool(name, fallback = false) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

export function readEnvInt(name, fallback) {
  const n = Number(process.env[name])
  if (Number.isFinite(n)) return Math.floor(n)
  return fallback
}

export function readEnvString(name, fallback = '') {
  const v = process.env[name]
  if (v === undefined || v === null || v === '') return fallback
  return String(v)
}

/**
 * Single source of truth for Robert's runtime safety flags. Everything
 * defaults to the SAFEST possible value.
 */
export function getRobertConfig() {
  return {
    enabled: readEnvBool('ROBERT_ENABLED', false),
    runOnStartup: readEnvBool('ROBERT_RUN_ON_STARTUP', false),
    runOnSchedule: readEnvBool('ROBERT_RUN_ON_SCHEDULE', false),
    schedule: readEnvString('ROBERT_SCHEDULE', '0 * * * *'),
    mode: readEnvString('ROBERT_MODE', 'observe').toLowerCase(),
    maxSourcesPerRun: readEnvInt('ROBERT_MAX_SOURCES_PER_RUN', 25),
    maxUrlsPerSource: readEnvInt('ROBERT_MAX_URLS_PER_SOURCE', 20),
    maxOpportunitiesPerRun: readEnvInt('ROBERT_MAX_OPPORTUNITIES_PER_RUN', 100),
    maxProfilesPerRun: readEnvInt('ROBERT_MAX_PROFILES_PER_RUN', 50),
    timeoutMs: readEnvInt('ROBERT_TIMEOUT_MS', 15_000),
    allowLiveWeb: readEnvBool('ROBERT_ALLOW_LIVE_WEB', false),
    allowSearchEngine: readEnvBool('ROBERT_ALLOW_SEARCH_ENGINE', false),
    allowSourceDiscovery: readEnvBool('ROBERT_ALLOW_SOURCE_DISCOVERY', false),
    persistCandidates: readEnvBool('ROBERT_PERSIST_CANDIDATES', true),
    autoIngestVerified: readEnvBool('ROBERT_AUTO_INGEST_VERIFIED', false),
    minSourceTrust: readEnvInt('ROBERT_MIN_SOURCE_TRUST', 60),
    requireRealApplicationUrl: readEnvBool('ROBERT_REQUIRE_REAL_APPLICATION_URL', true),
    respectRobots: readEnvBool('ROBERT_RESPECT_ROBOTS', true),
    userAgent: readEnvString('ROBERT_USER_AGENT', 'GrantFlowRobertBot/1.0'),
    rateLimitPerDomainPerHour: readEnvInt('ROBERT_RATE_LIMIT_PER_DOMAIN_PER_HOUR', 60),
    failOpen: readEnvBool('ROBERT_FAIL_OPEN', false),
    // Recommendation / toast knobs
    recommendationToastsEnabled: readEnvBool('ROBERT_RECOMMENDATION_TOASTS_ENABLED', true),
    maxToastsPerProfilePerDay: readEnvInt('ROBERT_MAX_TOASTS_PER_PROFILE_PER_DAY', 5),
    minToastMatchScore: readEnvInt('ROBERT_MIN_TOAST_MATCH_SCORE', 70),
    allowReviewMatchToasts: readEnvBool('ROBERT_ALLOW_REVIEW_MATCH_TOASTS', true),
    batchLowPriorityRecommendations: readEnvBool('ROBERT_BATCH_LOW_PRIORITY_RECOMMENDATIONS', true),
    recommendationPollIntervalMs: readEnvInt('ROBERT_RECOMMENDATION_POLL_INTERVAL_MS', 30_000),
    recommendationLiveStreamEnabled: readEnvBool('ROBERT_RECOMMENDATION_LIVE_STREAM_ENABLED', true),
    recommendationQueueOnLogin: readEnvBool('ROBERT_RECOMMENDATION_QUEUE_ON_LOGIN', true),
  }
}

// ---------------------------------------------------------------------------
// Secret masking — same shape as Sam's, kept local so Robert has no
// dependency on Sam's audit store.
// ---------------------------------------------------------------------------
const MASK = '***REDACTED***'

const SECRET_PATTERNS = [
  {
    re: /(\b(?:PASSWORD|TOKEN|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY|ANTHROPIC[_-]?API[_-]?KEY|OPENAI[_-]?API[_-]?KEY|JWT[_-]?SECRET|ADMIN[_-]?TOKEN|DATABASE[_-]?URL|SUPABASE[_-]?[A-Z_]+|STRIPE[_-]?[A-Z_]+|SMTP[_-]?[A-Z_]+|SENDGRID[_-]?[A-Z_]+)[\w-]*)\s*[:=]\s*["']?([^\s"']+)/gi,
    replace: (_m, name) => `${name}=${MASK}`,
  },
  {
    re: /(Authorization:\s*Bearer\s+)([A-Za-z0-9._\-+/=]+)/gi,
    replace: (_m, prefix) => `${prefix}${MASK}`,
  },
  {
    re: /\b((?:sk|pk|gfsk|ghp|gho|ghs|sk-ant|key)[-_][A-Za-z0-9_-]{16,})\b/g,
    replace: () => MASK,
  },
]

export function maskSecrets(input) {
  if (input === null || input === undefined) return input
  if (typeof input === 'object') {
    try { return JSON.parse(maskSecrets(JSON.stringify(input))) } catch { return input }
  }
  let value = String(input)
  for (const { re, replace } of SECRET_PATTERNS) {
    re.lastIndex = 0
    value = value.replace(re, replace)
  }
  if (value.length > 100_000) value = `${value.slice(0, 100_000)}\n…[truncated by Robert at 100k chars]…`
  return value
}

// ---------------------------------------------------------------------------
// URL safety predicates — Robert composes these BEFORE handing the
// candidate to the canonical enforceOpportunityPolicy gate. They are
// deliberately strict (true means "drop").
// ---------------------------------------------------------------------------

const PLACEHOLDER_HOST_PATTERNS = [
  /^example\./i, /\.example\./i,
  /^localhost(?::|$)/i,
  /^test\./i, /\.test$/i,
  /^staging\./i,
  /\.local$/i,
  /^placeholder/i,
  /yourcompany|your-company|yourdomain|your-domain/i,
]

const SEARCH_ENGINE_HOSTS = new Set([
  'google.com', 'www.google.com', 'google.co', 'www.google.co',
  'bing.com', 'www.bing.com',
  'duckduckgo.com', 'www.duckduckgo.com',
  'search.yahoo.com', 'yahoo.com',
  'baidu.com', 'www.baidu.com',
])

const PLACEHOLDER_TEXT_FRAGMENTS = [
  /lorem ipsum/i,
  /\bplaceholder\b/i,
  /\btest\s+content\b/i,
  /\bsample\s+(?:opportunity|grant)\b/i,
  /\bexample\s+grant\b/i,
  /\bxxxxx/i,
  /\bTBD\b|\bto\s+be\s+determined\b/i,
]

export function isPlaceholderUrl(url) {
  if (!url || typeof url !== 'string') return true
  if (!/^https?:\/\//i.test(url)) return true
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { return true }
  return PLACEHOLDER_HOST_PATTERNS.some((re) => re.test(host))
}

export function isSearchEngineUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const u = new URL(url)
    if (SEARCH_ENGINE_HOSTS.has(u.hostname.toLowerCase())) return true
    // Google-style search paths
    if (/\/search(?:\b|$)/i.test(u.pathname)) return true
    if (/\/url\?/i.test(u.pathname)) return true
    return false
  } catch { return false }
}

export function isPlaceholderText(text) {
  if (!text || typeof text !== 'string') return false
  return PLACEHOLDER_TEXT_FRAGMENTS.some((re) => re.test(text))
}

const LOAN_TERMS = /\b(loan|loans|microloan|interest[-\s]?bearing|repayable|repay\s+(?:over|within)|principal\s+plus|amortization|amortisation|note\s+payable|line\s+of\s+credit)\b/i
const MATCHING_FUND_TERMS = /\b(matching\s+funds?|cost[-\s]?share|match\s+required|requires?\s+a?\s*\d+%?\s*match|dollar[-\s]?for[-\s]?dollar|in[-\s]?kind\s+match|\bmatch:\s*\d)/i

export function isProbableLoanProduct(opp) {
  if (!opp) return false
  const blob = `${opp.title || ''} ${opp.description || ''} ${opp.amount_description || ''} ${opp.eligibility || ''}`
  return LOAN_TERMS.test(blob)
}

export function isProbableMatchingFunds(opp) {
  if (!opp) return false
  const blob = `${opp.title || ''} ${opp.description || ''} ${opp.amount_description || ''} ${opp.eligibility || ''}`
  return MATCHING_FUND_TERMS.test(blob)
}

export function isExpiredDeadline(deadline, deadlineType, { now = new Date() } = {}) {
  if (!deadline) return false
  const t = String(deadlineType || '').toLowerCase()
  if (t === 'rolling' || t === 'unknown' || t === 'open' || t === 'continuous') return false
  const ts = Date.parse(deadline)
  if (!Number.isFinite(ts)) return false
  return ts < now.getTime()
}

// ---------------------------------------------------------------------------
// Domain rate limiter — operates on an INJECTED DB so the unit tests can
// pass an in-memory shim. The window is a rolling hour bucket.
// ---------------------------------------------------------------------------
export async function checkRateLimit(db, domain, { perHour = 60, now = new Date() } = {}) {
  if (!db?.prepare || !domain) return { ok: true, allowed: 1 }
  const row = await db.prepare('SELECT * FROM robert_domain_rate_limits WHERE domain = ?').get(domain)
  if (!row) return { ok: true, allowed: perHour }
  if (row.blocked_until && Date.parse(row.blocked_until) > now.getTime()) {
    return { ok: false, reason: 'blocked', blocked_until: row.blocked_until }
  }
  const windowStart = Date.parse(row.window_start) || now.getTime()
  const elapsed = now.getTime() - windowStart
  if (elapsed >= 60 * 60 * 1000) {
    // window rolled
    return { ok: true, allowed: perHour }
  }
  if ((row.request_count || 0) >= perHour) {
    return { ok: false, reason: 'rate_limited', allowed: 0 }
  }
  return { ok: true, allowed: perHour - (row.request_count || 0) }
}

export async function recordDomainHit(db, domain, { now = new Date(), error = null } = {}) {
  if (!db?.prepare || !domain) return
  const existing = await db.prepare('SELECT * FROM robert_domain_rate_limits WHERE domain = ?').get(domain)
  if (!existing) {
    await db.prepare(
      `INSERT INTO robert_domain_rate_limits (domain, window_start, request_count, last_request_at, last_error)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(domain, now.toISOString(), 1, now.toISOString(), error || null)
    return
  }
  const ws = Date.parse(existing.window_start) || now.getTime()
  const rolled = (now.getTime() - ws) >= 60 * 60 * 1000
  await db.prepare(
    `UPDATE robert_domain_rate_limits
        SET window_start = ?, request_count = ?, last_request_at = ?, last_error = ?
      WHERE domain = ?`,
  ).run(
    rolled ? now.toISOString() : existing.window_start,
    rolled ? 1 : (existing.request_count || 0) + 1,
    now.toISOString(),
    error || existing.last_error || null,
    domain,
  )
}

export const __testing__ = {
  PLACEHOLDER_HOST_PATTERNS,
  SEARCH_ENGINE_HOSTS,
  PLACEHOLDER_TEXT_FRAGMENTS,
  LOAN_TERMS,
  MATCHING_FUND_TERMS,
}
