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
 *       backend launches its OWN headless Playwright Chromium (the same
 *       Playwright that already ships in the production image for Hamilton
 *       browser automation) and opens the portal login page. The interactive
 *       surface is served by GrantFlow ITSELF: the live page is mirrored to the
 *       user's browser frame-by-frame over a same-origin SSE stream (CDP
 *       `Page.startScreencast`), and the user's clicks / typing are relayed back
 *       over a same-origin POST endpoint (CDP `Input.*`). Because both the
 *       stream and the input channel ride the app's own single public port, this
 *       works on Railway with no extra ports, no devtools exposure, and no
 *       third-party service. ON globally so any profile can capture a session.
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
 * HONEST LIMITATIONS:
 *   - The session CAPTURE (storageState) is fully real in every mode.
 *   - The self_hosted live view is a JPEG screencast (quality ~60); it is a
 *     real, drivable mirror of the page but not pixel-perfect video, and input
 *     has a small round-trip latency (one POST per event). That is fine for
 *     typing credentials + approving a 2FA push.
 *   - Live sessions are held in-memory with a TTL; a SINGLE backend instance is
 *     assumed for the interactive window (the stream/input endpoints must reach
 *     the same instance that holds the live browser). Acceptable for capture.
 */

import http from 'node:http'
import { CHROMIUM_CONTAINER_ARGS } from './browserLaunch.js'
import https from 'node:https'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamiltonCloudLogin')

const SESSION_TTL_MS = 15 * 60_000
// liveSessionId -> {
//   browser, server, context, page, meta, createdAt,
//   screencastCdp,   // CDP session driving Page.startScreencast (1 active stream)
//   inputCdp,        // CDP session for Input.* dispatch
//   lastFrameMeta,   // { deviceWidth, deviceHeight, ... } from the latest frame
// }
const sessions = new Map()

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
  try { await s?.screencastCdp?.detach() } catch { /* ignore */ }
  try { await s?.inputCdp?.detach() } catch { /* ignore */ }
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
 * Build the same-origin live-view URL the user opens. The frontend route mirrors
 * the page (SSE screencast) and relays input — so it's our own page, served on
 * the app's single public port. The caller (route) supplies the public origin;
 * we just encode the live session + portal host. We pass a relative URL when no
 * origin is known so the frontend resolves it against its own origin.
 */
function buildSelfHostedLiveUrl({ liveSessionId, portalHost, origin }) {
  const params = new URLSearchParams({ session: liveSessionId })
  if (portalHost) params.set('host', portalHost)
  const path = `/HamiltonLiveLogin?${params.toString()}`
  return origin ? `${String(origin).replace(/\/+$/, '')}${path}` : path
}

/**
 * Start an interactive cloud login. Returns { ok, liveSessionId, liveUrl } on
 * success, or { ok:false, reason } when not configured / unsupported.
 *
 * `origin` (optional) is the public origin of the calling request so the
 * self_hosted liveUrl can be absolute; if omitted a relative URL is returned.
 */
export async function startCloudLogin({ userId, profileId, portalHost, loginUrl, label, captureRequestId = null, origin = null } = {}) {
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
  try {
    if (provider === 'cdp') {
      // Hosted interactive Chrome (Browserless / Browserbase).
      browser = await chromium.connectOverCDP(cdpEndpoint())
      const context = browser.contexts()[0] || (await browser.newContext())
      const page = context.pages()[0] || (await context.newPage())
      await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {})
      const liveUrl = await acquireProviderLiveUrl(page)
      if (!liveUrl) {
        await closeQuietly({ browser })
        return { ok: false, reason: 'provider_no_live_url' }
      }
      return finalizeStart({ browser, server: null, context, page, userId, profileId, portalHost, target, label, captureRequestId, liveUrl })
    }

    // self_hosted: launch our OWN headless Chromium. We mirror the page to the
    // user's browser ourselves (SSE screencast + POST input), so we don't need a
    // remote-debugging port, a devtools front-end, or a public devtools base.
    // CDP Page.startScreencast works fine in headless Chromium.
    browser = await chromium.launch({
      headless: true,
      // --disable-blink-features=AutomationControlled hides the navigator.webdriver
      // automation flag, which bot-detection (e.g. studentaid.gov / FAFSA behind
      // Akamai) uses to serve a BLANK page to an obviously-automated browser.
      args: [...CHROMIUM_CONTAINER_ARGS, '--disable-blink-features=AutomationControlled'],
    })
    // A realistic UA + locale further reduces "this is a bot" blank-page blocks
    // on hardened portals. The user still drives the page; we only soften the
    // automation fingerprint so the login page actually renders.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
    })
    const page = await context.newPage()
    await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {})
    const liveSessionId = makeLiveSessionId()
    const liveUrl = buildSelfHostedLiveUrl({ liveSessionId, portalHost, origin })
    return finalizeStart({ browser, server: null, context, page, userId, profileId, portalHost, target, label, captureRequestId, liveUrl, liveSessionId })
  } catch (err) {
    await closeQuietly({ browser })
    log.error('cloud login start failed', { error: err?.message, provider })
    return { ok: false, reason: 'connect_failed', detail: err?.message }
  }
}

