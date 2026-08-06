#!/usr/bin/env node
/**
 * Verify that an explicitly identified owner can access the required profiles.
 *
 * Required env (there are deliberately no deployment or credential defaults):
 * - VERIFY_BACKEND_BASE_URL
 * - OWNER_EMAIL
 * - OWNER_ACCESS_TOKEN
 *
 * This proof is read-only. It no longer resets the owner's password or relies
 * on a development-only preview token.
 */
import process from 'node:process'

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required; refusing to contact an implicit deployment`)
  return value
}

function validatedBaseUrl(value) {
  const url = new URL(value)
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('VERIFY_BACKEND_BASE_URL must use HTTPS unless it targets loopback')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('VERIFY_BACKEND_BASE_URL must not contain credentials, query parameters, or a fragment')
  }
  return url.toString().replace(/\/$/, '')
}

const BASE = validatedBaseUrl(requiredEnv('VERIFY_BACKEND_BASE_URL'))
const EMAIL = requiredEnv('OWNER_EMAIL').toLowerCase()
const ACCESS_TOKEN = requiredEnv('OWNER_ACCESS_TOKEN')
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(EMAIL)) {
  throw new Error('OWNER_EMAIL must be a valid email address')
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function run() {
  const me = await getJson('/api/auth/me')
  if (me.status !== 200) {
    throw new Error(`auth/me failed: ${me.status}`)
  }
  const authenticatedUser = me.json?.user || me.json || {}
  const authenticatedEmail = String(
    authenticatedUser.primary_email || authenticatedUser.email || '',
  ).trim().toLowerCase()
  if (!authenticatedEmail || authenticatedEmail !== EMAIL) {
    throw new Error('OWNER_ACCESS_TOKEN did not resolve to the explicitly configured OWNER_EMAIL')
  }

  const mine = await getJson('/api/profiles?scope=mine')
  if (mine.status !== 200 || !Array.isArray(mine.json)) {
    throw new Error(`profiles?scope=mine failed: ${mine.status}`)
  }

  const ids = new Set(mine.json.map((profile) => String(profile?.id || '')).filter(Boolean))
  const required = ['profile-axiom-biolabs', 'profile-demo-faith-nonprofit']
  const present = required.reduce((acc, id) => ({ ...acc, [id]: ids.has(id) }), {})

  console.log(
    JSON.stringify(
      {
        ok: Object.values(present).every(Boolean),
        backend_origin: new URL(BASE).origin,
        owner_identity_verified: true,
        profiles_mine_count: mine.json.length,
        required_profiles_present: present,
        profiles_mine_sample: mine.json
          .filter((profile) => required.includes(String(profile?.id || '')))
          .map((profile) => ({
            id: profile.id,
            display_name: profile.display_name,
            status: profile.status,
          })),
      },
      null,
      2,
    ),
  )

  if (!Object.values(present).every(Boolean)) process.exitCode = 1
}

run().catch((error) => {
  console.error('[owner-profile-access] failed:', error?.message || error)
  process.exitCode = 1
})
