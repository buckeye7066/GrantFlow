/**
 * browserSessionService.js
 *
 * Real Playwright-driven browser sessions for Yana.
 *
 * Behaviour rules (from the Yana spec):
 *   - Browser automation is gated behind YANA_ENABLE_BROWSER_AUTOMATION=true.
 *   - Headless defaults to OFF (private/local supervised flow). Set
 *     YANA_BROWSER_HEADLESS=true only when explicitly configured (and
 *     for the unit-test fixture).
 *   - Storage state (cookies + tokens, never plain passwords) lives on
 *     disk under YANA_BROWSER_STORAGE_DIR keyed by session id.
 *   - Yana never bypasses CAPTCHA / 2FA / SSO / consent gates. Detection
 *     pauses the session and asks the user/admin to act.
 *   - Profile scoping is enforced by the caller; this service trusts the
 *     ids it is given and only manages browser lifecycle.
 *
 * The service keeps a Map of live (BrowserContext, Page) handles in
 * memory keyed by session id. Calls coming from a different Node process
 * cannot reuse those handles — restart re-attaches by re-launching with
 * the same storage_state file (so the user stays logged in).
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const liveSessions = new Map()
let cachedFlags = null

export function isBrowserAutomationEnabled() {
  const v = String(process.env.YANA_ENABLE_BROWSER_AUTOMATION || '').toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

export function isAutoSubmitEnabledGlobally() {
  const v = String(process.env.YANA_ALLOW_AUTOSUBMIT || '').toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

export function getBrowserDefaults() {
  if (cachedFlags) return cachedFlags
  const headlessEnv = String(process.env.YANA_BROWSER_HEADLESS || '').toLowerCase()
  const headless = headlessEnv === 'true' || headlessEnv === '1' || headlessEnv === 'yes'
  const timeoutMs = Number.parseInt(process.env.YANA_BROWSER_TIMEOUT_MS || '60000', 10)
  const storageDir = process.env.YANA_BROWSER_STORAGE_DIR
    || path.join(os.tmpdir(), 'grantflow-yana-storage')
  cachedFlags = {
    headless,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000,
    storageDir,
  }
  return cachedFlags
}

export function _resetCachedFlags() { cachedFlags = null }

function ensureStorageDir() {
  const { storageDir } = getBrowserDefaults()
  try {
    fs.mkdirSync(storageDir, { recursive: true })
  } catch { /* best-effort */ }
  return storageDir
}

export function storageStatePathFor(sessionId) {
  const dir = ensureStorageDir()
  return path.join(dir, `${sessionId}.storage.json`)
}

export function screenshotPathFor(sessionId, label = 'snapshot') {
  const dir = path.join(ensureStorageDir(), sessionId)
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ }
  const name = `${Date.now()}_${String(label).replace(/[^a-z0-9_-]+/gi, '_')}.png`
  return path.join(dir, name)
}

async function loadPlaywright() {
  // Lazy-import so the rest of GrantFlow doesn't load Playwright on
  // every cold start.
  const mod = await import('playwright')
  return mod.chromium ?? mod.default?.chromium ?? mod
}

/**
 * Launch (or re-launch) a Playwright BrowserContext + Page for a Yana
 * session. If the session is already in memory, returns the cached
 * handles. Otherwise creates a fresh chromium context, optionally
 * loading storage_state from disk so the supervised login persists
 * across cycles.
 */
export async function launchSession({
  sessionId,
  url,
  headless: headlessOverride = null,
  storageStatePath: storageStatePathOverride = null,
} = {}) {
  if (!sessionId) throw new Error('sessionId required')
  if (!isBrowserAutomationEnabled()) {
    const err = new Error('YANA_ENABLE_BROWSER_AUTOMATION is not set; browser automation disabled')
    err.code = 'BROWSER_DISABLED'
    err.status = 412
    throw err
  }
  const existing = liveSessions.get(sessionId)
  if (existing && !existing.closed) {
    if (url) {
      try { await existing.page.goto(url, { waitUntil: 'domcontentloaded' }) } catch { /* ignore */ }
    }
    return existing
  }

  const defaults = getBrowserDefaults()
  const headless = typeof headlessOverride === 'boolean' ? headlessOverride : defaults.headless
  const storageStatePath = storageStatePathOverride || storageStatePathFor(sessionId)

  const chromium = await loadPlaywright()
  const browser = await chromium.launch({ headless })
  const contextOptions = { acceptDownloads: false }
  if (fs.existsSync(storageStatePath)) {
    contextOptions.storageState = storageStatePath
  }
  const context = await browser.newContext(contextOptions)
  context.setDefaultTimeout(defaults.timeoutMs)
  const page = await context.newPage()

  if (url) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
    } catch (err) {
      // Don't crash the launch — surface goto failures to the caller.
      console.warn(`[yanaBrowser] navigation failed: ${err?.message || err}`)
    }
  }

  const handle = {
    sessionId, browser, context, page,
    storageStatePath, headless, closed: false,
  }
  liveSessions.set(sessionId, handle)
  return handle
}

export function getLiveSession(sessionId) {
  const handle = liveSessions.get(sessionId)
  if (!handle || handle.closed) return null
  return handle
}

export async function captureStorageState(sessionId) {
  const handle = getLiveSession(sessionId)
  if (!handle) return null
  try {
    await handle.context.storageState({ path: handle.storageStatePath })
    return handle.storageStatePath
  } catch {
    return null
  }
}

export async function takeScreenshot(sessionId, label = 'snapshot') {
  const handle = getLiveSession(sessionId)
  if (!handle) return null
  const target = screenshotPathFor(sessionId, label)
  try {
    await handle.page.screenshot({ path: target, fullPage: true })
    return target
  } catch (err) {
    console.warn(`[yanaBrowser] screenshot failed: ${err?.message || err}`)
    return null
  }
}

export async function closeSession(sessionId, { keepStorage = true } = {}) {
  const handle = liveSessions.get(sessionId)
  if (!handle) return
  liveSessions.delete(sessionId)
  if (handle.closed) return
  handle.closed = true
  try {
    if (keepStorage) {
      try { await handle.context.storageState({ path: handle.storageStatePath }) } catch { /* ignore */ }
    }
  } finally {
    try { await handle.context.close() } catch { /* ignore */ }
    try { await handle.browser.close() } catch { /* ignore */ }
  }
}

export async function closeAllSessions() {
  const ids = Array.from(liveSessions.keys())
  await Promise.all(ids.map((id) => closeSession(id)))
}

// Best-effort cleanup if the Node process exits.
process.once('exit', () => { liveSessions.forEach((h) => { try { h.browser?.close?.() } catch { /* ignore */ } }) })
process.once('SIGINT', async () => { await closeAllSessions() })
process.once('SIGTERM', async () => { await closeAllSessions() })
