#!/usr/bin/env node
/**
 * scripts/hamilton-route-chrome-csv.mjs
 *
 * Import a consolidated browser/password-manager CSV export into Hamilton's
 * credential vault with OWNER ROUTING:
 *
 *   - EVERY credential is saved into a central ADMIN vault profile, so the
 *     admin (buckeye7066@gmail.com) can assist any profile from one place.
 *   - Where a credential's owner can be confidently identified from its login
 *     identifiers, a copy is ALSO saved into that individual / org profile's
 *     vault, so Hamilton picks it up automatically when working their portals.
 *
 * Unlike scripts/hamilton-import-chrome-csv.mjs (single-profile bulk import via
 * the /credentials/import-csv route), this drives the always-deployed
 * POST /credentials route once per (credential, owning-profile) so it works
 * against any environment without waiting on a redeploy. saveCredential is
 * idempotent on (profile_id, portal_host), so re-running is safe.
 *
 * The routing rules live in an EXTERNAL JSON file (--routes) so personal
 * identifiers never get committed to the repo. See hamilton-routes.example.json.
 *
 * Usage (PowerShell):
 *   $env:GRANTFLOW_API = "https://grantflow-production.up.railway.app"
 *   $env:GRANTFLOW_ADMIN_TOKEN = "<ADMIN_TOKEN>"
 *   node scripts/hamilton-route-chrome-csv.mjs `
 *     --csv "C:\path\Chrome Passwords.csv" `
 *     --admin-profile-id <uuid> `
 *     --routes "C:\path\hamilton-routes.local.json" `
 *     [--dry-run] [--source Chrome]
 *
 * --dry-run classifies and prints the routing plan WITHOUT sending anything.
 * Counts only are ever printed — NEVER a plaintext password.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  parseCsv, mapHeaders, extractHostAndLoginUrl,
} from '../backend/services/hamilton/hamiltonCredentialCsvImport.js'
import {
  compileRoutes, classifyOwners,
} from '../backend/services/hamilton/hamiltonCredentialOwnerRouter.js'

const args = parseArgs(process.argv.slice(2))
const API = (args.api || process.env.GRANTFLOW_API || 'https://grantflow-production.up.railway.app').replace(/\/+$/, '')
const TOKEN = args.token || process.env.GRANTFLOW_ADMIN_TOKEN || process.env.ADMIN_TOKEN
const CSV_PATH = args.csv
const ADMIN_PROFILE_ID = args['admin-profile-id']
const ROUTES_PATH = args.routes
const SOURCE = args.source || 'Chrome'
const DRY_RUN = Boolean(args['dry-run'])

if (!CSV_PATH) fail('--csv <path> is required')
if (!ADMIN_PROFILE_ID) fail('--admin-profile-id <uuid> is required')
if (!DRY_RUN && !TOKEN) fail('GRANTFLOW_ADMIN_TOKEN (or ADMIN_TOKEN) is required unless --dry-run')

function fail(msg) { console.error(`error: ${msg}`); process.exit(2) }

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) { out[key] = true } else { out[key] = v; i += 1 }
  }
  return out
}

async function postCredential({ profileId, portalHost, username, password, loginUrl, label }) {
  const res = await fetch(`${API}/api/hamilton/automation/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ profileId, portalHost, username, password, login_url: loginUrl, label }),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* keep raw */ }
  if (!res.ok) {
    const detail = json?.detail || json?.message || json?.error || text || `HTTP ${res.status}`
    throw new Error(detail)
  }
  return json
}

;(async () => {
  const [csvText, routesText] = await Promise.all([
    fs.readFile(CSV_PATH, 'utf8'),
    ROUTES_PATH ? fs.readFile(ROUTES_PATH, 'utf8') : Promise.resolve('[]'),
  ])
  const routeDefs = JSON.parse(routesText)
  const compiled = compileRoutes(routeDefs)
  const labelFor = new Map(compiled.map((r) => [r.profileId, r.label]))
  labelFor.set(ADMIN_PROFILE_ID, 'ADMIN VAULT')

  const rows = parseCsv(csvText)
  const idx = mapHeaders(rows[0] || [])
  if (!idx) fail('CSV missing required url/username/password columns')

  console.log(`${path.basename(CSV_PATH)}: ${rows.length - 1} data rows`)
  console.log(`routing rules: ${compiled.length} profile(s) — ${compiled.map((r) => r.label).join(', ') || 'none'}`)
  console.log(`admin vault: ${ADMIN_PROFILE_ID}`)
  console.log(DRY_RUN ? 'MODE: dry-run (no writes)\n' : `MODE: live → ${API}\n`)

  const perProfile = new Map()   // profileId → { imported, errors }
  const hostsByProfile = new Map() // profileId → Map(host → Set(usernames)) for collision reporting
  const skipped = []
  let totalRows = 0

  const bump = (pid, field) => {
    const e = perProfile.get(pid) || { imported: 0, errors: 0 }
    e[field] += 1
    perProfile.set(pid, e)
  }
  const trackHost = (pid, host, username) => {
    const m = hostsByProfile.get(pid) || new Map()
    const s = m.get(host) || new Set()
    s.add(username.toLowerCase())
    m.set(host, s)
    hostsByProfile.set(pid, m)
  }

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r] || []
    if (row.length === 1 && row[0] === '') continue
    const url = (row[idx.url] || '').trim()
    const username = (row[idx.username] || '').trim()
    const password = idx.password >= 0 ? row[idx.password] || '' : ''
    const label = (idx.label >= 0 ? row[idx.label] : '') || ''
    totalRows += 1

    if (!username || !password) { skipped.push({ row: r + 1, reason: 'missing_username_or_password' }); continue }
    const { host, loginUrl } = extractHostAndLoginUrl(url)
    if (!host) {
      skipped.push({ row: r + 1, reason: url.startsWith('android://') ? 'android_app_no_web_host' : 'invalid_url', label })
      continue
    }

    const owners = classifyOwners({ username, host, label }, compiled)
    const targets = [...new Set([ADMIN_PROFILE_ID, ...owners])]
    const baseLabel = label.trim() ? `${label.trim()} (${SOURCE})` : `${host} (${SOURCE})`

    for (const pid of targets) {
      trackHost(pid, host, username)
      if (DRY_RUN) { bump(pid, 'imported'); continue }
      try {
        await postCredential({ profileId: pid, portalHost: host, username, password, loginUrl, label: baseLabel })
        bump(pid, 'imported')
      } catch (err) {
        bump(pid, 'errors')
        console.error(`  row ${r + 1} → ${labelFor.get(pid) || pid}: ${err.message}`)
      }
    }
  }

  console.log('\n=== summary ===')
  console.log(`rows processed: ${totalRows}, skipped: ${skipped.length}`)
  for (const [pid, e] of perProfile) {
    const hm = hostsByProfile.get(pid) || new Map()
    const multi = [...hm.entries()].filter(([, s]) => s.size > 1)
    const collNote = multi.length
      ? `  (${multi.length} host(s) have multiple distinct logins — all preserved)`
      : ''
    console.log(`  ${(labelFor.get(pid) || pid).padEnd(26)} saved=${e.imported} errors=${e.errors}${collNote}`)
  }
  if (skipped.length) {
    const byReason = skipped.reduce((m, s) => (m[s.reason] = (m[s.reason] || 0) + 1, m), {})
    console.log('skipped reasons:', JSON.stringify(byReason))
  }
  if ([...perProfile.values()].some((e) => e.errors > 0)) process.exitCode = 1
})().catch((err) => { console.error('failed:', err.message || err); process.exit(1) })
