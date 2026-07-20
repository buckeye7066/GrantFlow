import { getApiBasePrefixForFetch } from '@/config/env.js'

// Fire-and-forget client-error beacon. POSTs crash details to the backend, which
// analyzes them and emails the owner (self-skipping for admins, server-side).
// EVERYTHING here swallows failures — reporting an error must never itself throw
// or surface UI noise, and must never loop.

const DEDUPE_WINDOW_MS = 60000 // same message within 60s → skip (avoid loops)
const recentMessages = new Map() // message -> lastSentAt

function shouldSkip(message) {
  const now = Date.now()
  // Opportunistic prune so the map can't grow unbounded.
  for (const [key, ts] of recentMessages) {
    if (now - ts > DEDUPE_WINDOW_MS) recentMessages.delete(key)
  }
  const last = recentMessages.get(message)
  if (last && now - last < DEDUPE_WINDOW_MS) return true
  recentMessages.set(message, now)
  return false
}

/**
 * Report a client-side error to the backend.
 * @param {Error|any} error
 * @param {{ componentStack?: string }} [info]
 */
export function reportClientError(error, info = {}) {
  try {
    if (typeof window === 'undefined') return

    const message = String(error?.message || error || '').slice(0, 4000)
    if (!message.trim()) return
    if (shouldSkip(message)) return

    const payload = {
      message,
      name: String(error?.name || 'ClientError').slice(0, 200),
      stack: String(error?.stack || '').slice(0, 8000),
      componentStack: info?.componentStack ? String(info.componentStack).slice(0, 8000) : undefined,
      route: window.location?.pathname || null,
    }

    let token = null
    try {
      token = window.localStorage?.getItem('grantflow:access-token') || null
    } catch {
      /* storage unavailable — report anonymously */
    }

    const base = getApiBasePrefixForFetch() || ''
    const url = `${base}/api/report-client-error`

    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      keepalive: true,
      body: JSON.stringify(payload),
    }).catch(() => {
      /* swallow — never surface reporting failures */
    })
  } catch {
    /* swallow all — reporting must never throw */
  }
}

let globalHandlersRegistered = false

/**
 * Register window-level error + unhandledrejection handlers exactly once.
 * Call from app bootstrap.
 */
export function initClientErrorReporting() {
  if (globalHandlersRegistered || typeof window === 'undefined') return
  globalHandlersRegistered = true

  window.addEventListener('error', (e) => {
    // Browsers mute cross-origin script errors (WHATWG "muted errors"): when a
    // script we didn't load in our own origin throws (a browser extension's
    // injected content script is the common case on login-style pages), the
    // browser reports message="Script error." with error/filename/lineno all
    // blanked out. There is no real stack to recover here — synthesizing one
    // via `new Error()` just fabricates a frame pointing at this handler
    // itself, misattributing the crash to our bundle. Skip reporting rather
    // than emailing the owner a false alarm with no diagnostic value.
    if (e?.message === 'Script error.' && !e?.error && !e?.filename) return
    reportClientError(e?.error || new Error(e?.message || 'Unknown error'), {})
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e?.reason
    reportClientError(reason instanceof Error ? reason : new Error(String(reason)), {})
  })
}

export default reportClientError
