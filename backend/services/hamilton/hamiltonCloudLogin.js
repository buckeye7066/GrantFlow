/**
 * Hamilton cloud interactive login (Option B).
 *
 * The live-login machinery remains testable against GrantFlow's reserved
 * synthetic fixture. Controlled beta never launches it against a real portal;
 * users sign in and submit in their own browser.
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
import {
  controlledBetaBrowserContextOptions,
  installControlledBetaBrowserEgressGuard,
  isPublicHttpsUrl,
  isControlledBetaSyntheticBrowserUrl,
} from './controlledBetaBrowserPolicy.js'
import https from 'node:https'
import { createLogger } from '../../utils/logger.js'
import { findValidSession, getSessionStorageState } from './hamiltonCredentialSessionService.js'
import { getPolicyFor } from './hamiltonPortalPolicyRegistry.js'

const log = createLogger('service:hamiltonCloudLogin')

// Idle-based session lifecycle. The old model was a single absolute TTL
// (15 min from createdAt) checked ONLY when a NEW login started — so an ACTIVE
// user was killed mid-2FA at exactly 15 minutes, while an abandoned session
// leaked its Chromium forever on a quiet deployment (no new login → no sweep).
// Now: a session stays alive while it is actually USED (viewer streaming,
// input flowing, capture in progress) and expires after 15 minutes of true
// inactivity, with a hard 60-minute cap on total lifetime; a background
// sweeper enforces expiry independent of new logins.
const SESSION_IDLE_TTL_MS = 15 * 60_000
const SESSION_MAX_AGE_MS = 60 * 60_000
const SWEEP_INTERVAL_MS = 30_000
// liveSessionId -> {
//   browser, server, context, page, meta, createdAt, expiresAt,
//   completing,      // capture-in-progress guard (see captureCloudLoginState)
//   screencastCdp,   // CDP session driving Page.startScreencast (1 active stream)
//   inputCdp,        // CDP session for Input.* dispatch
//   keyframeTimer,   // idle-keyframe interval (see attachScreencast)
//   lastFrameMeta,   // { deviceWidth, deviceHeight, ... } from the latest frame
// }
const sessions = new Map()

/**
 * Refresh a session's expiry on real activity: expiresAt slides forward to
 * now + IDLE_TTL but never past createdAt + MAX_AGE. Called on viewer connect,
 * on every input event, on every frame sent, and on capture.
 */
function touchSession(s) {
  if (!s) return
  const createdAt = Number(s.createdAt) || Date.now()
  s.expiresAt = Math.min(createdAt + SESSION_MAX_AGE_MS, Date.now() + SESSION_IDLE_TTL_MS)
}

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
    const expiresAt = Number(s.expiresAt) || (Number(s.createdAt) + SESSION_IDLE_TTL_MS)
    if (now > expiresAt) {
      sessions.delete(id)
      closeQuietly(s)
      log.info('cloud login session expired', { liveSessionId: id, idleTtlMs: SESSION_IDLE_TTL_MS, maxAgeMs: SESSION_MAX_AGE_MS })
    }
  }
}

// Background sweeper: idle/over-age sessions must die (and free their
// Chromium) even when no new login ever starts. unref() so the interval never
// holds the process open (tests, graceful shutdown).
const sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS)
if (typeof sweepTimer.unref === 'function') sweepTimer.unref()

async function closeQuietly(s) {
  // FIRST: tell every attached live viewer the session is over. Without this a
  // torn-down session (cancel/complete/TTL sweep) left the viewer's SSE stream
  // OPEN — the 15s heartbeat kept flowing, so the window read "Live" forever
  // over the last painted frame while every click 404'd silently (the
  // "portal looks alive but nothing I click works" report, 2026-07-27).
  try {
    for (const notify of s?.viewers ?? []) {
      try { notify('session_closed') } catch { /* viewer already gone */ }
    }
    if (s?.viewers?.clear) s.viewers.clear()
  } catch { /* ignore */ }
  try { if (s?.keyframeTimer) clearInterval(s.keyframeTimer) } catch { /* ignore */ }
  if (s) s.keyframeTimer = null
  try { await s?.screencastCdp?.detach() } catch { /* ignore */ }
  try { await s?.inputCdp?.detach() } catch { /* ignore */ }
  try { await s?.browser?.close() } catch { /* ignore */ }
  try { await s?.server?.close() } catch { /* ignore */ }
}

