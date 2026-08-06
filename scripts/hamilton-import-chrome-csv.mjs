#!/usr/bin/env node
/**
 * scripts/hamilton-import-chrome-csv.mjs
 *
 * Bulk-import a Chrome / Edge / Brave / Firefox / 1Password / LastPass CSV
 * password export into a profile's Hamilton credential vault, calling the
 * production /api/hamilton/automation/credentials/import-csv route. Same
 * server-side service path the in-app dialog uses; this is just a
 * convenience for one-shot imports against the live Railway API.
 *
 * Usage (PowerShell):
 *
 *   $env:GRANTFLOW_API = "https://your-grantflow-backend.example.invalid"
 *   $env:GRANTFLOW_ADMIN_TOKEN = "<ADMIN_TOKEN>"
 *   node scripts/hamilton-import-chrome-csv.mjs --csv "C:\Users\Example\Documents\Chrome Passwords.csv" --profile-id <uuid>
 *
 * If you already know the user behind a profile, this script also accepts a
 * `--profile-slug <slug>` for the well-known designated profiles (e.g.
 * "demo-tennessee-stem-student"). It looks the slug up via
 * /api/profiles?primary_email=...
 * with the admin token.
 *
 * The CSV is sent over HTTPS, encrypted at rest by the server, and the
 * structured summary is printed (counts only — NEVER any plaintext).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const args = parseArgs(process.argv.slice(2))
const API = String(args['api'] || process.env.GRANTFLOW_API || '').trim().replace(/\/+$/, '')
const TOKEN = args['token'] || process.env.GRANTFLOW_ADMIN_TOKEN || process.env.ADMIN_TOKEN
const CSV_PATH = args['csv']
const PROFILE_ID = args['profile-id']
const SOURCE = args['source'] || 'Chrome'

if (!API) {
  console.error('error: GRANTFLOW_API (or --api) is required; this mutating script has no deployment default')
  process.exit(2)
}
if (!TOKEN) {
  console.error('error: GRANTFLOW_ADMIN_TOKEN (or ADMIN_TOKEN) env var is required')
  process.exit(2)
}
if (!CSV_PATH) {
  console.error('error: --csv <path> is required')
  process.exit(2)
}
if (!PROFILE_ID) {
  console.error('error: --profile-id <uuid> is required')
  process.exit(2)
}

async function api(method, pathPart, body) {
  const res = await fetch(`${API}${pathPart}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* keep raw */ }
  if (!res.ok) {
    const detail = json?.message || json?.detail || json?.error || text || `HTTP ${res.status}`
    throw new Error(`${method} ${pathPart} → ${res.status}: ${detail}`)
  }
  return json
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const v = argv[i + 1]
      if (!v || v.startsWith('--')) {
        out[key] = true
      } else {
        out[key] = v
        i += 1
      }
    }
  }
  return out
}

;(async () => {
  const csvText = await fs.readFile(CSV_PATH, 'utf8')
  const lineCount = csvText.split('\n').filter(Boolean).length
  console.log(`reading ${path.basename(CSV_PATH)} (${csvText.length} bytes, ~${Math.max(0, lineCount - 1)} entries)`)
  console.log(`importing into profile ${PROFILE_ID} on ${API} as source="${SOURCE}"`)
  const resp = await api('POST', '/api/hamilton/automation/credentials/import-csv', {
    profileId: PROFILE_ID,
    csv_text: csvText,
    source: SOURCE,
  })
  console.log('summary:', JSON.stringify({
    imported: resp.imported,
    total:    resp.total,
    skipped:  Array.isArray(resp.skipped) ? resp.skipped.length : 0,
    errors:   Array.isArray(resp.errors)  ? resp.errors.length  : 0,
  }))
  if (Array.isArray(resp.skipped) && resp.skipped.length) {
    console.log('skipped (first 50):')
    for (const s of resp.skipped.slice(0, 50)) {
      console.log(`  row ${s.row}: ${s.reason}${s.label ? `  (${s.label})` : ''}`)
    }
    if (resp.skipped.length > 50) console.log(`  …and ${resp.skipped.length - 50} more.`)
  }
  if (Array.isArray(resp.errors) && resp.errors.length) {
    console.log('errors:')
    for (const e of resp.errors) {
      console.log(`  row ${e.row}: ${e.reason}${e.message ? ` — ${e.message}` : ''}`)
    }
    process.exitCode = 1
  }
})().catch((err) => {
  console.error('failed:', err.message || err)
  process.exit(1)
})
