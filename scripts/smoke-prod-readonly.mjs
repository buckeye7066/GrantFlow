#!/usr/bin/env node
/**
 * Read-only production smoke test (no auth, no writes).
 *
 * Env:
 *   SMOKE_BASE_URL  - e.g. https://app.axiombiolabs.org
 *   SMOKE_BASE_PATH - production app path (default /)
 *   SMOKE_CHECK_PROFILE_SCHEMA - default "true"; validates /api/profiles/schema
 */

import process from 'node:process'
import { pathToFileURL } from 'node:url'

const baseUrlRaw = String(process.env.SMOKE_BASE_URL || '').trim()
const basePathRaw = String(process.env.SMOKE_BASE_PATH || '/').trim()
const checkSchemaRaw = String(process.env.SMOKE_CHECK_PROFILE_SCHEMA ?? 'true').trim().toLowerCase()
const shouldCheckSchema = checkSchemaRaw !== 'false' && checkSchemaRaw !== '0' && checkSchemaRaw !== 'no'

export function normalizeBasePath(value) {
  if (!value) return '/'
  if (value === '/') return '/'
  const trimmed = value.trim()
  const noTrailing = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  return noTrailing.startsWith('/') ? noTrailing : `/${noTrailing}`
}

export function joinAppPath(basePath, suffix = '') {
  const normalizedBase = normalizeBasePath(basePath)
  const normalizedSuffix = String(suffix || '').replace(/^\/+/, '')
  if (!normalizedSuffix) return normalizedBase
  return normalizedBase === '/' ? `/${normalizedSuffix}` : `${normalizedBase}/${normalizedSuffix}`
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

  const appRoot = joinUrl(baseUrl, basePath)
  const appRootSlash = joinUrl(baseUrl, `${basePath.replace(/\/$/, '')}/`)
  const login = joinUrl(baseUrl, joinAppPath(basePath, 'login'))
  const landing = joinUrl(baseUrl, joinAppPath(basePath, 'welcome'))
  const apiHealth = joinUrl(baseUrl, joinAppPath(basePath, 'api/health'))
  const apiProfileSchema = joinUrl(baseUrl, joinAppPath(basePath, 'api/profiles/schema'))

  console.log('[prod-smoke] Checking:', {
    appRoot,
    appRootSlash,
    login,
    landing,
    apiHealth,
    ...(shouldCheckSchema ? { apiProfileSchema } : {}),
  })

  // HTML surfaces: should not 404.
  let rootResult = null
  let rootSlashResult = null
  try {
    rootResult = await expectOk(appRoot)
  } catch (err) {
    rootResult = { error: err instanceof Error ? err.message : String(err) }
  }
  try {
    rootSlashResult = await expectOk(appRootSlash)
  } catch (err) {
    rootSlashResult = { error: err instanceof Error ? err.message : String(err) }
  }

  if (rootResult?.error && rootSlashResult?.error) {
    throw new Error(
      `Both app roots failed.\n- ${appRoot}: ${rootResult.error}\n- ${appRootSlash}: ${rootSlashResult.error}`,
    )
  }

  // Enforce that both variants are stable: the trailing-slash variant must not 404.
  // This catches Vercel routing drift where `vercel.json` isn't being applied for the production domain.
  if (!rootSlashResult?.res?.ok) {
    throw new Error(
      [
        'Trailing-slash app root is failing.',
        `- ${appRootSlash} is not OK`,
        `- ${appRoot} may still load, but users/bookmarks hitting "${basePath}/" will 404.`,
        '',
        'Fix:',
        '- Ensure the correct Vercel project is deploying this repo and is applying `vercel.json`.',
        '- Redeploy/promote to production after confirming `vercel.json` includes a redirect or rewrite for `/grantflow/`.',
      ].join('\n'),
    )
  }

  const effectiveRootResult = rootResult?.res?.ok ? rootResult : rootSlashResult
  const loginResult = await expectOk(login)
  const landingResult = await expectOk(landing)

  // Cheap “wrong host” detector for the known incident: GoDaddy 404 page text.
  const htmlCombined = [effectiveRootResult.body, loginResult.body, landingResult.body].map(String).join('\n')
  if (/file not found\s*\(404 error\)/i.test(htmlCombined)) {
    throw new Error('Detected static “File not found (404 error)” page — likely DNS/Vercel domain routing drift.')
  }

  if (!/GrantFlow \| Grants, Scholarships &amp; Benefits Matched to Your Profile/i.test(String(landingResult.body || ''))) {
    throw new Error('Public /welcome did not return the GrantFlow acquisition document metadata.')
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

  if (shouldCheckSchema) {
    const schema = await expectOk(apiProfileSchema, { expectJson: true })
    const supported = schema.body?.supported_section_keys
    const sections = schema.body?.sections
    if (!Array.isArray(supported) || supported.length === 0) {
      throw new Error('Expected supported_section_keys[] from /api/profiles/schema')
    }
    if (!sections || typeof sections !== 'object') {
      throw new Error('Expected sections object from /api/profiles/schema')
    }
  }

  console.log('[prod-smoke] OK', {
    health_status: status,
    request_id: requestId,
    profile_schema_checked: shouldCheckSchema,
  })
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null
if (invokedPath === import.meta.url) {
  run().catch((error) => {
    console.error('[prod-smoke] FAILED:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