/**
 * Register a live-view callback that fires when the session is torn down
 * (complete / cancel / TTL sweep), so the SSE route can END the viewer's
 * stream with a terminal event instead of leaving a heartbeat-alive stream
 * over a dead session. Returns an unregister function (also safe to call
 * after teardown). No-op when the session is already gone.
 */
export function registerCloudLoginViewer(liveSessionId, notify) {
  const s = sessions.get(liveSessionId)
  if (!s || typeof notify !== 'function') return () => {}
  touchSession(s) // a viewer attaching is activity
  if (!s.viewers) s.viewers = new Set()
  s.viewers.add(notify)
  return () => { try { s.viewers?.delete(notify) } catch { /* ignore */ } }
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
 * Load the profile's EXISTING valid saved session for this portal so the live
 * co-browse context can be seeded with it.
 *
 * THE BUG THIS FIXES (the "side-by-side open takes the portal offline" report):
 * every watched open / side-by-side co-browse launched a COLD context — no
 * storageState — even when Hamilton already held a valid captured session for
 * the portal. Two failures followed:
 *   1. The portal rendered SIGNED OUT in the side-by-side window (reads as
 *      "opening the portal with Hamilton logged me out / went offline").
 *   2. Clicking "Done — I've finished logging in" captured that signed-out
 *      cookie jar (real portals always set tracker/CSRF cookies, so the
 *      empty_session guard passes) and importSession OVERWROTE the existing
 *      valid row in place — destroying the agent's working session. The next
 *      keepalive probe / automation run then hit the login wall,
 *      markSessionExpired fired, and the tile flipped to "Can't auto-merge —
 *      open side-by-side login": Hamilton went offline for that portal
 *      REPRODUCIBLY, caused by the very flow meant to keep it fresh.
 *
 * Seeding the context with the saved storageState fixes the lifecycle at the
 * root: the co-browse lands signed in (same REALISTIC_PORTAL_UA fingerprint the
 * capture and keepalive flows use, so WAF-bound cookies stay valid), and "Done"
 * re-captures a refreshed superset of the same session — the keepalive
 * "refresh, never replace" semantic — instead of a logged-out jar.
 *
 * Best-effort: any failure (no db, schema missing, decrypt failure) returns
 * null and the login start proceeds unseeded, exactly as before.
 */
async function loadSeedSession(db, { profileId, portalHost }) {
  if (!db || !profileId || !portalHost) return null
  try {
    const session = await findValidSession(db, { profileId, portalHost })
    if (!session) return null
    const storageState = await getSessionStorageState(db, session.id)
    if (!storageState) return null
    return { storageState, sessionId: session.id }
  } catch (err) {
    log.warn('cloud login session seed lookup failed', { portalHost, error: err?.message })
    return null
  }
}

/**
 * Start an interactive cloud login. Returns { ok, liveSessionId, liveUrl } on
 * success, or { ok:false, reason } when not configured / unsupported.
 *
 * `origin` (optional) is the public origin of the calling request so the
 * self_hosted liveUrl can be absolute; if omitted a relative URL is returned.
 * `db` (optional but passed by the route) lets the self_hosted live context be
 * seeded with the profile's existing valid saved session for the portal — see
 * loadSeedSession above for why omitting this destroyed working sessions.
 * `launchBrowser` is a test-only injectable launcher (same convention as
 * runSessionKeepAliveSweep): async ({ storageState }) => { browser, engine } —
 * it must return a browser whose newContext receives the same options the real
 * launcher's would.
 */
export async function startCloudLogin({ userId, profileId, portalHost, loginUrl, label, captureRequestId = null, origin = null, db = null, launchBrowser = null } = {}) {
  if (!isCloudLoginConfigured()) return { ok: false, reason: 'not_configured' }
  sweepExpired()
  const target = loginUrl || (portalHost ? `https://${portalHost}/` : null)
  if (!profileId || !portalHost || !target) return { ok: false, reason: 'missing_params' }
  const normalizedPortalHost = String(portalHost || '').trim().toLowerCase().replace(/^www\./, '')
  if (!isPublicHttpsUrl(target) && !isControlledBetaSyntheticBrowserUrl(target)) {
    return {
      ok: false,
      reason: 'ssrf_blocked',
      detail: 'Hamilton does not open private, loopback, or non-HTTPS addresses.',
      requires_human_handoff: false,
    }
  }
  const portalPolicy = await getPolicyFor(db, normalizedPortalHost).catch(() => null)
  if (portalPolicy?.automation_allowed === false) {
    return { ok: false, reason: 'portal_automation_forbidden', requires_human_handoff: true }
  }

  let chromium = null
  if (!launchBrowser) {
    try {
      ({ chromium } = await import('playwright'))
    } catch {
      return { ok: false, reason: 'playwright_unavailable' }
    }
  }

  const provider = cloudLoginProvider()
  let browser
  try {
    if (provider === 'cdp' && chromium) {
      // Hosted interactive Chrome (Browserless / Browserbase).
      browser = await chromium.connectOverCDP(cdpEndpoint())
      const context = browser.contexts()[0]
        || (await browser.newContext(controlledBetaBrowserContextOptions()))
      await installControlledBetaBrowserEgressGuard(context)
      const page = context.pages()[0] || (await context.newPage())
      const nav = await navigateOrFail(page, target)
      if (!nav.ok) {
        await closeQuietly({ browser })
        log.error('cloud login navigation failed', { provider, target, portalHost, detail: nav.detail })
        return { ...nav, engine: 'cdp' }
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
    //
    // Seed the context with the profile's existing valid saved session (if any)
    // so a watched open lands SIGNED IN and "Done" refreshes — never replaces —
    // the captured session. See loadSeedSession for the offline-portal bug this
    // fixes; a missing/undecryptable seed degrades to the old cold start.
    const seed = await loadSeedSession(db, { profileId, portalHost })
    const launched = launchBrowser
      ? await launchBrowser({ storageState: seed?.storageState || null })
      : await launchPortalBrowser(chromium, { targetUrl: target, portalPolicy })
    browser = launched.browser ?? launched
    log.info('cloud login browser launched', {
      engine: launched.engine || 'injected', portalHost, seeded: Boolean(seed),
    })
    // A realistic UA + locale further reduces "this is a bot" blank-page blocks
    // on hardened portals. The user still drives the page; we only soften the
    // automation fingerprint so the login page actually renders. The UA MUST
    // stay REALISTIC_PORTAL_UA — Akamai-class WAFs bind captured cookies to the
    // fingerprint, so a seeded session presented under a different UA silently
    // reads as signed out (see browserLaunch.js / hamiltonSessionKeepAlive.js).
    const context = await browser.newContext(controlledBetaBrowserContextOptions({
      viewport: { width: 1280, height: 900 },
      userAgent: REALISTIC_PORTAL_UA,
      locale: 'en-US',
      ...(seed?.storageState ? { storageState: seed.storageState } : {}),
    }))
    await installControlledBetaBrowserEgressGuard(context)
    const page = await context.newPage()
    const nav = await navigateOrFail(page, target)
    if (!nav.ok) {
      await closeQuietly({ browser })
      log.error('cloud login navigation failed', { provider, target, portalHost, detail: nav.detail, engine: launched.engine })
      return { ...nav, engine: launched.engine }
    }
    const liveSessionId = makeLiveSessionId()
    const liveUrl = buildSelfHostedLiveUrl({ liveSessionId, portalHost, origin })
    return finalizeStart({
      browser, server: null, context, page, userId, profileId, portalHost, target,
      label, captureRequestId, liveUrl, liveSessionId,
      seededFromSessionId: seed?.sessionId || null,
    })
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

function finalizeStart({ browser, server, context, page, userId, profileId, portalHost, target, label, captureRequestId, liveUrl, liveSessionId, seededFromSessionId = null }) {
  const id = liveSessionId || makeLiveSessionId()
  const record = {
    browser, server, context, page,
    completing: false,
    screencastCdp: null,
    inputCdp: null,
    keyframeTimer: null,
    lastFrameMeta: null,
    // Live-view teardown callbacks (see registerCloudLoginViewer/closeQuietly):
    // a torn-down session must END its viewer streams, never leave them
    // heartbeat-alive over a dead browser.
    viewers: new Set(),
    meta: {
      userId, profileId: String(profileId), portalHost, loginUrl: target, label, captureRequestId,
      // The saved-session row this live context was seeded from (null = cold
      // start). Recorded so complete/diagnostics can tell a REFRESH capture
      // (seeded, signed-in jar) from a fresh first capture.
      seededFromSessionId: seededFromSessionId || null,
    },
    createdAt: Date.now(),
  }
  record.__id = id
  touchSession(record)
  sessions.set(id, record)
  // Follow SSO popups/new tabs so the mirror always shows the page the user is
  // actually signing in on (see wirePageFollow).
  try { wirePageFollow(record) } catch { /* best-effort */ }
  log.info('cloud login session started', {
    liveSessionId: id, profileId: String(profileId), portalHost,
    provider: cloudLoginProvider(), seeded: Boolean(seededFromSessionId),
  })
  // expires_in_ms is the IDLE window (activity extends it, up to the max age).
  return { ok: true, liveSessionId: id, liveUrl, portalHost, expires_in_ms: SESSION_IDLE_TTL_MS, max_age_ms: SESSION_MAX_AGE_MS, seeded: Boolean(seededFromSessionId) }
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
  // Remember the viewer so a PAGE RETARGET (an SSO popup opening — see
  // retargetLivePage) can move the screencast to the new page and keep feeding
  // the SAME onFrame / the same open SSE response.
  s.activeViewer = { onFrame, quality, maxWidth, maxHeight }
  await attachScreencastToCurrentPage(s)
  return async function stop() {
    s.activeViewer = null
    await teardownScreencast(s)
  }
}

/** Stop + detach the current screencast CDP session and its keyframe timer. */
async function teardownScreencast(s) {
  if (s.keyframeTimer) { clearInterval(s.keyframeTimer); s.keyframeTimer = null }
  const cdp = s.screencastCdp
  s.screencastCdp = null
  if (!cdp) return
  try { await cdp.send('Page.stopScreencast') } catch { /* ignore */ }
  try { await cdp.detach() } catch { /* ignore */ }
}

/**
 * (Re)attach the screencast + keyframe net to s.page for the CURRENT viewer
 * (s.activeViewer). Called on viewer connect and again on every page retarget.
 */
async function attachScreencastToCurrentPage(s) {
  const viewer = s.activeViewer
  if (!viewer || !s.page) return
  const { onFrame, quality, maxWidth, maxHeight } = viewer
  const liveSessionId = s.__id
  // Tear down any previous screencast / keyframe loop first (a prior viewer's,
  // or the previous page's after a retarget).
  await teardownScreencast(s)

  const cdp = await s.page.context().newCDPSession(s.page)
  s.screencastCdp = cdp
  let frameCount = 0
  let lastFrameAt = 0

  // Single emit path for both live screencast frames and keyframe screenshots:
  // record metadata (for input coordinate scaling), mark the time (idle net),
  // and forward. A consumer error never kills the stream.
  const emit = (frame) => {
    // A retarget may have superseded this attach; a stale emitter must not
    // clobber the new page's frame metadata or keep touching the session.
    if (s.screencastCdp !== cdp) return
    if (!frame || !frame.data) return
    s.lastFrameMeta = frame.metadata || s.lastFrameMeta
    lastFrameAt = Date.now()
    // A frame actually SENT to a viewer is activity: while someone is watching
    // the mirror the session must not idle out under them.
    touchSession(s)
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
}

/**
 * Point the live session at a different page (the mirror FOLLOWS the user).
 *
 * THE BUG THIS FIXES (the MTSU "disconnects when I click sign in" report,
 * verified live 2026-07-31): portal sign-in links routinely open the SSO login
 * in a NEW WINDOW — mtsu.edu's "PipelineMT" opens login.microsoftonline.com as
 * a POPUP. The screencast and Input.* CDP sessions were bound to the ORIGINAL
 * page, which never changes, so the real login form existed invisibly
 * server-side while the user's mirror sat frozen on the opener — every click
 * "did nothing" and signing in was structurally impossible on any popup-based
 * portal. Now the mirror retargets: the screencast moves to the new page over
 * the SAME open SSE stream, and the input channel re-attaches lazily (the
 * cached inputCdp is dropped; dispatchInput's existing reattach path rebuilds
 * it against the new s.page).
 */
export async function retargetLivePage(s, page) {
  if (!s || !page || s.page === page) return false
  const candidateUrl = (() => { try { return page.url() } catch { return null } })()
  // Block private/loopback targets to enforce the SSRF floor.
  if (candidateUrl && candidateUrl !== 'about:blank'
      && !isPublicHttpsUrl(candidateUrl)
      && !isControlledBetaSyntheticBrowserUrl(candidateUrl)) {
    try { await page.close?.() } catch { /* best-effort quarantine */ }
    log.warn('cloud login blocked SSRF-unsafe popup', { candidateUrl })
    return false
  }
  s.page = page
  // Frame metadata belongs to the OLD page's compositor; input scaling must not
  // map coordinates through it while the new page's first frame is in flight.
  s.lastFrameMeta = null
  try { await s.inputCdp?.detach?.() } catch { /* already dead */ }
  s.inputCdp = null
  if (s.activeViewer) {
    await attachScreencastToCurrentPage(s)
  }
  return true
}

/**
 * Follow popups/new tabs for the life of a live session: when the portal opens
 * a new window (SSO login, "apply here" tab), the mirror retargets to it; when
 * that window closes (SAML popups close themselves after login), the mirror
 * falls back to the most recent still-open page — typically the opener, now
 * signed in. Best-effort by design: a context without events (tests, hosted
 * cdp providers) simply never retargets.
 */
function wirePageFollow(record) {
  const ctx = record.context
  if (!ctx || typeof ctx.on !== 'function') return
  const isClosed = (p) => { try { return typeof p.isClosed === 'function' ? p.isClosed() : false } catch { return true } }
  // During teardown (cancel/complete/TTL) every page fires 'close' at once; a
  // dead session must not chase CDP attaches against a closing browser.
  const sessionLive = () => sessions.get(record.__id) === record
  record.pageStack = [record.page]

  const onPageClose = (page) => {
    record.pageStack = record.pageStack.filter((p) => p !== page && !isClosed(p))
    if (!sessionLive()) return
    if (record.page !== page) return
    const fallback = record.pageStack[record.pageStack.length - 1]
    if (!fallback) return
    log.info('cloud login popup closed — mirror falling back', { liveSessionId: record.__id })
    retargetLivePage(record, fallback).catch((err) => {
      log.warn('cloud login mirror fallback failed', { error: err?.message })
    })
  }

  const follow = (page) => {
    if (typeof page?.on === 'function') page.on('close', () => onPageClose(page))
  }
  follow(record.page)

  ctx.on('page', (newPage) => {
    try {
      if (!sessionLive()) return
      record.pageStack.push(newPage)
      follow(newPage)
      touchSession(record) // a popup opening is user-driven activity
      log.info('cloud login popup opened — mirror following', { liveSessionId: record.__id })
      retargetLivePage(record, newPage).catch((err) => {
        log.warn('cloud login mirror retarget failed', { error: err?.message })
      })
    } catch { /* never break the context on a follow failure */ }
  })
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
  touchSession(s) // viewer connect is activity
  s.__id = liveSessionId
  return attachScreencast(s, onFrame, opts)
}

/** Lazily create (and cache) the Input.* CDP session for a live session. */
async function ensureInputCdp(s) {
  if (s.inputCdp) return s.inputCdp
  s.inputCdp = await s.page.context().newCDPSession(s.page)
  return s.inputCdp
}

/** Send one normalized event over an already-open Input.* CDP session. */
async function sendInputOverCdp(cdp, s, event) {
  const vp = (typeof s.page.viewportSize === 'function' && s.page.viewportSize()) || { width: 1280, height: 900 }
  const width = Number(s.lastFrameMeta?.deviceWidth) || vp.width || 1280
  const height = Number(s.lastFrameMeta?.deviceHeight) || vp.height || 900

  const scaleX = (nx) => Math.max(0, Math.min(width, Math.round(Number(nx) * width)))
  const scaleY = (ny) => Math.max(0, Math.min(height, Math.round(Number(ny) * height)))

  const type = String(event.type || '')
  // CDP modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8), sent by the live
  // viewer with mouse AND key events so shift-click / ctrl-shortcuts work.
  const modifiers = Number.isFinite(event.modifiers) ? event.modifiers : 0

  if (type === 'mousemove' || type === 'mousedown' || type === 'mouseup' || type === 'click') {
    const x = scaleX(event.x)
    const y = scaleY(event.y)
    const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left'
    if (type === 'mousemove') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers })
    } else if (type === 'mousedown') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1, modifiers })
    } else if (type === 'mouseup') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1, modifiers })
    } else {
      // A full tap/click: move + press + release. Used by the TOUCH path (a
      // phone tap posts one synthetic 'click'); the desktop viewer relays
      // mousedown/mouseup separately and must NOT also post 'click', or one
      // physical click becomes two full click sequences at the portal.
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1, modifiers })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1, modifiers })
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
      modifiers,
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
}

