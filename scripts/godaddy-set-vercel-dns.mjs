#!/usr/bin/env node
/**
 * Update GoDaddy DNS to point a domain at Vercel (non-UI, API-based).
 *
 * Safety:
 * - Defaults to DRY RUN (no changes).
 * - Requires CONFIRM=YES to apply changes.
 *
 * Env:
 *   GODADDY_API_KEY        (required)
 *   GODADDY_API_SECRET     (required)
 *   GODADDY_DOMAIN         (required) e.g. axiombiolabs.org
 *   GODADDY_TTL            (optional) default 600
 *   VERCEL_APEX_IP         (optional) default 76.76.21.21
 *   USE_WWW_CNAME          (optional) true/false. default true
 *   VERCEL_WWW_CNAME       (optional) default cname.vercel-dns-0.com
 *   VERCEL_WWW_A           (optional) default 76.76.21.21
 *   VERIFY_ONLY            (optional) true/false. verify current GoDaddy records without changing them
 *   ALLOW_LAB_APEX_TAKEOVER (optional) set to I_UNDERSTAND to override the guard
 *                          that blocks pointing axiombiolabs.org's apex at Vercel
 *                          (doing so takes the lab website offline)
 *   CONFIRM                set to YES to apply
 */

import process from 'node:process'

function reqEnv(name) {
  const v = String(process.env[name] || '').trim()
  if (!v) throw new Error(`Missing required env var ${name}`)
  return v
}

function env(name, def) {
  const v = String(process.env[name] || '').trim()
  return v ? v : def
}

function envBool(name, def = false) {
  const v = String(process.env[name] || '').trim().toLowerCase()
  if (!v) return def
  return v === '1' || v === 'true' || v === 'yes' || v === 'y'
}

function authHeader() {
  const key = reqEnv('GODADDY_API_KEY')
  const secret = reqEnv('GODADDY_API_SECRET')
  return `sso-key ${key}:${secret}`
}

async function godaddyFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.godaddy.com/v1${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(
      `GoDaddy API ${method} ${path} failed: ${res.status} ${res.statusText} ${text ? `- ${text}` : ''}`.trim(),
    )
  }
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function getRecords(domain, type, name) {
  return godaddyFetch(`/domains/${encodeURIComponent(domain)}/records/${type}/${encodeURIComponent(name)}`)
}

async function deleteRecords(domain, type, name) {
  await godaddyFetch(`/domains/${encodeURIComponent(domain)}/records/${type}/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

async function putRecords(domain, type, name, records) {
  await godaddyFetch(`/domains/${encodeURIComponent(domain)}/records/${type}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: records,
  })
}

function normalizeRecordData(records) {
  return [...new Set(
    (Array.isArray(records) ? records : [])
      .map((record) => String(record?.data || '').trim())
      .filter(Boolean),
  )]
    .sort((a, b) => a.localeCompare(b))
}

function recordLabel({ type, name }) {
  return `${type} ${name}`
}

function printPlan({ desiredRecords, cleanupRecords }) {
  console.log('[dns] desired records:')
  for (const record of desiredRecords) {
    console.log(`  - ${recordLabel(record)} -> ${record.records.map((r) => `${r.data} ttl=${r.ttl}`).join(', ')}`)
  }
  console.log('[dns] cleanup records:')
  for (const record of cleanupRecords) {
    console.log(`  - delete ${recordLabel(record)} if present`)
  }
}

async function verifyRecords(domain, desiredRecords, cleanupRecords = []) {
  let ok = true

  for (const desired of desiredRecords) {
    const actual = await getRecords(domain, desired.type, desired.name)
    const actualData = normalizeRecordData(actual)
    const expectedData = normalizeRecordData(desired.records)
    const matches = JSON.stringify(actualData) === JSON.stringify(expectedData)

    if (!matches) ok = false

    console.log(
      `[dns] verify ${recordLabel(desired)} expected=${JSON.stringify(expectedData)} actual=${JSON.stringify(actualData)} ok=${matches}`,
    )
  }

  for (const cleanup of cleanupRecords) {
    const actual = await getRecords(domain, cleanup.type, cleanup.name)
    const actualData = normalizeRecordData(actual)
    const matches = actualData.length === 0

    if (!matches) ok = false

    console.log(
      `[dns] verify absent ${recordLabel(cleanup)} actual=${JSON.stringify(actualData)} ok=${matches}`,
    )
  }

  return ok
}

