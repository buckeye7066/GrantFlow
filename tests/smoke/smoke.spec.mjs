import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from 'playwright/test'

const ROOT = process.cwd()
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts', 'local')
// Backwards-compatible defaults:
// - UI smoke historically targets Vite preview (4173)
// - API smoke targets backend (8080)
const DEFAULT_UI_BASE_URL = `http://127.0.0.1:${process.env.SMOKE_UI_PORT || '4173'}`
const DEFAULT_API_BASE_URL = `http://127.0.0.1:${process.env.PORT || process.env.SMOKE_API_PORT || '8080'}`

// Doctor sets SMOKE_UI_BASE_URL and SMOKE_BASE_URL when it dynamically selects backend ports.
// When running smoke standalone, allow SMOKE_* / BASE_URL / API_BASE_URL overrides.
const UI_BASE_URL =
  process.env.SMOKE_UI_BASE_URL || process.env.SMOKE_BASE_URL || process.env.BASE_URL || DEFAULT_UI_BASE_URL
const API_BASE_URL =
  process.env.API_BASE_URL || process.env.SMOKE_API_BASE_URL || DEFAULT_API_BASE_URL
const BASE_PATH = process.env.SMOKE_BASE_PATH || '/grantflow'
const ADMIN_TOKEN = process.env.SMOKE_ADMIN_TOKEN || 'dev-admin-token'
const BULK_KEY = process.env.SMOKE_BULK_KEY || process.env.BULK_POPULATE_KEY || 'grantflow-bulk-2026'

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeArtifact(relPath, content) {
  ensureDir(ARTIFACTS_DIR)
  const full = path.join(ARTIFACTS_DIR, relPath)
  ensureDir(path.dirname(full))
  fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')
}

