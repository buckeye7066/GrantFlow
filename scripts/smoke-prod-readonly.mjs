#!/usr/bin/env node
/**
 * Read-only production smoke test (no auth, no writes).
 *
 * Env:
 *   SMOKE_BASE_URL  - e.g. https://app.axiombiolabs.org
 *   SMOKE_BASE_PATH - e.g. /grantflow
 */

import process from 'node:process'

const baseUrlRaw = String(process.env.SMOKE_BASE_URL || '').trim()
const basePathRaw = String(process.env.SMOKE_BASE_PATH || '/grantflow').trim()

function normalizeBasePath(value) {
  if (!value) return '/'
  if (value === '/') return '/'
  const trimmed = value.trim()
  const noTrailing = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  return noTrailing.startsWith('/') ? noTrailing : `/${noTrailing}`
}

function joinUrl(baseUrl, path) {
  return new URL(path, baseUrl).toString()
}

async function fetchWithTimeout(url, { timeoutMs = 15_000, method = 'GET' } = {}) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { method, redirect: 'follow', signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

async function expectOk(url, { expectJson = false } = {}) {
  const res = await fetchWithTimeout(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Request failed: ${url} status=${res.status} body=${text.slice(0, 200)}`)
  }

  if (expectJson) {
    const body = await res.json()
    return { res, body }
  }

  const text = await res.text()
  return { res, body: text }
}

async function run() {
  if (!baseUrlRaw) {
    console.error('[prod-smoke] Missing SMOKE_BASE_URL (example: https://app.axiombiolabs.org)')
    process.exitCode = 1
    return
  }

  const baseUrl = baseUrlRaw.endsWith('/') ? baseUrlRaw : `${baseUrlRaw}/`
  const basePath = normalizeBasePath(basePathRaw)

  const appRoot = joinUrl(baseUrl, `${basePath}/`)
  const login = joinUrl(baseUrl, `${basePath}/login`)
  const apiHealth = joinUrl(baseUrl, `${basePath}/api/health`)

  console.log('[prod-smoke] Checking:', { appRoot, login, apiHealth })

  // HTML surfaces: should not 404.
  const rootResult = await expectOk(appRoot)
  const loginResult = await expectOk(login)

  // Cheap “wrong host” detector for the known incident: GoDaddy 404 page text.
  const htmlCombined = String(rootResult.body || '') + '\n' + String(loginResult.body || '')
  if (/file not found\s*\(404 error\)/i.test(htmlCombined)) {
    throw new Error('Detected static “File not found (404 error)” page — likely DNS/Vercel domain routing drift.')
  }

  // API health should be JSON and include request id header.
  const health = await expectOk(apiHealth, { expectJson: true })
  const requestId = health.res.headers.get('x-request-id')
  if (!requestId) {
    throw new Error('Expected X-Request-Id header on /api/health')
  }

  const status = health.body?.status
  if (!['ok', 'warning'].includes(status)) {
    throw new Error(`Unexpected /api/health status=${String(status)} (expected ok|warning)`)
  }

  console.log('[prod-smoke] OK', {
    health_status: status,
    request_id: requestId,
  })
}

run().catch((error) => {
  console.error('[prod-smoke] FAILED:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})