async function run() {
  const domain = reqEnv('GODADDY_DOMAIN')
  const ttl = Number(env('GODADDY_TTL', '600'))
  if (!Number.isInteger(ttl) || ttl < 600) {
    throw new Error('GODADDY_TTL must be an integer >= 600')
  }

  const apexIp = env('VERCEL_APEX_IP', '76.76.21.21')

  const useWwwCname = envBool('USE_WWW_CNAME', true)
  const wwwCname = env('VERCEL_WWW_CNAME', 'cname.vercel-dns-0.com')
  const wwwA = env('VERCEL_WWW_A', '76.76.21.21')

  const apply = String(process.env.CONFIRM || '').trim().toUpperCase() === 'YES'
  const verifyOnly = envBool('VERIFY_ONLY', false)

  // Guard: axiombiolabs.org serves the Axiom Biolabs lab website via GoDaddy
  // Websites + Marketing. Pointing its apex at Vercel overwrites those records
  // and takes the lab site offline (this already happened once). GrantFlow
  // belongs on a subdomain (CNAME grantflow -> cname.vercel-dns-0.com), not the
  // apex. Block destructive applies against the lab apex unless explicitly
  // overridden. (Read-only VERIFY_ONLY runs are still allowed.)
  if (apply && !verifyOnly && domain === 'axiombiolabs.org' && env('ALLOW_LAB_APEX_TAKEOVER', '') !== 'I_UNDERSTAND') {
    throw new Error(
      'Refusing to point axiombiolabs.org apex at Vercel: that takes the lab website offline. ' +
        'Put GrantFlow on a subdomain, or set ALLOW_LAB_APEX_TAKEOVER=I_UNDERSTAND to override.',
    )
  }

  const desiredRecords = [
    { type: 'A', name: '@', records: [{ data: apexIp, ttl }] },
    useWwwCname
      ? { type: 'CNAME', name: 'www', records: [{ data: wwwCname, ttl }] }
      : { type: 'A', name: 'www', records: [{ data: wwwA, ttl }] },
  ]
  const cleanupRecords = [
    { type: 'CNAME', name: '@' },
    { type: 'AAAA', name: '@' },
    ...(useWwwCname
      ? [
          { type: 'A', name: 'www' },
          { type: 'AAAA', name: 'www' },
        ]
      : [
          { type: 'CNAME', name: 'www' },
          { type: 'AAAA', name: 'www' },
        ]),
  ]

  console.log(`[dns] domain=${domain} ttl=${ttl} apply=${apply} verifyOnly=${verifyOnly}`)
  printPlan({ desiredRecords, cleanupRecords })

  if (verifyOnly) {
    const ok = await verifyRecords(domain, desiredRecords, cleanupRecords)
    if (!ok) {
      throw new Error('GoDaddy DNS does not match the desired Vercel records')
    }
    console.log('[dns] verify done')
    return
  }

  if (!apply) {
    console.log('[dns] DRY RUN. Set CONFIRM=YES to apply.')
    return
  }

  for (const record of cleanupRecords) {
    await deleteRecords(domain, record.type, record.name).catch(() => {})
  }

  for (const record of desiredRecords) {
    await putRecords(domain, record.type, record.name, record.records)
  }

  const ok = await verifyRecords(domain, desiredRecords, cleanupRecords)
  if (!ok) {
    throw new Error('GoDaddy DNS apply completed, but verification did not match desired records')
  }

  console.log('[dns] done')
}

run().catch((e) => {
  console.error('[dns] fatal:', e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

