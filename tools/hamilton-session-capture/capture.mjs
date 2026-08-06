#!/usr/bin/env node
/**
 * Hamilton session capture (GENERIC — any profile, any school portal).
 *
 * You complete the login + 2FA yourself in a real browser window; this tool
 * grabs the resulting Playwright storageState (cookies + per-origin
 * localStorage, including the SSO domains) and uploads it to GrantFlow, where
 * it is stored AES-256-GCM-encrypted and reused by Hamilton to act inside the
 * real portal as you. Hamilton never sees your password or 2FA code — only the
 * already-authenticated session you hand her.
 *
 * Usage:
 *   node tools/hamilton-session-capture/capture.mjs \
 *     --api-base https://grantflow-production.up.railway.app \
 *     --token    <your GrantFlow access token> \
 *     --profile-id <profile uuid> \
 *     --portal-host mtsu.edu \
 *     --login-url  https://login.microsoftonline.com/ \
 *     [--label "MTSU SSO"] [--expires-days 14]
 *
 * Examples:
 *   MTSU  (Demo Student):  --portal-host mtsu.edu          --login-url https://login.microsoftonline.com/
 *   CSCC  (Robert):     --portal-host clevelandstatecc.edu --login-url https://www.clevelandstatecc.edu/
 *
 * Requires Playwright (already a project dependency): the window opens, you log
 * in + clear 2FA, then return here and press Enter to capture.
 */

import { chromium } from 'playwright'
import readline from 'node:readline'
import { writeFileSync } from 'node:fs'

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true'
      out[key] = val
    }
  }
  return out
}

function need(args, key) {
  const v = args[key] || process.env[`HAMILTON_${key.toUpperCase().replace(/-/g, '_')}`]
  if (!v) { console.error(`Missing required --${key}`); process.exit(2) }
  return v
}

function waitForEnter(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(promptText, () => { rl.close(); resolve() }))
}

const args = parseArgs(process.argv)
// Two modes:
//   --out <file>  : write the captured storageState to a local JSON file (no
//                   token needed). Simplest — hand the file to Hamilton after.
//   --api-base + --token : upload straight to GrantFlow's import endpoint.
const outFile = args.out && args.out !== 'true' ? args.out : null
const profileId = need(args, 'profile-id')
const portalHost = need(args, 'portal-host')
const loginUrl = need(args, 'login-url')
const label = args.label || `${portalHost} session`
const expiresDays = Number(args['expires-days'] || 14)
const apiBase = outFile ? null : need(args, 'api-base').replace(/\/+$/, '')
const token = outFile ? null : need(args, 'token')

const browser = await chromium.launch({ headless: false })
const context = await browser.newContext()
const page = await context.newPage()
console.log(`\nOpening ${loginUrl}`)
console.log('→ Log in and complete 2FA in the browser window. Navigate until you are fully signed in.\n')
await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})

await waitForEnter('When you are fully logged in, come back here and press Enter to capture the session... ')

const storageState = await context.storageState()
await browser.close()

if (!storageState.cookies?.length && !storageState.origins?.length) {
  console.error('Captured an empty session — did the login complete? Aborting.')
  process.exit(1)
}
console.log(`Captured ${storageState.cookies.length} cookies across ${storageState.origins.length} origins.`)

const expiresAt = Number.isFinite(expiresDays) && expiresDays > 0
  ? new Date(Date.now() + expiresDays * 86400_000).toISOString()
  : null

// File mode: write the session locally (no token). Hamilton imports it after.
if (outFile) {
  writeFileSync(outFile, JSON.stringify({
    profile_id: profileId, portal_host: portalHost, label,
    authentication_strategy: 'imported_session', expires_at: expiresAt,
    storage_state: storageState,
  }, null, 2))
  console.log(`\n✅ Session written to ${outFile} (${storageState.cookies.length} cookies).`)
  console.log('   Hand this file to Hamilton to import — it contains your live session, keep it private.')
  process.exit(0)
}

const res = await fetch(`${apiBase}/api/hamilton/automation/sessions/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    profileId,
    portal_host: portalHost,
    storage_state: storageState,
    label,
    authentication_strategy: 'imported_session',
    expires_at: expiresAt,
    metadata: { imported_via: 'hamilton-session-capture' },
  }),
})
const body = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(`Import failed (${res.status}):`, JSON.stringify(body))
  process.exit(1)
}
console.log(`\n✅ Session imported for profile ${profileId} @ ${portalHost}.`)
console.log(`   Hamilton can now reuse it${expiresAt ? ` until ${expiresAt}` : ''}. Re-run this tool when it expires.`)
process.exit(0)