function makeLiveSessionId() {
  return `cl_${Date.now().toString(36)}_${Math.floor(performance.now()).toString(36)}`
}

function finalizeStart({ browser, server, context, page, userId, profileId, portalHost, target, label, captureRequestId, liveUrl, liveSessionId }) {
  const id = liveSessionId || makeLiveSessionId()
  sessions.set(id, {
    browser, server, context, page,
    screencastCdp: null,
    inputCdp: null,
    lastFrameMeta: null,
    meta: { userId, profileId: String(profileId), portalHost, loginUrl: target, label, captureRequestId },
    createdAt: Date.now(),
  })
  log.info('cloud login session started', { liveSessionId: id, profileId: String(profileId), portalHost, provider: cloudLoginProvider() })
  return { ok: true, liveSessionId: id, liveUrl, expires_in_ms: SESSION_TTL_MS }
}

export function getCloudLoginMeta(liveSessionId) {
  const s = sessions.get(liveSessionId)
  return s ? { ...s.meta, createdAt: s.createdAt } : null
}

/**
 * Live-view accessor used by the stream + input routes. Returns the raw session
 * record (page, meta, cdp handles) or null when the session is gone/expired.
 * The route is responsible for the profile-access check via meta before use.
 */
export function getCloudLoginSession(liveSessionId) {
  return sessions.get(liveSessionId) || null
}

/**
 * Open (once) a CDP screencast on the live page and invoke onFrame for every
 * frame. The caller (SSE route) acks each frame and forwards it to the client;
 * we record the latest frame metadata so the input route can scale normalized
 * coordinates. Returns a stop() that detaches and stops the screencast.
 *
 * Only ONE screencast viewer is supported per live session (the capture flow is
 * single-viewer by design). Re-attaching stops any prior screencast first.
 */
export async function startScreencast(liveSessionId, onFrame, { quality = 60, maxWidth = 1280, maxHeight = 1280 } = {}) {
  const s = sessions.get(liveSessionId)
  if (!s || !s.page) return null
  // Tear down a previous viewer's screencast if one was left attached.
  if (s.screencastCdp) {
    try { await s.screencastCdp.send('Page.stopScreencast') } catch { /* ignore */ }
    try { await s.screencastCdp.detach() } catch { /* ignore */ }
    s.screencastCdp = null
  }
  const cdp = await s.page.context().newCDPSession(s.page)
  s.screencastCdp = cdp
  let frameCount = 0
  cdp.on('Page.screencastFrame', async (frame) => {
    try {
      if (frameCount === 0) log.info('cloud login first frame delivered', { liveSessionId })
      frameCount += 1
      s.lastFrameMeta = frame?.metadata || s.lastFrameMeta
      onFrame({ data: frame.data, metadata: frame.metadata })
    } catch { /* consumer error — ignore, keep stream alive */ }
    try { await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }) } catch { /* ignore */ }
  })
  // Enable the Page domain BEFORE starting the screencast. A raw CDP session
  // (Playwright's newCDPSession) does not auto-enable Page; without it some
  // Chromium builds accept Page.startScreencast but never emit Page.screencastFrame
  // events — a silent "zero frames / connecting forever" stream. Cheap insurance.
  try { await cdp.send('Page.enable') } catch { /* older builds may not require it */ }
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality,
    maxWidth,
    maxHeight,
    everyNthFrame: 1,
  })
  log.info('cloud login screencast started', { liveSessionId, quality, maxWidth, maxHeight })
  return async function stop() {
    try { await cdp.send('Page.stopScreencast') } catch { /* ignore */ }
    try { await cdp.detach() } catch { /* ignore */ }
    if (s.screencastCdp === cdp) s.screencastCdp = null
  }
}