function extractFrontendRoutes() {
  const file = path.join(ROOT, 'src', 'pages', 'index.jsx')
  const text = fs.readFileSync(file, 'utf8')
  const routes = new Set()
  const re = /<Route\s+path=(["'])(.*?)\1/g
  let m
  while ((m = re.exec(text))) routes.add(m[2])
  return Array.from(routes).sort()
}

function normalizeBasePath(p) {
  if (!p) return ''
  if (p === '/') return ''
  return `/${p.replace(/^\/+/, '').replace(/\/+$/, '')}`
}

function redactSecrets(text) {
  if (!text) return text
  return String(text)
    // redact JWT-ish tokens
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED_JWT]')
    // redact OpenAI-ish keys
    .replace(/\bsk-[a-zA-Z0-9]{10,}\b/g, '[REDACTED_KEY]')
}

function pickRoutes(allRoutes) {
  // Keep default smoke fast; allow widening via SMOKE_MAX_ROUTES.
  const maxRoutes = Number.parseInt(process.env.SMOKE_MAX_ROUTES || '3', 10)
  const normalized = allRoutes
    .filter((r) => typeof r === 'string' && r.trim().length > 0)
    .filter((r) => r !== '/*')
    .filter((r) => (process.env.SMOKE_INCLUDE_LOGIN === 'true' ? true : r !== '/login'))

  const preferred = [
    '/',
    '/Dashboard',
    '/Organizations',
    '/MyProfiles',
    '/FundingOpportunities',
    '/Pipeline',
    '/Documents',
    '/Settings',
    '/Diagnostics',
  ]

  const picked = []
  const seen = new Set()
  for (const r of preferred) {
    if (picked.length >= maxRoutes) break
    if (normalized.includes(r) && !seen.has(r)) {
      picked.push(r)
      seen.add(r)
    }
  }
  for (const r of normalized) {
    if (picked.length >= maxRoutes) break
    if (seen.has(r)) continue
    picked.push(r)
    seen.add(r)
  }
  return picked
}

async function safeClickAll(page) {
  const skipRe =
    /(delete|remove|destroy|permanent|bulk|seed|crawl all|run all|wipe|reset db|danger|continue with email|send code|verification code)/i
  const MAX_TOTAL_CLICKS = Number.parseInt(process.env.SMOKE_MAX_CLICKS || '10', 10)
  const MAX_PER_SELECTOR = Number.parseInt(process.env.SMOKE_MAX_PER_SELECTOR || '6', 10)
  const START = Date.now()
  const PER_ROUTE_BUDGET_MS = Number.parseInt(process.env.SMOKE_ROUTE_CLICK_BUDGET_MS || '15000', 10)

  const selectors = [
    'button:visible',
    'input[type="checkbox"]:visible',
    'input[type="radio"]:visible',
    'select:visible',
    '[role="switch"]:visible',
    '[role="checkbox"]:visible',
    '[role="button"]:visible',
    '[role="combobox"]:visible',
  ]

  const clicked = []
  for (const selector of selectors) {
    if (clicked.length >= MAX_TOTAL_CLICKS) break
    if (Date.now() - START > PER_ROUTE_BUDGET_MS) break
    const loc = page.locator(selector)
    for (let i = 0; i < MAX_PER_SELECTOR; i += 1) {
      if (clicked.length >= MAX_TOTAL_CLICKS) break
      if (Date.now() - START > PER_ROUTE_BUDGET_MS) break
      const el = loc.nth(i)
      const visible = await el.isVisible({ timeout: 250 }).catch(() => false)
      if (!visible) break
      const text = (await el.innerText().catch(() => '')) || ''
      if (skipRe.test(text)) continue
      if (await el.getAttribute('data-smoke-skip').catch(() => null)) continue
      try {
        // Keep smoke deterministic and fast: do not wait on navigations triggered by clicks.
        await el.click({ timeout: 500, trial: true, noWaitAfter: true })
        await el.click({ timeout: 1_500, noWaitAfter: true })
        clicked.push({ selector, text: text.slice(0, 120) })
      } catch {
        // ignore
      }
    }
  }
  return clicked
}

function listBackendRoutes() {
  const serverPath = path.join(ROOT, 'backend', 'server.js')
  const serverText = fs.readFileSync(serverPath, 'utf8')

  const importRe = /import\s+(\w+)\s+from\s+['"]\.\/routes\/([^'"]+)\.js['"]/g
  const useRe = /app\.use\(\s*(['"`])([^'"`]+)\1\s*,\s*(\w+)\s*\)/g

  const routerVarToFile = new Map()
  let m
  while ((m = importRe.exec(serverText))) {
    routerVarToFile.set(m[1], `backend/routes/${m[2]}.js`)
  }

  const prefixByFile = new Map()
  while ((m = useRe.exec(serverText))) {
    const prefix = m[2]
    const varName = m[3]
    const file = routerVarToFile.get(varName)
    if (file) prefixByFile.set(file, prefix)
  }

  const routeFilesDir = path.join(ROOT, 'backend', 'routes')
  const routeFiles = fs
    .readdirSync(routeFilesDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => `backend/routes/${f}`)

  const endpoints = []
  const routeRe = /\brouter\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g
  const routeDotRe = /\brouter\.route\(\s*(['"`])([^'"`]+)\1\s*\)\s*\.([a-z]+)/g

  for (const relFile of routeFiles) {
    const abs = path.join(ROOT, relFile)
    const text = fs.readFileSync(abs, 'utf8')
    const prefix = prefixByFile.get(relFile) || ''

    // router.get('/x', ...)
    routeRe.lastIndex = 0
    while ((m = routeRe.exec(text))) {
      const method = m[1].toUpperCase()
      const routePath = m[3]
      endpoints.push({ method, prefix, routePath, file: relFile })
    }

    // router.route('/x').get(...)
    routeDotRe.lastIndex = 0
    while ((m = routeDotRe.exec(text))) {
      const routePath = m[2]
      const method = String(m[3] || '').toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue
      endpoints.push({ method, prefix, routePath, file: relFile })
    }
  }

  // De-dupe
  const key = (e) => `${e.method} ${e.prefix}${e.routePath}`
  const uniq = new Map()
  for (const e of endpoints) uniq.set(key(e), e)
  return Array.from(uniq.values()).sort((a, b) => key(a).localeCompare(key(b)))
}

function substituteParams(pathTemplate, ids = {}) {
  return pathTemplate.replace(/:([A-Za-z0-9_]+)/g, (_m, name) => {
    const v = ids[name]
    return v ? encodeURIComponent(String(v)) : 'smoke'
  })
}

test('UI routes: visit + click visible controls + no console errors', async ({ page }) => {
  const basePath = normalizeBasePath(BASE_PATH)
  const allRoutes = extractFrontendRoutes()
  const routes = pickRoutes(allRoutes)
  // Scale overall timeout with route count + per-route budget so larger SMOKE_MAX_ROUTES runs don't
  // fail just because they exceed the default 5m cap.
  const perRouteBudgetMs = Number.parseInt(process.env.SMOKE_ROUTE_CLICK_BUDGET_MS || '15000', 10)
  const defaultUiTimeoutMs = Math.max(5 * 60_000, routes.length * (perRouteBudgetMs + 2000) + 60_000)
  const uiTimeoutMs = Number.parseInt(process.env.SMOKE_UI_TEST_TIMEOUT_MS || '', 10) || defaultUiTimeoutMs
  test.setTimeout(uiTimeoutMs)
  // Keep locator auto-waits tight so redirects (e.g. to /login) don't stall the suite.
  // Navigation timeouts are set explicitly per goto().
  const defaultActionTimeoutMs = Number.parseInt(process.env.SMOKE_ACTION_TIMEOUT_MS || '1500', 10)
  page.setDefaultTimeout(defaultActionTimeoutMs)
  writeArtifact('repro/routes.json', { basePath, routes, allRoutesCount: allRoutes.length })

  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), location: msg.location() })
    }
  })

  // Auth bypass for smoke: backend treats ADMIN_TOKEN as admin when used as Bearer token (server-side).
  await page.addInitScript(({ token }) => {
    try {
      // Robust smoke marker (independent of Vite env injection)
      window.__GF_SMOKE__ = true
      localStorage.setItem('grantflow:access-token', token)
      localStorage.setItem('grantflow:refresh-token', token)
    } catch {}
  }, { token: ADMIN_TOKEN })

  const visited = []
  const clickedByRoute = {}

  try {
    for (const route of routes) {
      const url = `${UI_BASE_URL}${basePath}${route === '/*' ? '/' : route}`
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(150)
      const clicked = await safeClickAll(page)
      visited.push(route)
      clickedByRoute[route] = clicked
      writeArtifact('repro/ui-clicks.json', { visited, clickedByRoute })
      writeArtifact('repro/console-errors.json', consoleErrors)
    }
  } finally {
    writeArtifact('repro/ui-clicks.json', { visited, clickedByRoute })
    writeArtifact('repro/console-errors.json', consoleErrors)
  }

  expect(consoleErrors, `Console errors found (see ${path.join(ARTIFACTS_DIR, 'repro/console-errors.json')})`).toEqual([])
})

test('API: call discovered endpoints (no 5xx; 4xx allowed)', async () => {
  test.setTimeout(5 * 60_000)

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ADMIN_TOKEN}`,
  }

  const discovered = listBackendRoutes()
  writeArtifact('repro/api-discovered.json', discovered)

  const calls = []
  async function call(method, url, body, extraHeaders) {
    const controller = new AbortController()
    const timeoutMs = Number.parseInt(process.env.SMOKE_API_TIMEOUT_MS || '5000', 10)
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: { ...headers, ...(extraHeaders || {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text().catch(() => '')
      calls.push({ method, url, status: res.status, body: body ?? null, response: redactSecrets(text).slice(0, 800) })
      return { res, text }
    } catch (err) {
      const message = err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err?.message || err)
      calls.push({ method, url, status: 0, body: body ?? null, response: message })
      return { res: null, text: '' }
    } finally {
      clearTimeout(t)
    }
  }

  // Prime IDs for param substitution
  await call('GET', `${API_BASE_URL}/health`)
  const profilesResp = await call('GET', `${API_BASE_URL}/api/profiles`)
  let profileId = null
  try {
    const parsed = JSON.parse(profilesResp.text)
    profileId = Array.isArray(parsed) ? parsed[0]?.id : parsed?.profiles?.[0]?.id
  } catch {}

  const ids = {
    id: 'smoke',
    profileId: profileId || 'smoke',
    profile_id: profileId || 'smoke',
    organizationId: 'smoke',
    state: 'CA',
    track: 'TRACK_A',
    programId: 'smoke',
    sessionId: 'smoke',
    taskId: 'smoke',
  }

  // Walk every discovered endpoint with a minimal safe payload.
  // Use small concurrency so the suite stays fast without stampeding the backend.
  const maxConcurrency = Number.parseInt(process.env.SMOKE_API_CONCURRENCY || '6', 10)
  let idx = 0
  async function worker() {
    while (idx < discovered.length) {
      const ep = discovered[idx]
      idx += 1

      const fullPath = `${ep.prefix}${substituteParams(ep.routePath, ids)}`
      const url = `${API_BASE_URL}${fullPath}`

      const method = ep.method
      const isCrawlerV2Run = method === 'POST' && fullPath === '/api/crawler-v2/run'

      if (isCrawlerV2Run) {
        await call(
          method,
          url,
          {
            mode: 'SMOKE_MODE',
            use_live_sources: false,
            max_sources: 3,
            max_urls_per_source: 2,
            timeout_seconds: 10,
          },
          { 'x-bulk-key': BULK_KEY },
        )
        continue
      }

      if (method === 'GET') {
        await call(method, url)
        continue
      }

      // For mutating methods, intentionally send a minimal body and/or bogus IDs to force validation/404 (safe, fast).
      const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? {} : undefined
      await call(method, url, body)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, maxConcurrency) }, () => worker()))

  writeArtifact('repro/api-calls.json', calls)
  const failures = calls.filter((c) => c.status >= 500)
  expect(failures, `5xx responses found (see ${path.join(ARTIFACTS_DIR, 'repro/api-calls.json')})`).toEqual([])
})

