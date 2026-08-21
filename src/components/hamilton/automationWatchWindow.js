/**
 * automationWatchWindow — pop Hamilton's live work open in its own window.
 *
 * OWNER ORDER 2026-08-21: "Let the work Hamilton is doing, once automation
 * begins, pop open in its own window and the user can watch if they chose to."
 *
 * Before this, pressing "Begin automation" produced a toast that said "Watch the
 * Automation tab for progress" and then nothing moved on screen. The run was
 * real; the watching was homework. Now the work opens where you can see it.
 *
 * TWO RULES, both learned the hard way in liveLoginWindow.js:
 *
 *  1. OPEN INSIDE THE GESTURE. `beginHamiltonAutomation` POSTs to
 *     /start-autopilot, which launches real browser work and answers 202 after
 *     the fan-out is queued. A window.open in the mutation's onSuccess is no
 *     longer user-initiated, so browsers block it — and the old cloud-login code
 *     ignored the null return and toasted "opened" anyway. The window is opened
 *     synchronously in the click handler and navigated later.
 *
 *  2. WATCHING IS OPTIONAL, THE RUN IS NOT. A blocked popup must never stop the
 *     automation. The caller starts the run either way and says plainly that the
 *     window could not open. Equally, the window is never a dead end: if the
 *     start call fails, the SAME window renders the reason instead of spinning
 *     on "Preparing…" forever.
 *
 * USAGE (must be called directly from the click handler — no awaits before it):
 *
 *   const watch = openAutomationWatchWindow()          // synchronous
 *   beginAutomation.mutate(undefined, {
 *     onSuccess: () => watch.navigate(resolveAutomationWatchUrl(profileId)),
 *     onError:   (e) => watch.fail(e?.message),
 *   })
 */

import { openPendingLoginWindow } from '@/components/hamilton/liveLoginWindow'
import { env } from '@/config/env.js'

/** The route the watch window lands on. Registered in src/pages/index.jsx. */
export const AUTOMATION_WATCH_ROUTE = '/HamiltonAutomationWatch'

/**
 * Absolute, same-origin URL for one profile's live automation view.
 *
 * SAME-ORIGIN IS NOT COSMETIC: the page reads the signed-in GrantFlow session,
 * which the browser partitions per origin. ABSOLUTE is not cosmetic either: the
 * popup starts on about:blank, so a relative href passed to location.replace()
 * would not resolve.
 *
 * @param {string} profileId
 * @returns {string|null} null when there is no profile — a watch window with
 *   nothing to watch is worse than no window, so the caller degrades instead.
 */
export function resolveAutomationWatchUrl(profileId) {
  const id = String(profileId ?? '').trim()
  if (!id) return null
  const params = new URLSearchParams({ profile: id })
  const base = env.appBase && env.appBase !== '/' ? String(env.appBase).replace(/\/+$/, '') : ''
  const path = `${base}${AUTOMATION_WATCH_ROUTE}?${params.toString()}`
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`
  }
  return path
}

/**
 * Open the watch window synchronously, in the click gesture.
 *
 * Reuses the proven popup primitive (blank window + placeholder + navigate/fail)
 * so there is ONE implementation of the popup-blocker dance in the app.
 *
 * @returns {{blocked: boolean, navigate: (url: string) => void, fail: (msg?: string) => void, close: () => void}}
 */
export function openAutomationWatchWindow() {
  return openPendingLoginWindow({
    title: 'Hamilton is starting…',
    message: 'Starting Hamilton&hellip;',
    hint: 'This window shows the work as it happens. You can close it any time — the run keeps going.',
  })
}
