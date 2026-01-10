import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from 'playwright/test'

const ROOT = process.cwd()
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts', 'local')
const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:8080'
const BASE_URL = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4173'
const BASE_PATH = process.env.SMOKE_BASE_PATH || '/grantflow'
const ADMIN_TOKEN = process.env.SMOKE_ADMIN_TOKEN || 'dev-admin-token'

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

  // Very small static extractor: matches <Route path="...">
  const re = /<Route\s+path=(["'])(.*?)\1/g
  let m
  while ((m = re.exec(text))) {
    routes.add(m[2])
  }

  // Ensure deterministic ordering
  return Array.from(routes).sort()
}

function normalizeBasePath(p) {
  if (!p) return ''
  if (p === '/') return ''
  return `/${p.replace(/^\/+/, '').replace(/\/+$/, '')}`
}

async function safeClickAll(page) {
  const skipRe = /(delete|remove|destroy|permanent|bulk|seed|crawl all|run all|wipe|reset db|danger)/i
  const MAX_TOTAL_CLICKS = 75
  const MAX_PER_SELECTOR = 50

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
    const loc = page.locator(selector)
    const count = await loc.count()
    const limit = Math.min(count, MAX_PER_SELECTOR)
    for (let i = 0; i < limit; i += 1) {
      if (clicked.length >= MAX_TOTAL_CLICKS) break
      const el = loc.nth(i)
      const text = (await el.innerText().catch(() => '')) || ''
      if (skipRe.test(text)) continue
      if (await el.getAttribute('data-smoke-skip').catch(() => null)) continue
      try {
        await el.click({ timeout: 2_000, trial: true })
        await el.click({ timeout: 5_000 })
        clicked.push({ selector, text: text.slice(0, 120) })
      } catch {
        // Not clickable (offscreen/overlay/etc). Ignore for smoke.
      }
    }
  }

  return clicked
}

test('UI routes: visit + click visible controls + no console errors', async ({ page }) => {
  test.setTimeout(10 * 60_000)
  const basePath = normalizeBasePath(BASE_PATH)
  const routes = extractFrontendRoutes()
  writeArtifact('repro/routes.json', { basePath, routes })

  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), location: msg.location() })
    }
  })

  // Auth bypass for smoke: backend treats ADMIN_TOKEN as admin when used as Bearer token.
  await page.addInitScript(({ token }) => {
    try {
      localStorage.setItem('grantflow:access-token', token)
      localStorage.setItem('grantflow:refresh-token', token)
    } catch {}
  }, { token: ADMIN_TOKEN })

  const visited = []
  const clickedByRoute = {}

  try {
    for (const route of routes) {
      const url = `${BASE_URL}${basePath}${route === '/*' ? '/' : route}`
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(150)

      const clicked = await safeClickAll(page)
      visited.push(route)
      clickedByRoute[route] = clicked

      // Persist progress on every route so failures still yield actionable artifacts.
      writeArtifact('repro/ui-clicks.json', { visited, clickedByRoute })
      writeArtifact('repro/console-errors.json', consoleErrors)
    }
  } finally {
    writeArtifact('repro/ui-clicks.json', { visited, clickedByRoute })
    writeArtifact('repro/console-errors.json', consoleErrors)
  }

  expect(consoleErrors, `Console errors found (see ${path.join(ARTIFACTS_DIR, 'repro/console-errors.json')})`).toEqual([])
})

test('API: smoke call core endpoints (no 5xx)', async () => {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ADMIN_TOKEN}`,
  }

  const calls = []
  async function call(method, url, body) {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text().catch(() => '')
    calls.push({ method, url, status: res.status, body: body ?? null, response: text.slice(0, 1000) })
    return { res, text }
  }

  // Health
  await call('GET', `${API_BASE_URL}/health`)
  await call('GET', `${API_BASE_URL}/api/auth/diagnostics`)

  // Auth me (admin via bearer token)
  await call('GET', `${API_BASE_URL}/api/auth/me`)

  // Profiles list (used as source of IDs for other endpoints)
  const profilesResp = await call('GET', `${API_BASE_URL}/api/profiles`)
  let profileId = null
  try {
    const parsed = JSON.parse(profilesResp.text)
    profileId = Array.isArray(parsed) ? parsed[0]?.id : parsed?.profiles?.[0]?.id
  } catch {}

  // Crawler jobs endpoints (SMOKE_MODE should keep these fast and non-invasive)
  await call('GET', `${API_BASE_URL}/api/crawlers/jobs`)
  if (profileId) {
    await call('POST', `${API_BASE_URL}/api/crawlers/jobs`, { type: 'local', profile_id: profileId, parameters: { smoke: true } })
  }

  writeArtifact('repro/api-calls.json', calls)

  const failures = calls.filter((c) => c.status >= 500)
  expect(failures, `5xx responses found (see ${path.join(ARTIFACTS_DIR, 'repro/api-calls.json')})`).toEqual([])
})