/**
 * Translate ONE normalized input event into a CDP Input.* dispatch on the live
 * page. Coordinates (x, y) arrive as 0..1 fractions of the displayed image; we
 * scale them by the page viewport (preferring the latest screencast frame's
 * device size, falling back to the Playwright viewport). Returns { ok } or
 * { ok:false, reason } — NEVER throws (a rejected ensureInputCdp used to escape
 * this function and 500 the input route).
 *
 * LIFECYCLE: the Input.* CDP session is created once and cached, but a cached
 * handle can die under the page (a detach, a target swap). A dead cached handle
 * used to fail EVERY subsequent event forever ("dispatch_failed" on each click
 * while the screencast kept streaming). One failed send now drops the cache and
 * retries once over a freshly attached session, so a single stale handle can
 * never permanently disconnect the user's clicks from a live page.
 */
export async function dispatchInput(liveSessionId, event) {
  const s = sessions.get(liveSessionId)
  if (!s || !s.page) return { ok: false, reason: 'not_found_or_expired' }
  if (!event || typeof event !== 'object') return { ok: false, reason: 'bad_event' }
  touchSession(s) // user input is activity — never idle out someone mid-2FA

  try {
    const cdp = await ensureInputCdp(s)
    try {
      return await sendInputOverCdp(cdp, s, event)
    } catch (err) {
      // The cached CDP session may be stale/detached — reattach once and retry.
      try { await s.inputCdp?.detach?.() } catch { /* already dead */ }
      s.inputCdp = null
      const fresh = await ensureInputCdp(s)
      try {
        return await sendInputOverCdp(fresh, s, event)
      } catch (retryErr) {
        return { ok: false, reason: 'dispatch_failed', detail: retryErr?.message || err?.message }
      }
    }
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
 * HEURISTIC login check — not proof. If the live page still shows a VISIBLE
 * password input, the portal is almost certainly still sitting on its login
 * form, and capturing now would save a jar of tracker/CSRF cookies as a
 * "valid" session (the any-cookie hole documented at loadSeedSession). It can
 * only catch that obvious case: a portal that hides the password behind a
 * multi-step flow, or a page we cannot read, passes — which is why the caller
 * exposes a `force` escape hatch instead of trusting this as a verdict.
 * Best-effort and bounded: any locator failure (or a slow page) reads as
 * "cannot tell" → false, never a block and never a throw.
 */
async function pageStillShowsPasswordField(page, timeoutMs = 1500) {
  try {
    const locator = page?.locator?.('input[type=password]:visible')
    if (!locator || typeof locator.count !== 'function') return false
    let timer = null
    try {
      const count = await Promise.race([
        locator.count(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(0), timeoutMs)
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
      return Number(count) > 0
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/**
 * Step 1 of completion: capture the authenticated storageState from the live
 * context WITHOUT tearing anything down. The browser stays alive so a failed
 * import (the DB write) can be retried against the same live login — the old
 * capture-then-close flow deleted the session and closed the browser BEFORE
 * importSession ran, so an import failure permanently lost the live login.
 *
 * Marks the session `completing` so a concurrent double-complete (double-sent
 * Done) is refused instead of capturing/importing twice;
 * releaseCloudLoginCompletion() clears the mark for an explicit retry, and
 * every failure path here clears it itself so the user can always try again.
 *
 * `force: true` skips the pageStillShowsPasswordField heuristic (see above —
 * a heuristic, not proof, so the user may overrule it).
 *
 * Returns { ok, storageState, meta } or { ok:false, reason, ... }.
 */
export async function captureCloudLoginState(liveSessionId, { force = false } = {}) {
  const s = sessions.get(liveSessionId)
  if (!s) return { ok: false, reason: 'not_found_or_expired' }
  if (s.completing) return { ok: false, reason: 'completion_in_progress' }
  s.completing = true
  touchSession(s) // capture is activity
  try {
    if (!force && await pageStillShowsPasswordField(s.page)) {
      s.completing = false
      return {
        ok: false,
        reason: 'login_not_verified',
        detail: 'The portal still shows a password field — finish logging in first.',
        meta: s.meta,
      }
    }
    const storageState = await s.context.storageState()
    if (!storageState?.cookies?.length && !storageState?.origins?.length) {
      // Nothing captured at all — keep the session alive so the user can keep
      // logging in and click Done again.
      s.completing = false
      return { ok: false, reason: 'empty_session', meta: s.meta }
    }
    return { ok: true, storageState, meta: s.meta }
  } catch (err) {
    s.completing = false
    return { ok: false, reason: 'capture_failed', detail: err?.message }
  }
}

/**
 * Clear a session's `completing` mark after a failed import so the user can
 * retry Done against the still-alive live login (no new login required).
 */
export function releaseCloudLoginCompletion(liveSessionId) {
  const s = sessions.get(liveSessionId)
  if (!s) return { ok: false, reason: 'not_found_or_expired' }
  s.completing = false
  touchSession(s)
  return { ok: true }
}

/**
 * Step 2 of completion: tear the live session down (delete from the Map +
 * close the browser). Call ONLY after the captured state has been durably
 * persisted — the capture → import → finalize order is what makes an import
 * failure recoverable instead of session-destroying.
 */
export async function finalizeCloudLogin(liveSessionId) {
  const s = sessions.get(liveSessionId)
  if (!s) return { ok: true, already: true }
  sessions.delete(liveSessionId)
  await closeQuietly(s)
  return { ok: true }
}

/**
 * Back-compat one-shot: capture + finalize with no DB import in between. Kept
 * for callers/tests that treat completion as a single step; the HTTP route
 * uses the three-step API (captureCloudLoginState → importSession →
 * finalizeCloudLogin) so an import failure can no longer lose the live login.
 * On a failed capture the session is left alive (already released) so the
 * caller can retry or cancel.
 */
export async function completeCloudLogin(liveSessionId, opts = {}) {
  const captured = await captureCloudLoginState(liveSessionId, opts)
  if (!captured.ok) return captured
  await finalizeCloudLogin(liveSessionId)
  return captured
}

export async function cancelCloudLogin(liveSessionId) {
  const s = sessions.get(liveSessionId)
  if (!s) return { ok: true, already: true }
  sessions.delete(liveSessionId)
  await closeQuietly(s)
  return { ok: true }
}

export function cloudLoginStatus() {
  const infrastructureConfigured = isCloudLoginConfigured()
  return {
    configured: infrastructureConfigured,
    provider: cloudLoginProvider(),
    infrastructure_configured: infrastructureConfigured,
    synthetic_fixture_only: false,
    real_portal_navigation: true,
    active_sessions: sessions.size,
    requires_public_base: false,
  }
}
