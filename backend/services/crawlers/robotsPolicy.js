/**
 * robotsPolicy.js
 *
 * Minimal, dependency-free robots.txt politeness for GrantFlow crawlers. No
 * such utility existed; both Yana's web crawler and Robert's funding crawlers
 * should consult it before fetching a page.
 *
 * Scope: the parts of the Robots Exclusion Protocol that matter for polite
 * discovery — User-agent groups, Disallow/Allow with `*` wildcards and `$`
 * end-anchor, longest-match-wins (Allow wins ties), and Crawl-delay. It is
 * intentionally conservative and never throws.
 *
 * Fetching is injectable (`fetchText`) so it is fully testable offline. Policy:
 * if robots.txt cannot be fetched (network error / 404 / 5xx) we FAIL OPEN
 * (allowed) — the standard convention — but an explicit Disallow always blocks.
 */

const DEFAULT_UA = 'GrantFlow Crawler/1.0 (+contact: support@grantflow.app)'

/** Convert a robots path pattern (with `*` and trailing `$`) to a RegExp. */
function patternToRegExp(pattern) {
  let p = String(pattern || '')
  let anchored = false
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1) }
  // Escape regex metacharacters except '*', then turn '*' into '.*'.
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`)
}

/**
 * Parse robots.txt into per-user-agent rule groups. A blank User-agent or a
 * group with no path rules is ignored. Returns:
 *   { agents: { '<ua-lowercase>': { allow:[], disallow:[], crawlDelay:number|null } } }
 */
export function parseRobots(text) {
  const agents = {}
  let current = [] // user-agents this block applies to
  let sawRuleSinceAgent = false

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const field = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()

    if (field === 'user-agent') {
      // A new user-agent line after rules starts a fresh group.
      if (sawRuleSinceAgent) { current = []; sawRuleSinceAgent = false }
      const ua = value.toLowerCase()
      if (!agents[ua]) agents[ua] = { allow: [], disallow: [], crawlDelay: null }
      current.push(ua)
      continue
    }
    if (current.length === 0) continue // directive with no preceding user-agent

    if (field === 'disallow') {
      sawRuleSinceAgent = true
      for (const ua of current) agents[ua].disallow.push(value)
    } else if (field === 'allow') {
      sawRuleSinceAgent = true
      for (const ua of current) agents[ua].allow.push(value)
    } else if (field === 'crawl-delay') {
      sawRuleSinceAgent = true
      const n = Number(value)
      if (Number.isFinite(n) && n >= 0) for (const ua of current) agents[ua].crawlDelay = n
    }
  }
  return { agents }
}

/** Pick the rule group for a UA: exact-ish token match, else `*`, else empty. */
function rulesForAgent(parsed, userAgent) {
  const agents = parsed?.agents || {}
  const ua = String(userAgent || '').toLowerCase()
  // Match the most specific declared agent token that appears in our UA string.
  let best = null
  for (const declared of Object.keys(agents)) {
    if (declared === '*') continue
    if (declared && ua.includes(declared)) {
      if (!best || declared.length > best.length) best = declared
    }
  }
  if (best) return agents[best]
  if (agents['*']) return agents['*']
  return { allow: [], disallow: [], crawlDelay: null }
}

/**
 * Is `path` allowed for `userAgent` given robots.txt `text`? Longest matching
 * rule wins; Allow wins a length tie; an empty Disallow value means "allow all".
 * Default (no matching rule) is allowed.
 */
export function isPathAllowed(text, path, userAgent = DEFAULT_UA) {
  const rules = rulesForAgent(parseRobots(text), userAgent)
  const target = path && path.startsWith('/') ? path : `/${path || ''}`

  let best = { len: -1, allow: true }
  const consider = (value, allow) => {
    if (value === '') return // empty Disallow = allow everything; contributes no block
    const re = patternToRegExp(value)
    if (re.test(target)) {
      const len = value.replace(/\$$/, '').length
      if (len > best.len || (len === best.len && allow)) best = { len, allow }
    }
  }
  for (const d of rules.disallow) consider(d, false)
  for (const a of rules.allow) consider(a, true)
  return best.allow
}

/** Crawl-delay (seconds) declared for this UA, or null. */
export function crawlDelayFor(text, userAgent = DEFAULT_UA) {
  return rulesForAgent(parseRobots(text), userAgent).crawlDelay
}

/**
 * Fetch + evaluate robots.txt for a full URL. `fetchText(robotsUrl)` must
 * resolve to { ok:boolean, text:string } (injected in tests / wired to the
 * crawler HTTP client in production). Fails open on fetch failure.
 *
 * @returns {Promise<{allowed:boolean, crawlDelay:number|null, reason:string}>}
 */
export async function isUrlAllowed(url, { fetchText, userAgent = DEFAULT_UA } = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, crawlDelay: null, reason: 'invalid_url' }
  }
  if (typeof fetchText !== 'function') {
    return { allowed: true, crawlDelay: null, reason: 'no_fetcher_assumed_allowed' }
  }
  const robotsUrl = `${parsed.origin}/robots.txt`
  let res
  try {
    res = await fetchText(robotsUrl)
  } catch {
    return { allowed: true, crawlDelay: null, reason: 'robots_fetch_error_fail_open' }
  }
  if (!res || res.ok !== true || typeof res.text !== 'string' || res.text.trim() === '') {
    return { allowed: true, crawlDelay: null, reason: 'no_robots_fail_open' }
  }
  const allowed = isPathAllowed(res.text, parsed.pathname + parsed.search, userAgent)
  return {
    allowed,
    crawlDelay: crawlDelayFor(res.text, userAgent),
    reason: allowed ? 'allowed_by_robots' : 'disallowed_by_robots',
  }
}

export const __testing__ = { patternToRegExp, rulesForAgent, DEFAULT_UA }
