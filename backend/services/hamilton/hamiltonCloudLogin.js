/**
 * Hamilton cloud interactive login (Option B).
 *
 * Goal: let a user on ANY device (including a phone), independent of the owner,
 * log into a portal once and have Hamilton capture the resulting session — so
 * future runs skip both login AND 2FA, even for push-2FA portals. Hamilton
 * never sees the password or the 2FA code; she only reuses the resulting
 * (AES-256-GCM-encrypted, profile-bound, revocable) Playwright storageState.
 *
 * PROVIDERS (HAMILTON_CLOUD_LOGIN_PROVIDER):
 *
 *   - self_hosted (DEFAULT)  No third-party service, no paid API key. The
 *       backend launches its OWN Playwright Chromium (the same Playwright that
 *       already ships in the production image for Hamilton browser automation)
 *       via chromium.launchServer(), connects to it over CDP, opens the portal
 *       login page, and derives an interactive "live URL" from Chromium's own
 *       built-in DevTools front-end (which includes a screencast the user can
 *       see and drive). This is ON globally so any profile can capture a
 *       session — no per-deploy env required.
 *
 *   - cdp                    A HOSTED interactive Chrome (a CDP provider such as
 *       Browserless/Browserbase) reached via HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT.
 *       These providers expose a first-class streamed live URL (Browserless
 *       `Browserless.liveURL`), which is the smoothest phone experience but is a
 *       paid third party. Used automatically when the endpoint is set.
 *
 *   - disabled               Turn the feature off entirely (callers fall back to
 *       Saved Login). Set HAMILTON_CLOUD_LOGIN_PROVIDER=disabled.
 *
 * INTERACTIVE-VIEW LIMITATION (be honest):
 *   The session CAPTURE (storageState) is fully real in every mode. The
 *   interactive *viewing* surface differs:
 *     - cdp providers stream a polished live URL anywhere.
 *     - self_hosted serves Chromium's own DevTools inspector. That page is only
 *       reachable if the host's devtools port is reachable by the user's
 *       browser. On a single-port PaaS (e.g. Railway) that port is not publicly
 *       routed by default, so set HAMILTON_CLOUD_LOGIN_PUBLIC_BASE to a base URL
 *       that reverse-proxies the devtools endpoint (or run the cdp provider).
 *       On local/self-hosted boxes the devtools URL works as-is. We NEVER fake a
 *       live URL: if none can be produced, start fails with a clear reason.
 *
 *   - Live sessions are held in-memory with a TTL; a single backend instance is
 *     assumed for the interactive window (acceptable for the capture flow).
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamiltonCloudLogin')

const SESSION_TTL_MS = 15 * 60_000
const sessions = new Map() // liveSessionId -> { browser, server, context, page, meta, createdAt }

const DEFAULT_PROVIDER = 'self_hosted'

/**
 * Resolve the active provider. Defaults to self_hosted so cloud login is
 * available GLOBALLY without any per-deploy env. A configured CDP endpoint
 * implies the `cdp` provider unless the operator explicitly chose otherwise.
 */
export function cloudLoginProvider() {
  const explicit = String(process.env.HAMILTON_CLOUD_LOGIN_PROVIDER || '').trim().toLowerCase()
  if (explicit) return explicit
  if (cdpEndpoint()) return 'cdp'
  return DEFAULT_PROVIDER
}

function cdpEndpoint() {
  return String(process.env.HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT || '').trim()
}

function publicDevtoolsBase() {
  return String(process.env.HAMILTON_CLOUD_LOGIN_PUBLIC_BASE || '').trim().replace(/\/+$/, '')
}

/**
 * Is cloud login available on this deployment?
 *   - disabled         → never
 *   - cdp              → only when an endpoint is configured
 *   - self_hosted      → always (uses the shipped Playwright). GLOBAL default.
 * Back-compat: an explicit HAMILTON_CLOUD_LOGIN_ENABLED=false still disables.
 */
export function isCloudLoginConfigured() {
  if (String(process.env.HAMILTON_CLOUD_LOGIN_ENABLED || '').toLowerCase() === 'false') return false
  const provider = cloudLoginProvider()
  if (provider === 'disabled' || provider === 'off' || provider === 'none') return false
  if (provider === 'cdp') return cdpEndpoint().length > 0
  // self_hosted (and any unknown value treated as self_hosted) is always on.
  return true
}

function sweepExpired() {
  const now = Date.now()
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      closeQuietly(s)
      sessions.delete(id)
    }
  }
}

async function closeQuietly(s) {
  try { await s?.browser?.close() } catch { /* ignore */ }
  try { await s?.server?.close() } catch { /* ignore */ }
}

