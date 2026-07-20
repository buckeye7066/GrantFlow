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
import { launchPortalBrowser, REALISTIC_PORTAL_UA } from './browserLaunch.js'
import https from 'node:https'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamiltonCloudLogin')

const SESSION_TTL_MS = 15 * 60_000
// liveSessionId -> {
//   browser, server, context, page, meta, createdAt,
//   screencastCdp,   // CDP session driving Page.startScreencast (1 active stream)
//   inputCdp,        // CDP session for Input.* dispatch
//   keyframeTimer,   // idle-keyframe interval (see attachScreencast)
//   lastFrameMeta,   // { deviceWidth, deviceHeight, ... } from the latest frame
// }
const sessions = new Map()

// JPEG quality for keyframe screenshots (matches the screencast stream quality).
const KEYFRAME_QUALITY = 60
// When the compositor is idle (no screencast frame for this long) we push a
// fresh screenshot keyframe so the mirror never silently goes blank/stale. A
// fully-loaded static login page emits NO Page.screencastFrame until something
// repaints, so without this the canvas stays a blank white box forever even
// though the stream is "connected" — the reported bug. ~1 fps idle is cheap.
const KEYFRAME_IDLE_MS = Math.max(250, Number(process.env.CLOUD_LOGIN_KEYFRAME_MS) || 1000)

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
  try { if (s?.keyframeTimer) clearInterval(s.keyframeTimer) } catch { /* ignore */ }
  if (s) s.keyframeTimer = null
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
      const nav = await navigateOrFail(page, target)
      if (!nav.ok) {
        await closeQuietly({ browser })
        log.error('cloud login navigation failed', { provider, target, portalHost, detail: nav.detail })
        return nav
      }
      const liveUrl = await acquireProviderLiveUrl(page)
      if (!liveUrl) {
        await closeQuietly({ browser })
        return { ok: false, reason: 'provider_no_live_url' }
      }
      return finalizeStart({ browser, server: null, context, page, userId, profileId, portalHost, target, label, captureRequestId, liveUrl })
    }

    // self_hosted: launch our OWN headless Chromium via the shared hardened
    // portal launcher (full Chromium new-headless, falling back to the shell —
    // see browserLaunch.js for the measured studentaid.gov evidence). We mirror
    // the page to the user's browser ourselves (SSE screencast + POST input), so
    // we don't need a remote-debugging port, a devtools front-end, or a public
    // devtools base. CDP Page.startScreencast works in both engines.
    const launched = await launchPortalBrowser(chromium)
    browser = launched.browser
    log.info('cloud login browser launched', { engine: launched.engine, portalHost })
    // A realistic UA + locale further reduces "this is a bot" blank-page blocks
    // on hardened portals. The user still drives the page; we only soften the
    // automation fingerprint so the login page actually renders.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: REALISTIC_PORTAL_UA,
      locale: 'en-US',
    })
    const page = await context.newPage()
    const nav = await navigateOrFail(page, target)
    if (!nav.ok) {
      await closeQuietly({ browser })
      log.error('cloud login navigation failed', { provider, target, portalHost, detail: nav.detail })
      return nav
    }
    const liveSessionId = makeLiveSessionId()
    const liveUrl = buildSelfHostedLiveUrl({ liveSessionId, portalHost, origin })
    return finalizeStart({ browser, server: null, context, page, userId, profileId, portalHost, target, label, captureRequestId, liveUrl, liveSessionId })
  } catch (err) {
    await closeQuietly({ browser })
    log.error('cloud login start failed', { error: err?.message, provider })
    return { ok: false, reason: 'connect_failed', detail: err?.message }
  }
}

// Navigate the live page and actually observe whether it worked. The prior
// code did `page.goto(target, {...}).catch(() => {})` and then unconditionally
// declared the session started — so a failed navigation (bad URL, timeout, DNS
// failure, host down) left the browser sitting on about:blank forever while the
// caller still got `{ ok: true }`. The live-login window then opens, connects
// its screencast successfully, and paints a real (blank) frame of about:blank —
// which reads as "Live" with nothing on screen, indistinguishable from the
// bot-detection/no-repaint bugs already fixed, but never reported and never
// fixed by them. Returns { ok:true } or { ok:false, reason, detail }.
async function navigateOrFail(page, target) {
  let navError = null
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  } catch (err) {
    navError = err
  }
  const landedUrl = (() => { try { return page.url() } catch { return null } })()
  if (navError || !landedUrl || landedUrl === 'about:blank') {
    return { ok: false, reason: 'navigation_failed', detail: navError?.message || `stayed_on_blank_page (target: ${target})` }
  }
  return { ok: true }
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
    keyframeTimer: null,
    lastFrameMeta: null,
    meta: { userId, profileId: String(profileId), portalHost, loginUrl: target, label, captureRequestId },
    createdAt: Date.now(),
  })
  log.info('cloud login session started', { liveSessionId: id, profileId: String(profileId), portalHost, provider: cloudLoginProvider() })
  return { ok: true, liveSessionId: id, liveUrl, portalHost, expires_in_ms: SESSION_TTL_MS }
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
 * Capture ONE JPEG keyframe of the live page via CDP and shape it exactly like a
 * Page.screencastFrame ({ data, metadata }) so the same draw path handles both.
 *
 * This is the fix for the "connected but blank white canvas" bug: CDP
 * Page.startScreencast only emits a frame when the compositor REPAINTS, and a
 * static, already-loaded login page produces no repaint — so the viewer would
 * wait forever for a first frame it can never receive (and, seeing nothing, the
 * user never interacts to trigger one: a deadlock). An explicit screenshot gives
 * the canvas real pixels immediately, independent of any repaint.
 *
 * Best-effort: returns null (never throws) if the page is gone / the screenshot
 * fails, so it can never break the live stream.
 */