/** Lazily create (and cache) the Input.* CDP session for a live session. */
async function ensureInputCdp(s) {
  if (s.inputCdp) return s.inputCdp
  s.inputCdp = await s.page.context().newCDPSession(s.page)
  return s.inputCdp
}

/**
 * Translate ONE normalized input event into a CDP Input.* dispatch on the live
 * page. Coordinates (x, y) arrive as 0..1 fractions of the displayed image; we
 * scale them by the page viewport (preferring the latest screencast frame's
 * device size, falling back to the Playwright viewport). Returns { ok } or
 * { ok:false, reason }.
 */
export async function dispatchInput(liveSessionId, event) {
  const s = sessions.get(liveSessionId)
  if (!s || !s.page) return { ok: false, reason: 'not_found_or_expired' }
  if (!event || typeof event !== 'object') return { ok: false, reason: 'bad_event' }

  const cdp = await ensureInputCdp(s)
  const vp = s.page.viewportSize() || { width: 1280, height: 900 }
  const width = Number(s.lastFrameMeta?.deviceWidth) || vp.width || 1280
  const height = Number(s.lastFrameMeta?.deviceHeight) || vp.height || 900

  const scaleX = (nx) => Math.max(0, Math.min(width, Math.round(Number(nx) * width)))
  const scaleY = (ny) => Math.max(0, Math.min(height, Math.round(Number(ny) * height)))

  const type = String(event.type || '')

  try {
    if (type === 'mousemove' || type === 'mousedown' || type === 'mouseup' || type === 'click') {
      const x = scaleX(event.x)
      const y = scaleY(event.y)
      const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left'
      if (type === 'mousemove') {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
      } else if (type === 'mousedown') {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
      } else if (type === 'mouseup') {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
      } else {
        // A full tap/click: move + press + release.
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
      }
      return { ok: true }
    }

    if (type === 'wheel' || type === 'scroll') {
      const x = scaleX(event.x)
      const y = scaleY(event.y)
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: Number(event.deltaX) || 0,
        deltaY: Number(event.deltaY) || 0,
      })
      return { ok: true }
    }

    if (type === 'keydown' || type === 'keyup' || type === 'char') {
      const cdpType = type === 'keydown' ? 'keyDown' : type === 'keyup' ? 'keyUp' : 'char'
      const payload = {
        type: cdpType,
        key: typeof event.key === 'string' ? event.key : undefined,
        code: typeof event.code === 'string' ? event.code : undefined,
        text: typeof event.text === 'string' ? event.text : undefined,
        windowsVirtualKeyCode: Number.isFinite(event.keyCode) ? event.keyCode : undefined,
        modifiers: Number.isFinite(event.modifiers) ? event.modifiers : 0,
      }
      await cdp.send('Input.dispatchKeyEvent', payload)
      return { ok: true }
    }

    return { ok: false, reason: 'unsupported_event' }
  } catch (err) {
    return { ok: false, reason: 'dispatch_failed', detail: err?.message }
  }
}

/**
 * Fetch JSON from a CDP http debug endpoint. Retained for the (still supported)
 * cdp provider's optional health probing; unused by self_hosted now.
 */
export function fetchDebugJson(httpBase, pathSuffix = '/json/list') {
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
    // self_hosted now serves the interactive view from GrantFlow itself (a
    // same-origin SSE screencast + POST input), so it needs NO public devtools
    // base and works on a single-port PaaS out of the box.
    requires_public_base: false,
    reason: configured
      ? null
      : 'Cloud login is disabled (HAMILTON_CLOUD_LOGIN_PROVIDER=disabled). Use Saved Login, or set HAMILTON_CLOUD_LOGIN_PROVIDER=self_hosted (default) / =cdp with HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT.',
  }
}
