#!/usr/bin/env node
/**
 * laptop-connector / capture.js
 *
 * The local half of the in-app "Capture login session" button.
 *
 * The GrantFlow web app can't open your browser (it runs in the cloud), so when
 * you click "Capture login session" on a portal it queues a request. This tool —
 * running on your laptop — polls those pending requests, opens the real login
 * page for each, lets YOU complete username/password + 2FA, then captures the
 * resulting browser session (cookies) and uploads it. Hamilton reuses that
 * session to act inside the portal for that ONE profile, without ever seeing
 * your password or 2FA code, and without making you re-do 2FA every run.
 *
 * Usage (from the repo root, so playwright resolves):
 *   node tools/laptop-connector/capture.js            # process current pending requests
 *   node tools/laptop-connector/capture.js --watch    # keep polling every 20s
 *
 * Auth: LAPTOP_CONNECTOR_TOKEN (or ADMIN_TOKEN) = your GrantFlow access/admin token.
 * API:  LAPTOP_CONNECTOR_API or config.apiBaseUrl = backend URL.
 */

import { chromium } from 'playwright'
import readline from 'node:readline'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

async function loadConfig() {
  for (const file of [path.join(HERE, 'config.json'), path.join(HERE, 'config.example.json')]) {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch { /* try next */ }
  }
  return {}
}

function waitForEnter(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(promptText, () => { rl.close(); resolve() }))
}

async function api(method, url, token, body) {
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  let parsed = null
  try { parsed = await r.json() } catch { parsed = null }
  return { ok: r.ok, status: r.status, body: parsed }
}

function printDisclaimer(d) {
  if (!d) return
  console.log('\n  ── What this does ─────────────────────────────────────────')
  if (d.what) console.log('   •', d.what)
  if (d.why) console.log('   •', d.why)
  if (d.scope) console.log('   •', d.scope)
  console.log('  ───────────────────────────────────────────────────────────\n')
}

async function captureOne(apiBase, token, request, disclaimer) {
  const loginUrl =
    request.login_url ||
    (request.portal_host ? `https://${request.portal_host}/` : null)
  if (!loginUrl) {
    console.warn(`  [skip] request ${request.id} has no login URL or portal host`)
    return false
  }

  console.log(`\n▶ Capture for profile ${request.profile_id} @ ${request.portal_host}`)
  console.log(`  ${request.label || request.portal_host}`)
  printDisclaimer(disclaimer)

  // Best-effort: tell the backend we've opened the browser (UI shows "in progress").
  await api('POST', `${apiBase}/api/hamilton/automation/sessions/capture-requests/${request.id}/launched`, token).catch(() => {})

  const browser = await chromium.launch({ headless: false })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    console.log(`  Opening ${loginUrl}`)
    console.log('  → Log in and complete 2FA in the window. Navigate until fully signed in.')
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await waitForEnter('  When fully logged in, return here and press Enter to capture… ')
    const storageState = await context.storageState()
    if (!storageState.cookies?.length && !storageState.origins?.length) {
      console.warn('  Captured an empty session — did the login complete? Skipping this one.')
      return false
    }
    console.log(`  Captured ${storageState.cookies.length} cookies across ${storageState.origins.length} origins.`)

    const expiresAt = new Date(Date.now() + 14 * 86400_000).toISOString()
    const res = await api('POST', `${apiBase}/api/hamilton/automation/sessions/import`, token, {
      profileId: request.profile_id,
      portal_host: request.portal_host,
      storage_state: storageState,
      label: request.label || `${request.portal_host} session`,
      authentication_strategy: 'imported_session',
      expires_at: expiresAt,
      capture_request_id: request.id, // backend verifies this matches the profile
      metadata: { imported_via: 'laptop-connector-capture' },
    })
    if (!res.ok) {
      console.error(`  Import failed (${res.status}):`, JSON.stringify(res.body))
      return false
    }
    console.log(`  ✅ Session imported for profile ${request.profile_id} @ ${request.portal_host} (until ${expiresAt}).`)
    return true
  } finally {
    await browser.close().catch(() => {})
  }
}

async function pollOnce(apiBase, token) {
  const res = await api('GET', `${apiBase}/api/hamilton/automation/sessions/capture-requests?status=pending`, token)
  if (!res.ok) {
    console.error(`Could not list capture requests (${res.status}):`, JSON.stringify(res.body))
    return 0
  }
  const requests = res.body?.requests || []
  const disclaimer = res.body?.disclaimer || null
  if (requests.length === 0) {
    console.log('No pending capture requests.')
    return 0
  }
  console.log(`${requests.length} pending capture request(s).`)
  let done = 0
  for (const request of requests) {
    try {
      if (await captureOne(apiBase, token, request, disclaimer)) done += 1
    } catch (err) {
      console.warn(`  error on request ${request.id}: ${err?.message || err}`)
    }
  }
  return done
}

async function main() {
  const watch = process.argv.includes('--watch')
  const cfg = await loadConfig()
  const apiBase = (process.env.LAPTOP_CONNECTOR_API || cfg.apiBaseUrl || '').replace(/\/+$/, '')
  const token = process.env.LAPTOP_CONNECTOR_TOKEN || process.env.ADMIN_TOKEN || cfg.token || ''
  if (!apiBase || /YOUR-GRANTFLOW/.test(apiBase)) {
    throw new Error('Set apiBaseUrl (config.json) or LAPTOP_CONNECTOR_API env to your backend URL.')
  }
  if (!token) {
    throw new Error('Set LAPTOP_CONNECTOR_TOKEN (or ADMIN_TOKEN) to your GrantFlow token.')
  }

  console.log(`[capture] backend=${apiBase} watch=${watch}`)
  if (!watch) {
    await pollOnce(apiBase, token)
    console.log('[capture] done.')
    return
  }
  // Watch mode: poll forever. A capture window blocks on your Enter, so this is
  // serial by design — one login at a time, no surprise pop-ups.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pollOnce(apiBase, token)
    await new Promise((r) => setTimeout(r, 20_000))
  }
}

main().catch((err) => {
  console.error('[capture] FATAL:', err?.message || err)
  process.exit(1)
})
