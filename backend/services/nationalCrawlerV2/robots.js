import crypto from 'crypto'

function sha1(text) {
  return crypto.createHash('sha1').update(text || '').digest('hex')
}

function parseRobots(text) {
  const lines = (text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

  const rules = []
  let currentAgents = []

  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()

    if (key === 'user-agent') {
      const ua = value.toLowerCase()
      // If the previous token was a directive (not user-agent), a new group is
      // starting â reset currentAgents so groups don't bleed into each other.
      if (!lastKeyWasUserAgent) {
        currentAgents = []
      }
      currentAgents.push(ua)
      lastKeyWasUserAgent = true
      continue
    }

    // Any directive (allow/disallow) means the next user-agent starts a new group.
    lastKeyWasUserAgent = false

    if (key === 'disallow') {
      // Empty Disallow means 'allow everything' â skip storing a rule.
      if (!value) continue
      const agentsForRule = currentAgents.length ? [...currentAgents] : ['*']
      rules.push({ agents: agentsForRule, type: 'disallow', path: value })
    }

    if (key === 'allow') {
      const path = value
      const agentsForRule = currentAgents.length ? [...currentAgents] : ['*']
      rules.push({ agents: agentsForRule, type: 'allow', path })
    }
  }

  return rules
}

function pathOf(url) {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return '/'
  }
}

function hostOf(url) {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

export class RobotsCache {
  constructor({ ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs
    this.cache = new Map()
  }

  async canFetch({ fetcher, url, userAgent = '*' }) {
    const origin = hostOf(url)
    if (!origin) return true
    const now = Date.now()
    const key = sha1(origin)

    const cached = this.cache.get(key)
    if (cached && now - cached.at < this.ttlMs) {
      return this._evaluate(cached.rules, url, userAgent)
    }

    // default allow if robots fetch fails (but still polite)
    let rules = []
    try {
      const robotsUrl = `${origin}/robots.txt`
      const res = await fetcher.fetch(robotsUrl, { timeoutMs: 8000 })
      if (res?.ok) {
        const text = await res.text()
        rules = parseRobots(text)
      }
    } catch (err) {
      console.warn(`Failed to fetch robots.txt for ${origin}:`, err.message)
      rules = []
    }

    this.cache.set(key, { at: now, rules })
    return this._evaluate(rules, url, userAgent)
  }

  _evaluate(rules, url, userAgent) {
    const ua = (userAgent || '*').toLowerCase()
    const p = pathOf(url)
    const applicable = rules.filter((r) => r.agents.includes('*') || r.agents.includes(ua))
    if (applicable.length === 0) return true

    // Simplified: choose the longest matching rule (allow wins if same length)
    let best = null
    for (const rule of applicable) {
      if (!rule.path) continue
      if (!p.startsWith(rule.path)) continue
      if (!best) best = rule
      else if (rule.path.length > best.path.length) best = rule
      else if (rule.path.length === best.path.length && rule.type === 'allow') best = rule
    }

    if (!best) return true
    return best.type !== 'disallow'
  }
}

