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
 *   VERCEL_WWW_CNAME       (optional) default cname.vercel-dns.com
 *   VERCEL_WWW_A           (optional) default 76.76.21.21
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

async function run() {
  const domain = reqEnv('GODADDY_DOMAIN')
  const ttl = Number(env('GODADDY_TTL', '600'))
  const apexIp = env('VERCEL_APEX_IP', '76.76.21.21')

  const useWwwCname = envBool('USE_WWW_CNAME', true)
  const wwwCname = env('VERCEL_WWW_CNAME', 'cname.vercel-dns.com')
  const wwwA = env('VERCEL_WWW_A', '76.76.21.21')

  const apply = String(process.env.CONFIRM || '').trim().toUpperCase() === 'YES'

  console.log(`[dns] domain=${domain} ttl=${ttl} apply=${apply}`)

  if (!apply) {
    console.log('[dns] DRY RUN. Set CONFIRM=YES to apply.')
    return
  }

  // Avoid conflicts
  await deleteRecords(domain, 'AAAA', '@').catch(() => {})
  await deleteRecords(domain, 'A', 'www').catch(() => {})
  await deleteRecords(domain, 'AAAA', 'www').catch(() => {})
  await deleteRecords(domain, 'CNAME', 'www').catch(() => {})

  await putRecords(domain, 'A', '@', [{ data: apexIp, ttl }])

  if (useWwwCname) {
    await putRecords(domain, 'CNAME', 'www', [{ data: wwwCname, ttl }])
  } else {
    await putRecords(domain, 'A', 'www', [{ data: wwwA, ttl }])
  }

  console.log('[dns] done')
}

run().catch((e) => {
  console.error('[dns] fatal:', e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

