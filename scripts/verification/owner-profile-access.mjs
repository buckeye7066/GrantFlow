#!/usr/bin/env node
/**
 * Evidence: "correct owner(s)" can access Axiom + Focus Forward.
 *
 * We use the dev-only preview_token from password reset to obtain a real access token,
 * then call the canonical profile list endpoint with scope=mine.
 *
 * Env:
 * - VERIFY_BACKEND_BASE_URL (default http://127.0.0.1:19181)
 * - OWNER_EMAIL (default buckeye7066@gmail.com)
 */
import process from 'node:process'

const BASE = process.env.VERIFY_BACKEND_BASE_URL || 'http://127.0.0.1:19181'
const EMAIL = process.env.OWNER_EMAIL || 'buckeye7066@gmail.com'

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function getJson(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function run() {
  // Start reset to get preview token (dev mode, email not configured)
  const start = await postJson('/api/auth/password/reset/start', { email: EMAIL })
  if (start.status !== 202 || !start.json?.preview_token) {
    throw new Error(`reset/start failed: ${start.status} ${JSON.stringify(start.json)}`)
  }
  const token = String(start.json.preview_token)

  // Complete setup with a strong password to obtain access token
  const password = `TempPass!${Math.floor(Math.random() * 1e6)}Aa`
  const complete = await postJson('/api/auth/password/setup/complete', { token, password })
  if (complete.status !== 200 || !complete.json?.accessToken) {
    throw new Error(`setup/complete failed: ${complete.status} ${JSON.stringify(complete.json)}`)
  }
  const accessToken = String(complete.json.accessToken)

  const mine = await getJson('/api/profiles?scope=mine', { Authorization: `Bearer ${accessToken}` })
  if (mine.status !== 200 || !Array.isArray(mine.json)) {
    throw new Error(`profiles?scope=mine failed: ${mine.status} ${JSON.stringify(mine.json)}`)
  }

  const ids = new Set(mine.json.map((p) => String(p?.id || '')).filter(Boolean))
  const required = ['profile-axiom-biolabs', 'profile-focus-forward-ministries']
  const present = required.reduce((acc, id) => ({ ...acc, [id]: ids.has(id) }), {})

  console.log(
    JSON.stringify(
      {
        ok: true,
        backend: BASE,
        owner_email: EMAIL,
        auth: {
          reset_start_status: start.status,
          setup_complete_status: complete.status,
          token_type: complete.json?.tokenType || null,
          active_profile_id: complete.json?.user?.activeProfileId || null,
        },
        profiles_mine_count: mine.json.length,
        required_profiles_present: present,
        profiles_mine_sample: mine.json
          .filter((p) => required.includes(String(p?.id || '')))
          .map((p) => ({ id: p.id, display_name: p.display_name, status: p.status })),
      },
      null,
      2,
    ),
  )
}

run().catch((err) => {
  console.error('[owner-profile-access] failed:', err?.stack || err)
  process.exit(1)
})

