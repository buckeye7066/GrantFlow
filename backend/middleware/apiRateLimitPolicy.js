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

  // Read-only crawler-job TELEMETRY is not a cost driver. `crawler_jobs` reads
  // are plain DB lookups and are already wrapped in responseCache(30s), but the
  // bucket key below is hash(policy|principal) — it ignores method and path, so
  // every dashboard poll of GET /api/crawlers/jobs spent the SAME 40-per-10-min
  // budget the operator needs to actually START a crawl. An admin page left open
  // therefore 429'd real "Run now" clicks with nobody touching anything
  // (observed in production 2026-08-06). Charge these reads to the ordinary
  // read budget instead. The expensive lane below is unchanged: every POST that
  // starts a crawl, and every /api/ai, /api/anya, and /api/real-crawlers call,
  // still gets the full 'cost' treatment.
  if (method === 'GET' && /^\/api\/crawlers\/jobs(?:\/|$)/.test(path)) {
    return {
      name: 'standard',
      windowMs: positiveInt(env.API_STANDARD_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
      max: positiveInt(env.API_STANDARD_RATE_LIMIT_MAX, 600),
      shared: true,
      requiredShared: false,
    }
  }

  // SmartMatcher / Discover matching reads are product UI (DB score + catalog),
  // not crawl/LLM spend. Keeping them on the shared 'cost' bucket (40 / 10 min)
  // meant a normal SmartMatcher session — load opportunities, tweak filters,
  // refetch after interpret — burned the same budget as Anya chat + crawl
  // starts, so POST /interpret-intent 429'd under legitimate use (Axiom
  // production 2026-08-20). Mirror the crawler-jobs carve-out: charge GETs to
  // the ordinary read budget; keep expensive AI/crawl lanes on 'cost'.
  if (method === 'GET' && /^\/api\/matching(?:\/|$)/.test(path)) {
    return {
      name: 'standard',
      windowMs: positiveInt(env.API_STANDARD_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
      max: positiveInt(env.API_STANDARD_RATE_LIMIT_MAX, 600),
      shared: true,
      requiredShared: false,
    }
  }

  // User-initiated intent parse (SmartMatcher "Understand & search"). Optional
  // OpenAI, auth-gated, one click. Must NOT share the crawl/AI 'cost' bucket —
  // that is what made a single button hit 429 after ordinary page reads. Use
  // the mutation lane (still per-user, still capped) so abuse is not free.
  if (method === 'POST' && /^\/api\/matching\/interpret-intent\/?$/.test(path)) {
    return {
      name: 'mutation',
      windowMs: positiveInt(env.API_MUTATION_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
      max: positiveInt(env.API_MUTATION_RATE_LIMIT_MAX, 120),
      shared: true,
      requiredShared: false,
    }
  }

  // `matching` stays on the paid/security 'cost' lane. The two carve-outs
  // ABOVE (GET /api/matching, POST /interpret-intent) run first and take the
  // product-UI traffic off this budget, which is what fixed the 2026-08-20
  // 429s. Dropping `matching` from the lane ENTIRELY, as an earlier pass did,
  // also dropped `requiredShared: true` from every other matching POST - and
  // api-rate-limit-shared-authority asserts that a paid-work lane must carry
  // the cross-instance authority, because a per-instance bucket is not a limit
  // at all once the service runs more than one process.
  if (
    /^\/api\/(?:ai|anya|matching|real-crawlers|crawlers|geo-crawl|laptop-connector)(?:\/|$)/.test(path)
  ) {
    return {
      name: 'cost',
      windowMs: positiveInt(env.API_COST_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
      max: positiveInt(env.API_COST_RATE_LIMIT_MAX, 40),
      shared: true,
      requiredShared: true,
    }
  }

  // Live co-browse interaction lane — MUST be classified before the general
  // hamilton/automation bucket. The cloud-login live viewer relays ONE POST per
  // mouse/key event and holds one long-lived SSE screencast GET. Classified as
  // 'automation' (25 req / 10 min, shared) these burned the entire budget the
  // moment the user MOVED THE MOUSE toward the sign-in button: every input then
  // 429'd ("the live page stopped accepting your clicks") and the stream
  // reconnect 429'd too (stream_http_429 → "the live connection ended") — the
  // 2026-07-31 MTSU live-login report. These endpoints are cheap (one CDP
  // dispatch / one stream attach), already triple-gated (auth + profile access
  // + live-session existence), and human-bounded, so they get a real-time
  // per-user budget instead. Deliberately shared:false — a DB write per mouse
  // event would be its own outage.
  // Also the live-view frame poll (GET /tasks/:taskId/live-frame): the watch
  // window fetches it at a few frames/sec to show Hamilton filling the portal,
  // which would exhaust the 600/15min standard read budget in ~seconds. Same
  // class as cloud-login stream — cheap (one in-memory read), triple-gated
  // (auth + profile access + task ownership), human-bounded.
  if (/^\/api\/hamilton\/automation\/(?:sessions\/cloud-login\/[^/]+\/(?:input|stream)|tasks\/[^/]+\/live-frame)$/.test(path)) {
    return {
      name: 'live_interaction',
      windowMs: positiveInt(env.API_LIVE_INTERACTION_RATE_LIMIT_WINDOW_MS, 60 * 1000),
      max: positiveInt(env.API_LIVE_INTERACTION_RATE_LIMIT_MAX, 1800),
      shared: false,
    }
  }

  // The automation WATCH window polls GET /api/hamilton/automation/tasks (and
  // readiness / authorizations / status) on a live cadence to show the run in
  // progress. Those are plain read-only DB lookups, NOT run starts — but the
  // block below charged every /api/hamilton request to the 25-per-10-min
  // 'automation' budget (which exists to throttle the EXPENSIVE POST that
  // launches a run), so the live view 429'd with rate_limit_exceeded after ~25
  // polls (the owner hit this on a real run, 2026-08-21). Mirror the
  // /api/matching + crawler-jobs carve-outs already in this file: GET reads of
  // Hamilton/application-task status go on the ordinary 'standard' read budget;
  // every POST that actually drives a run stays on 'automation' below.
  if (
    method === 'GET'
    && /^\/api\/(?:hamilton|application-tasks)(?:\/|$)/.test(path)
  ) {
    return {
      name: 'standard',
      windowMs: positiveInt(env.API_STANDARD_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
      max: positiveInt(env.API_STANDARD_RATE_LIMIT_MAX, 600),
      shared: true,
      requiredShared: false,
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
      requiredShared: true,
    }
  }

  if (/^\/api\/auth\/(?:email|phone|password|oauth)/.test(path)) {
    return {
      name: 'auth',
      windowMs: positiveInt(env.API_AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
      max: positiveInt(env.API_AUTH_RATE_LIMIT_MAX, 30),
      shared: true,
      requiredShared: true,
    }
  }

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return {
      name: 'mutation',
      windowMs: positiveInt(env.API_MUTATION_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
      max: positiveInt(env.API_MUTATION_RATE_LIMIT_MAX, 120),
      shared: true,
      // Ordinary product mutations are bounded but not paid/security lanes.
      // Prefer the cross-instance bucket; if a rolling/minimal deployment has
      // not provisioned it yet, retain availability through the same bounded
      // process-local fallback as standard reads. Auth, cost, and automation
      // policies above remain requiredShared and continue to fail closed.
      requiredShared: false,
    }
  }

  return {
    name: 'standard',
    windowMs: positiveInt(env.API_STANDARD_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    max: positiveInt(env.API_STANDARD_RATE_LIMIT_MAX, 600),
    shared: true,
    requiredShared: false,
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
  // Schema belongs to paired migrations (SQLite 172 / PostgreSQL 0177), not
  // request-time self-healing DDL. A missing table is a deploy-integrity fault
  // and security-sensitive lanes fail closed below instead of silently creating
  // a divergent schema on one instance.
  await db.prepare('SELECT bucket_key FROM api_rate_limit_buckets LIMIT 1').get()
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
          console.warn(
            policy.requiredShared
              ? '[rate-limit] required shared store unavailable; failing closed:'
              : '[rate-limit] shared store unavailable; using process-local fallback:',
            error?.message || error,
          )
        }
        if (policy.requiredShared) {
          return res.status(503).json({
            ok: false,
            error: 'rate_limit_store_unavailable',
            rate_limit_policy: policy.name,
            retryable: true,
          })
        }
        hit = hitMemory(key, policy, now)
      }
    } else if (policy.shared && policy.requiredShared) {
      return res.status(503).json({
        ok: false,
        error: 'rate_limit_store_unavailable',
        rate_limit_policy: policy.name,
        retryable: true,
      })
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
