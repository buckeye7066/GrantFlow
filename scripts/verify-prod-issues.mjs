/**
 * Minimal verification script for production-issue fixes.
 *
 * Usage:
 *   node scripts/verify-prod-issues.mjs
 *
 * Env:
 *   API_BASE_URL=http://localhost:8080
 *   ADMIN_TOKEN=... (optional; enables authenticated checks)
 */
const baseUrl = (process.env.API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '')
const adminToken = (process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || '').trim() || null

async function request(path, { method = 'GET', headers = {}, body } = {}) {
  const url = `${baseUrl}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(adminToken ? { 'X-Admin-Token': adminToken } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status, ok: res.ok, json }
}

function assert(cond, msg) {
  if (!cond) {
    const err = new Error(msg)
    err.isAssertion = true
    throw err
  }
}

async function main() {
  console.log(`API_BASE_URL=${baseUrl}`)

  // 1) /api/auth/me without auth => 401
  {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    const body = await res.json().catch(() => ({}))
    console.log('GET /api/auth/me (no auth)', res.status, body)
    assert(res.status === 401, 'Expected GET /api/auth/me (no auth) to return 401')
  }

  if (!adminToken) {
    console.log('ADMIN_TOKEN not set; skipping authenticated checks.')
    console.log('Set ADMIN_TOKEN to verify /api/auth/me (200) and /api/crawlers/jobs (201).')
    return
  }

  // 2) /api/auth/me with admin token => 200
  {
    const { status, json } = await request('/api/auth/me')
    console.log('GET /api/auth/me (admin token)', status, json)
    assert(status === 200, 'Expected GET /api/auth/me (admin token) to return 200')
  }

  // 3) POST /api/crawlers/jobs with UI-like payload => 201 or 200 (idempotency)
  {
    const payload = {
      type: 'comprehensive',
      parameters: { mode: 'national' },
    }
    const { status, json } = await request('/api/crawlers/jobs', { method: 'POST', body: payload })
    console.log('POST /api/crawlers/jobs', status, json)
    assert(status === 201 || status === 200, 'Expected POST /api/crawlers/jobs to return 201 (or 200 if idempotent)')
    assert(json && json.id, 'Expected job response to include id')
  }

  console.log('All checks passed.')
}

main().catch((err) => {
  console.error('Verification failed:', err?.message || err)
  process.exitCode = 1
})

