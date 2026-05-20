#!/usr/bin/env node
/**
 * Merge all like/similar duplicate profiles in production (admin only).
 *
 * Required env:
 *   GF_API   e.g. https://grantflow-production.up.railway.app/api
 *   GF_TOKEN admin Bearer token (from /api/auth/password/login)
 *
 * Optional env:
 *   GF_DEDUPE_STRATEGIES  comma-separated, default similar_name,exact_name
 *
 * Usage:
 *   node scripts/admin-dedupe-all-profiles.mjs           # dry-run preview
 *   node scripts/admin-dedupe-all-profiles.mjs --apply   # merge for real
 */
const API = (process.env.GF_API || process.env.DEDUPE_BASE_URL || 'https://grantflow-production.up.railway.app/api').replace(/\/+$/, '')
const TOKEN = process.env.GF_TOKEN || process.env.ADMIN_TOKEN || null
const APPLY = process.argv.includes('--apply')
const STRATEGIES = String(process.env.GF_DEDUPE_STRATEGIES || 'similar_name,exact_name')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
}

async function fetchJson(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers || {}) },
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text }
  }
  return { ok: res.ok, status: res.status, body }
}

async function loginWithPassword(email, password) {
  const res = await fetch(`${API}/auth/password/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body?.accessToken) {
    throw new Error(`Login failed (${res.status}): ${body?.error || body?.message || 'missing accessToken'}`)
  }
  return body.accessToken
}

async function main() {
  if (!TOKEN) {
    const email = process.env.GF_ADMIN_EMAIL
    const password = process.env.GF_ADMIN_PASSWORD
    if (email && password) {
      HEADERS.Authorization = `Bearer ${await loginWithPassword(email, password)}`
    } else {
      console.error('Missing GF_TOKEN (or GF_ADMIN_EMAIL + GF_ADMIN_PASSWORD)')
      process.exit(2)
    }
  }

  console.log(`[dedupe-all] api=${API} apply=${APPLY} strategies=${STRATEGIES.join(',')}`)

  for (const strategy of STRATEGIES) {
    const preview = await fetchJson(
      `/admin/profiles/duplicates?strategy=${encodeURIComponent(strategy)}&limitGroups=500&minGroupSize=2`,
    )
    if (!preview.ok) {
      console.error(`[dedupe-all] preview failed for ${strategy}:`, preview.status, preview.body)
      process.exit(1)
    }
    const groups = preview.body?.groups || []
    console.log(`[dedupe-all] ${strategy}: ${groups.length} group(s)`)
    for (const group of groups) {
      console.log(
        `  - ${group.key}: keep=${group.winner?.display_name} (${group.winner?.id}) delete=${(group.losers || [])
          .map((l) => l.display_name)
          .join(', ')}`,
      )
    }
  }

  if (!APPLY) {
    console.log('[dedupe-all] dry-run only. Re-run with --apply to merge.')
    return
  }

  const apply = await fetchJson('/admin/profiles/deduplicate', {
    method: 'POST',
    body: JSON.stringify({
      strategies: STRATEGIES,
      dryRun: false,
      limitGroups: 500,
      minGroupSize: 2,
    }),
  })

  if (!apply.ok) {
    console.error('[dedupe-all] apply failed:', apply.status, apply.body)
    process.exit(1)
  }

  console.log(`[dedupe-all] merged_groups=${apply.body?.merged_groups ?? 0}`)
  for (const result of apply.body?.results || []) {
    console.log(
      `  merged [${result.strategy}] ${result.key}: winner=${result.winnerId} losers=${(result.loserIds || []).join(', ')}`,
    )
  }

  const list = await fetchJson('/profiles?limit=500')
  if (list.ok) {
    console.log(`[dedupe-all] profiles remaining: ${Array.isArray(list.body) ? list.body.length : '?'}`)
  }
}

main().catch((error) => {
  console.error('[dedupe-all] failed:', error?.message || String(error))
  process.exit(1)
})
