/**
 * Production smoke checks (read-only).
 *
 * Usage:
 *   node scripts/smoke-prod.mjs
 *
 * Optional env:
 *   SMOKE_BASE_URL=https://app.axiombiolabs.org
 *   ADMIN_TOKEN=... (enables admin-only checks)
 */

const baseUrl = (process.env.SMOKE_BASE_URL || 'https://app.axiombiolabs.org').replace(/\/+$/, '')
const adminToken = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null

function url(path) {
  return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
}

async function getJson(path, { headers = {} } = {}) {
  const res = await fetch(url(path), { headers })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // keep null
  }
  return { res, text, json }
}

async function main() {
  const results = []

  results.push({ name: 'GET /api/health', ...(await getJson('/api/health')) })
  results.push({ name: 'GET /api/meta/build', ...(await getJson('/api/meta/build')) })

  if (adminToken) {
    results.push({
      name: 'GET /api/admin/diagnostics (admin)',
      ...(await getJson('/api/admin/diagnostics', { headers: { 'x-admin-token': adminToken } })),
    })
    results.push({
      name: 'GET /api/admin/openai/validate (admin)',
      ...(await getJson('/api/admin/openai/validate', { headers: { 'x-admin-token': adminToken } })),
    })
  } else {
    console.log('[smoke] ADMIN_TOKEN not set; skipping admin-only checks')
  }

  let failed = 0
  for (const r of results) {
    const status = r.res.status
    const ok = status >= 200 && status < 300
    if (!ok) failed += 1

    const server = r.res.headers.get('server')
    console.log(`${ok ? '✓' : '✗'} ${r.name} -> ${status}${server ? ` (server=${server})` : ''}`)
    if (!ok) {
      console.log('  body:', (r.json ? JSON.stringify(r.json).slice(0, 400) : r.text.slice(0, 400)) || '(empty)')
    }
  }

  if (failed > 0) {
    process.exit(2)
  }
  console.log('✓ Smoke checks passed')
}

main().catch((e) => {
  console.error('Smoke script failed:', e?.message || e)
  process.exit(1)
})

