import crypto from 'node:crypto'

const memoryBuckets = new Map()
const initializedDbs = new WeakSet()
let requestCounter = 0
let warnedSharedFallback = false

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function requestPath(req) {
  return String(req?.path || req?.originalUrl || '').split('?')[0]
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim())
}

function isDeterministicTestHarness(env) {
  if (isTruthy(env?.API_RATE_LIMIT_IN_TESTS)) return false
  return (
    String(env?.NODE_ENV || '').toLowerCase() === 'test' ||
    isTruthy(env?.GRANTFLOW_TEST_RUNNER)
  )
}

export function classifyApiRatePolicy(req, env = process.env) {
  // Production limits are process/database state by design. Deterministic tests
  // frequently boot several app instances in one Node process and otherwise
  // inherit one anonymous-IP bucket across unrelated cases. Keep the harness
  // isolated unless a focused rate-limit test explicitly supplies its own env.
  if (isDeterministicTestHarness(env)) return null

  const path = requestPath(req)
  const method = String(req?.method || 'GET').toUpperCase()
  if (!path.startsWith('/api/')) return null
  if (method === 'OPTIONS') return null

  const exempt = [
    '/api/health',
    '/api/version',
    '/api/meta',
    '/api/maintenance',
    '/api/media',
    '/api/stripe/webhook',
    '/api/sms/inbound',
  ]
  if (exempt.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return null

  if (
    /^\/api\/(?:ai|anya|matching|real-crawlers|crawlers|geo-crawl|laptop-connector)(?:\/|$)/.test(path)
  ) {
    return {
      name: 'cost',
      windowMs: positiveInt(env.API_COST_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
      max: positiveInt(env.API_COST_RATE_LIMIT_MAX, 40),
      shared: true,
    }
  }

  if (
    /^\/api\/(?:hamilton|application-tasks|admin\/agent-control|admin\/queue)(?:\/|$)/.test(path)
  ) {
    return {
      name: 'automation',
      windowMs: positiveInt(env.API_AUTOMATION_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
      max: positiveInt(env.API_AUTOMATION_RATE_LIMIT_MAX, 25),
      shared: true,
    }
  }

  if (/^\/api\/auth\/(?:email|phone|password|oauth)/.test(path)) {
    return {
      name: 'auth',
      windowMs: positiveInt(env.API_AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
      max: positiveInt(env.API_AUTH_RATE_LIMIT_MAX, 30),
      shared: false,
    }
  }

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return {
      name: 'mutation',
      windowMs: positiveInt(env.API_MUTATION_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
      max: positiveInt(env.API_MUTATION_RATE_LIMIT_MAX, 120),
      shared: false,
    }
  }

  return {
    name: 'standard',
    windowMs: positiveInt(env.API_STANDARD_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    max: positiveInt(env.API_STANDARD_RATE_LIMIT_MAX, 600),
    shared: false,
  }
}

function principalFor(req) {
  const userId = req?.ctx?.userId || req?.user?.userId || req?.user?.id || null
  if (userId) return `user:${String(userId)}`
  return `ip:${String(req?.ip || req?.socket?.remoteAddress || 'unknown')}`
}

function bucketKey(req, policy) {
  return crypto
    .createHash('sha256')
    .update(`${policy.name}|${principalFor(req)}`)
    .digest('hex')
}

function pruneMemory(now) {
  requestCounter += 1
  if (requestCounter % 500 !== 0) return
  for (const [key, value] of memoryBuckets) {
    if (value.expiresMs <= now) memoryBuckets.delete(key)
  }
}

function hitMemory(key, policy, now) {
  pruneMemory(now)
  let row = memoryBuckets.get(key)
  if (!row || row.expiresMs <= now) {
    row = { count: 0, expiresMs: now + policy.windowMs }
  }
  row.count += 1
  memoryBuckets.set(key, row)
  return { count: row.count, expiresMs: row.expiresMs }
}

async function ensureSharedTable(db) {
  if (!db || initializedDbs.has(db)) return
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS api_rate_limit_buckets (
      bucket_key TEXT PRIMARY KEY,
      window_started_ms BIGINT NOT NULL,
      expires_ms BIGINT NOT NULL,
      hit_count INTEGER NOT NULL
    )
  `).run()
  initializedDbs.add(db)
}

async function hitShared(db, key, policy, now) {
  await ensureSharedTable(db)
  const expires = now + policy.windowMs
  const row = await db.prepare(`
    INSERT INTO api_rate_limit_buckets
      (bucket_key, window_started_ms, expires_ms, hit_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT (bucket_key) DO UPDATE SET
      window_started_ms = CASE
        WHEN api_rate_limit_buckets.expires_ms <= ?
        THEN excluded.window_started_ms
        ELSE api_rate_limit_buckets.window_started_ms
      END,
      expires_ms = CASE
        WHEN api_rate_limit_buckets.expires_ms <= ?
        THEN excluded.expires_ms
        ELSE api_rate_limit_buckets.expires_ms
      END,
      hit_count = CASE
        WHEN api_rate_limit_buckets.expires_ms <= ?
        THEN 1
        ELSE api_rate_limit_buckets.hit_count + 1
      END
    RETURNING hit_count, expires_ms
  `).get(key, now, expires, now, now, now)

  return {
    count: Number(row?.hit_count || 0),
    expiresMs: Number(row?.expires_ms || expires),
  }
}

function applyHeaders(res, policy, hit, now) {
  const remaining = Math.max(0, policy.max - hit.count)
  const resetSeconds = Math.max(1, Math.ceil((hit.expiresMs - now) / 1000))
  res.setHeader?.('RateLimit-Limit', String(policy.max))
  res.setHeader?.('RateLimit-Remaining', String(remaining))
  res.setHeader?.('RateLimit-Reset', String(resetSeconds))
  return resetSeconds
}

export function apiRateLimitMiddleware({
  env = process.env,
  clock = () => Date.now(),
} = {}) {
  return async function apiRateLimit(req, res, next) {
    const policy = classifyApiRatePolicy(req, env)
    if (!policy) return next()

    const now = clock()
    const key = bucketKey(req, policy)
    let hit

    if (policy.shared && req?.db) {
      try {
        hit = await hitShared(req.db, key, policy, now)
      } catch (error) {
        if (!warnedSharedFallback) {
          warnedSharedFallback = true
          console.warn('[rate-limit] shared store unavailable; using process-local fallback:', error?.message || error)
        }
        hit = hitMemory(key, policy, now)
      }
    } else {
      hit = hitMemory(key, policy, now)
    }

    const resetSeconds = applyHeaders(res, policy, hit, now)
    if (hit.count <= policy.max) return next()

    res.setHeader?.('Retry-After', String(resetSeconds))
    return res.status(429).json({
      ok: false,
      error: 'rate_limit_exceeded',
      rate_limit_policy: policy.name,
      retry_after_seconds: resetSeconds,
    })
  }
}

export function resetApiRateLimitStateForTests() {
  memoryBuckets.clear()
  requestCounter = 0
  warnedSharedFallback = false
}

export default { apiRateLimitMiddleware, classifyApiRatePolicy }