/**
 * Ask a HOSTED CDP provider for an interactive "live URL". Implemented for
 * Browserless's `Browserless.liveURL` CDP command; providers that don't support
 * it return null.
 */
async function acquireProviderLiveUrl(page) {
  try {
    const cdp = await page.context().newCDPSession(page)
    const res = await cdp.send('Browserless.liveURL').catch(() => null)
    if (res && (res.liveURL || res.url)) return res.liveURL || res.url
  } catch { /* provider doesn't support it */ }
  return null
}

/**
 * Fetch JSON from a CDP http debug endpoint (e.g. http://127.0.0.1:PORT/json).
 */
function fetchDebugJson(httpBase, pathSuffix = '/json/list') {
  return new Promise((resolve) => {
    let url
    try { url = new URL(`${httpBase.replace(/\/+$/, '')}${pathSuffix}`) } catch { return resolve(null) }
    const client = url.protocol === 'https:' ? https : http
    const req = client.get(url, { timeout: 4000 }, (resp) => {
      let body = ''
      resp.on('data', (c) => { body += c })
      resp.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

/** Reserve a free localhost TCP port for Chromium's remote-debugging endpoint. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** Poll the CDP http endpoint until Chromium is listening (or time out). */
async function waitForDebugEndpoint(httpBase, { tries = 30, intervalMs = 200 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ver = await fetchDebugJson(httpBase, '/json/version')
    if (ver) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

/**
 * Derive an interactive live URL for the SELF-HOSTED Chromium from its built-in
 * DevTools front-end. We hit the CDP http endpoint's /json/list to get the
 * page's devtoolsFrontendUrl (a real, interactive remote inspector with a
 * screencast). When HAMILTON_CLOUD_LOGIN_PUBLIC_BASE is set we rebase the URL
 * onto that public origin so a remote user (phone) can reach it through a
 * reverse proxy; otherwise we return the local devtools URL (works on local /
 * self-hosted hosts and when the port is otherwise reachable).
 *
 * Returns null when no interactive surface can be produced — we never fake one.
 */
async function acquireSelfHostedLiveUrl(httpBase) {
  const list = await fetchDebugJson(httpBase)
  const pageEntry = Array.isArray(list)
    ? (list.find((e) => e.type === 'page' && e.devtoolsFrontendUrl) || list.find((e) => e.devtoolsFrontendUrl))
    : null
  if (!pageEntry?.devtoolsFrontendUrl) return null

  const pub = publicDevtoolsBase()
  if (!pub) {
    // Local devtools URL: absolute when the entry gives one, else prefix the host.
    const f = pageEntry.devtoolsFrontendUrl
    return /^https?:\/\//i.test(f) ? f : `${httpBase}${f.startsWith('/') ? '' : '/'}${f}`
  }
  // Rebase the devtools frontend path + ws query onto the public proxy origin.
  // The frontend URL embeds ?ws=<host>/<guid>; rewrite that host to the public
  // base so the inspector connects back through the same proxy.
  try {
    const local = new URL(/^https?:\/\//i.test(pageEntry.devtoolsFrontendUrl)
      ? pageEntry.devtoolsFrontendUrl
      : `${httpBase}${pageEntry.devtoolsFrontendUrl}`)
    const pubUrl = new URL(pub)
    const wsQuery = local.searchParams.get('ws')
    if (wsQuery) {
      const wsRebased = wsQuery.replace(/^[^/]+/, pubUrl.host)
      local.searchParams.set('ws', wsRebased)
    }
    return `${pub}${local.pathname}${local.search}`
  } catch {
    return null
  }
}

/**
 * Start an interactive cloud login. Returns { ok, liveSessionId, liveUrl } on
 * success, or { ok:false, reason } when not configured / unsupported.
 */
export async function startCloudLogin({ userId, profileId, portalHost, loginUrl, label, captureRequestId = null } = {}) {
  if (!isCloudLoginConfigured()) return { ok: false, reason: 'not_configured' }
  sweepExpired()
  const target = loginUrl || (portalHost ? `https://${portalHost}/` : null)
  if (!profileId || !portalHost || !target) return { ok: false, reason: 'missing_params' }

  let chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch {
    return { ok: false, reason: 'playwright_unavailable' }
  }

  const provider = cloudLoginProvider()
  let browser
  let server = null
  try {
    let liveUrl = null
    if (provider === 'cdp') {
      // Hosted interactive Chrome (Browserless / Browserbase).
      browser = await chromium.connectOverCDP(cdpEndpoint())
      const context = browser.contexts()[0] || (await browser.newContext())
      const page = context.pages()[0] || (await context.newPage())
      await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {})
      liveUrl = await acquireProviderLiveUrl(page)
      if (!liveUrl) {
        await closeQuietly({ browser })
        return { ok: false, reason: 'provider_no_live_url' }
      }
      return finalizeStart({ browser, server: null, context, page, userId, profileId, portalHost, target, label, captureRequestId, liveUrl })
    }

    // self_hosted: launch our OWN Chromium with a real Chrome remote-debugging
    // port. We drive it with normal Playwright objects (no connectOverCDP — that
    // expects a raw CDP socket; launch() gives us the browser directly) AND mine
    // the debug port's /json endpoint for Chromium's built-in DevTools front-end
    // URL, which IS the interactive screencast surface the user opens.
    const debugPort = await pickFreePort()
    const httpBase = `http://127.0.0.1:${debugPort}`
    browser = await chromium.launch({
      headless: false,
      args: [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'],
    })
    const context = browser.contexts()[0] || (await browser.newContext())
    const page = context.pages()[0] || (await context.newPage())
    await waitForDebugEndpoint(httpBase)
    await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {})
    liveUrl = await acquireSelfHostedLiveUrl(httpBase)
    if (!liveUrl) {
      await closeQuietly({ browser, server })
      // Honest failure: the capture engine works, but no interactive surface
      // could be exposed on this host (no reachable devtools port / no public
      // base configured). Don't pretend a window opened.
      return { ok: false, reason: 'no_interactive_surface' }
    }
    return finalizeStart({ browser, server, context, page, userId, profileId, portalHost, target, label, captureRequestId, liveUrl })
  } catch (err) {
    await closeQuietly({ browser, server })
    log.error('cloud login start failed', { error: err?.message, provider })
    return { ok: false, reason: 'connect_failed', detail: err?.message }
  }
}

function finalizeStart({ browser, server, context, page, userId, profileId, portalHost, target, label, captureRequestId, liveUrl }) {
  const liveSessionId = `cl_${Date.now().toString(36)}_${Math.floor(performance.now()).toString(36)}`
  sessions.set(liveSessionId, {
    browser, server, context, page,
    meta: { userId, profileId: String(profileId), portalHost, loginUrl: target, label, captureRequestId },
    createdAt: Date.now(),
  })
  log.info('cloud login session started', { liveSessionId, profileId: String(profileId), portalHost, provider: cloudLoginProvider() })
  return { ok: true, liveSessionId, liveUrl, expires_in_ms: SESSION_TTL_MS }
}

export function getCloudLoginMeta(liveSessionId) {
  const s = sessions.get(liveSessionId)
  return s ? { ...s.meta, createdAt: s.createdAt } : null
}

/**
 * Finish a cloud login: read the authenticated storageState from the live
 * context, tear the browser down, and return the storageState for the caller to
 * import (profile-bound). Returns { ok, storageState, meta } or { ok:false }.
 */
export async function completeCloudLogin(liveSessionId) {
  const s = sessions.get(liveSessionId)
  if (!s) return { ok: false, reason: 'not_found_or_expired' }
  try {
    const storageState = await s.context.storageState()
    sessions.delete(liveSessionId)
    await closeQuietly(s)
    if (!storageState?.cookies?.length && !storageState?.origins?.length) {
      return { ok: false, reason: 'empty_session', meta: s.meta }
    }
    return { ok: true, storageState, meta: s.meta }
  } catch (err) {
    sessions.delete(liveSessionId)
    await closeQuietly(s)
    return { ok: false, reason: 'capture_failed', detail: err?.message }
  }
}

export async function cancelCloudLogin(liveSessionId) {
  const s = sessions.get(liveSessionId)
  if (!s) return { ok: true, already: true }
  sessions.delete(liveSessionId)
  await closeQuietly(s)
  return { ok: true }
}

export function cloudLoginStatus() {
  const configured = isCloudLoginConfigured()
  const provider = cloudLoginProvider()
  return {
    configured,
    provider,
    active_sessions: sessions.size,
    // self_hosted streams Chromium's own DevTools inspector; for remote users on
    // a single-port PaaS, set HAMILTON_CLOUD_LOGIN_PUBLIC_BASE so the inspector
    // is reachable through a reverse proxy. Surfaced so the UI can hint at it.
    requires_public_base: provider === 'self_hosted' && !publicDevtoolsBase(),
    reason: configured
      ? null
      : 'Cloud login is disabled (HAMILTON_CLOUD_LOGIN_PROVIDER=disabled). Use Saved Login, or set HAMILTON_CLOUD_LOGIN_PROVIDER=self_hosted (default) / =cdp with HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT.',
  }
}