export async function captureKeyframe(cdp, page, quality = KEYFRAME_QUALITY) {
  try {
    if (!cdp || !page) return null
    const vp = (typeof page.viewportSize === 'function' && page.viewportSize()) || { width: 1280, height: 900 }
    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality })
    if (!shot || !shot.data) return null
    return {
      data: shot.data,
      metadata: {
        deviceWidth: vp.width,
        deviceHeight: vp.height,
        pageScaleFactor: 1,
        offsetTop: 0,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        timestamp: Date.now() / 1000,
        keyframe: true,
      },
    }
  } catch {
    return null
  }
}

/**
 * Attach the frame source to a live session and invoke onFrame for every frame.
 * The frame source is CDP Page.startScreencast (live repaints) PLUS an immediate
 * keyframe screenshot and an idle-keyframe net so the viewer paints even when the
 * compositor is quiet. The caller (SSE route) forwards each frame to the client;
 * we record the latest frame metadata so the input route can scale normalized
 * coordinates. Returns a stop() that tears down the screencast + keyframe timer.
 *
 * Exported (taking the session record directly) so it is unit-testable without a
 * real browser: pass a fake session whose page.context().newCDPSession() yields a
 * fake CDP that never emits Page.screencastFrame, and assert onFrame still fires.
 *
 * Only ONE screencast viewer is supported per live session (the capture flow is
 * single-viewer by design). Re-attaching stops any prior screencast first.
 */
export async function attachScreencast(s, onFrame, { quality = KEYFRAME_QUALITY, maxWidth = 1280, maxHeight = 1280 } = {}) {
  if (!s || !s.page) return null
  const liveSessionId = s.__id
  // Tear down a previous viewer's screencast / keyframe loop if one was left on.
  if (s.screencastCdp) {
    try { await s.screencastCdp.send('Page.stopScreencast') } catch { /* ignore */ }
    try { await s.screencastCdp.detach() } catch { /* ignore */ }
    s.screencastCdp = null
  }
  if (s.keyframeTimer) { clearInterval(s.keyframeTimer); s.keyframeTimer = null }

  const cdp = await s.page.context().newCDPSession(s.page)
  s.screencastCdp = cdp
  let frameCount = 0
  let lastFrameAt = 0

  // Single emit path for both live screencast frames and keyframe screenshots:
  // record metadata (for input coordinate scaling), mark the time (idle net),
  // and forward. A consumer error never kills the stream.
  const emit = (frame) => {
    if (!frame || !frame.data) return
    s.lastFrameMeta = frame.metadata || s.lastFrameMeta
    lastFrameAt = Date.now()
    try { onFrame(frame) } catch { /* consumer error — ignore, keep stream alive */ }
  }

  cdp.on('Page.screencastFrame', async (frame) => {
    try {
      if (frameCount === 0) log.info('cloud login first frame delivered', { liveSessionId })
      frameCount += 1
      emit({ data: frame.data, metadata: frame.metadata })
    } catch { /* ignore */ }
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

  // Immediate keyframe — the canvas gets real pixels NOW, without waiting for a
  // repaint a static page will never produce.
  const initial = await captureKeyframe(cdp, s.page, quality)
  if (initial) emit(initial)

  // Idle keyframe net: while the compositor is quiet (no frame within
  // KEYFRAME_IDLE_MS) push a fresh screenshot, so the mirror stays live even for
  // changes that happen WITHOUT local input (a 2FA redirect, a server push) and
  // so a missed initial screencast frame self-heals within ~1s.
  s.keyframeTimer = setInterval(async () => {
    if (Date.now() - lastFrameAt < KEYFRAME_IDLE_MS) return
    const kf = await captureKeyframe(cdp, s.page, quality)
    if (kf) emit(kf)
  }, KEYFRAME_IDLE_MS)
  if (typeof s.keyframeTimer.unref === 'function') s.keyframeTimer.unref()

  log.info('cloud login screencast started', { liveSessionId, quality, maxWidth, maxHeight })
  return async function stop() {
    if (s.keyframeTimer) { clearInterval(s.keyframeTimer); s.keyframeTimer = null }
    try { await cdp.send('Page.stopScreencast') } catch { /* ignore */ }
    try { await cdp.detach() } catch { /* ignore */ }
    if (s.screencastCdp === cdp) s.screencastCdp = null
  }
}

/**
 * Open (once) a CDP screencast on the live page identified by liveSessionId and
 * invoke onFrame for every frame. Thin lookup wrapper over attachScreencast.
 * Returns a stop() that detaches and stops the screencast, or null if the
 * session is gone.
 */
export async function startScreencast(liveSessionId, onFrame, opts = {}) {
  const s = sessions.get(liveSessionId)
  if (!s || !s.page) return null
  s.__id = liveSessionId
  return attachScreencast(s, onFrame, opts)
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
