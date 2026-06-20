/**
 * Hamilton cloud interactive login (Option B).
 *
 * Goal: let a user on ANY device (including a phone), independent of the owner,
 * log into a portal once and have Hamilton capture the resulting session — so
 * future runs skip both login AND 2FA, even for push-2FA portals.
 *
 * How: the backend connects to a HOSTED interactive Chrome (a CDP provider such
 * as Browserless) via chromium.connectOverCDP(), opens the portal login page,
 * and hands the user a provider "live URL" they open on their phone to drive the
 * real browser. When they finish, we read context.storageState() and import it —
 * through the SAME profile-bound path as every other session, so the multi-user
 * safeguard still applies.
 *
 * SAFETY / STATUS:
 *   - OFF by default. Requires HAMILTON_CLOUD_LOGIN_ENABLED=true AND a configured
 *     CDP endpoint (HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT). When unconfigured, every
 *     entry point reports not_configured and callers fall back to Saved Login.
 *   - Streaming/storing an authenticated session is security-sensitive; enabling
 *     this in production should follow a security review (and a paid hosted
 *     browser is typically required).
 *   - Live sessions are held in-memory with a TTL; a single backend instance is
 *     assumed for the interactive window (acceptable for the capture flow).
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamiltonCloudLogin')

const SESSION_TTL_MS = 15 * 60_000
const sessions = new Map() // liveSessionId -> { browser, context, page, meta, createdAt }

export function isCloudLoginConfigured() {
  const enabled = String(process.env.HAMILTON_CLOUD_LOGIN_ENABLED || '').toLowerCase() === 'true'
  const endpoint = String(process.env.HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT || '').trim()
  return enabled && endpoint.length > 0
}

function cdpEndpoint() {
  return String(process.env.HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT || '').trim()
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
}

/**
 * Ask the CDP provider for an interactive "live URL" the user can open to drive
 * the browser. Implemented for Browserless's `Browserless.liveURL` CDP command;
 * providers that don't support it return null (the caller surfaces a clear
 * "provider does not support interactive sessions" error).
 */
async function acquireLiveUrl(page) {
  try {
    const cdp = await page.context().newCDPSession(page)
    // Browserless: returns { liveURL }. Other providers may ignore this.
    const res = await cdp.send('Browserless.liveURL').catch(() => null)
    if (res && (res.liveURL || res.url)) return res.liveURL || res.url
  } catch { /* provider doesn't support it */ }
  return null
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

  let browser
  try {
    browser = await chromium.connectOverCDP(cdpEndpoint())
    const context = browser.contexts()[0] || (await browser.newContext())
    const page = context.pages()[0] || (await context.newPage())
    await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {})
    const liveUrl = await acquireLiveUrl(page)
    if (!liveUrl) {
      await closeQuietly({ browser })
      return { ok: false, reason: 'provider_no_live_url' }
    }
    const liveSessionId = `cl_${Date.now().toString(36)}_${Math.floor(performance.now()).toString(36)}`
    sessions.set(liveSessionId, {
      browser, context, page,
      meta: { userId, profileId: String(profileId), portalHost, loginUrl: target, label, captureRequestId },
      createdAt: Date.now(),
    })
    log.info('cloud login session started', { liveSessionId, profileId: String(profileId), portalHost })
    return { ok: true, liveSessionId, liveUrl, expires_in_ms: SESSION_TTL_MS }
  } catch (err) {
    await closeQuietly({ browser })
    log.error('cloud login start failed', { error: err?.message })
    return { ok: false, reason: 'connect_failed', detail: err?.message }
  }
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
  return {
    configured: isCloudLoginConfigured(),
    active_sessions: sessions.size,
    reason: isCloudLoginConfigured()
      ? null
      : 'Set HAMILTON_CLOUD_LOGIN_ENABLED=true and HAMILTON_CLOUD_LOGIN_CDP_ENDPOINT to a hosted interactive Chrome (e.g. Browserless), then complete a security review.',
  }
}
