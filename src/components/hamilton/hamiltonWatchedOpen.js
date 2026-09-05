/**
 * hamiltonWatchedOpen — THE one way to open a portal / application URL from a
 * profile surface. Every public http(s) portal goes through Hamilton's watched
 * browser so the authenticated session is captured and reused by unattended
 * runs; the backend (`/sessions/cloud-login/start`) owns the SSRF/DNS floor.
 *
 * THE BUG THIS FIXES (globally + permanently): "Open" controls across the
 * Portals & pipeline surfaces (Funding Sources rows, PortalLoginButton, the
 * student/health portal tiles, the ProfilePortalsCard fallback anchors) were
 * plain `<a target="_blank">` links. The portal opened in a normal tab, so
 * Hamilton never saw the visit — no co-browse, no session capture, no learned
 * login — even though the whole point of the portal system is that Hamilton
 * watches and learns every portal the applicant touches.
 *
 * HISTORY (ported from #1515/#1520, 2026-09-05): this file used to open every
 * REAL portal directly with a "controlled beta does not run a server browser"
 * toast and reserve the watched path for the synthetic fixture — long after
 * the backend route had been opened to any SSRF-safe public HTTPS portal
 * (docs/agent-sync/2026-08-20: "Do not re-impose fixture-only controlled-beta
 * refuse for real public HTTPS"). Real portals now take the watched path; the
 * degrade-to-direct-open fallback below still guarantees the click never dead-ends.
 *
 *   1. Open the popup SYNCHRONOUSLY in the click gesture (openPendingLoginWindow
 *      — after an await the browser blocks it; see liveLoginWindow.js).
 *   2. startCloudLogin(profileId, { portalHost, loginUrl }) — Hamilton launches
 *      the watched browser and streams it into /HamiltonLiveLogin.
 *   3. popup.navigate(resolveLiveLoginUrl(res)) — same-origin live view.
 *
 * NEVER a dead end: if Hamilton can't start (backend down, automation disabled,
 * policy refusal), the SAME popup is navigated straight to the portal URL so
 * the user still lands where they clicked — just unwatched — and the caller
 * gets `watched: false` to toast honestly about it. Callers without a
 * profileId (nothing to bind a session to) also degrade to the direct open.
 *
 * USAGE (must be called directly from the click handler — no awaits before it):
 *
 *   const res = await openWithHamiltonWatching({ profileId, url, label, toast })
 *   // res = { opened: boolean, watched: boolean, blocked: boolean }
 */

import { openPendingLoginWindow, resolveLiveLoginUrl } from "@/components/hamilton/liveLoginWindow"
import { startCloudLogin } from "@/api/hamilton"
import { safeHttpUrl, hostFromUrl } from "@/lib/safeUrl"
import { showErrorToast } from "@/components/shared/toastHelpers"
import { useGuidedTourStore } from "@/stores/guidedTourStore"

/**
 * Guided first-cycle tour: a genuine no-op outside the tour (isActive check).
 * This is the single choke point every "open a portal" call site goes
 * through, so hooking in here covers all of them (GrantOverview,
 * ProfileFundingSourcesCard, ProfilePortalsCard, StudentPortalsCard,
 * HealthResourcesCard, PipelinePotentialBreakdown) with one edit.
 */
function reportTourPortalOpened() {
  try {
    // MUST be the step's id ('hamilton-open', guidedCycleTourSteps.js), not the
    // event name — reportCompletion keys completedStepIds and the auto-advance
    // check off the step id. Reporting the event name here silently left the
    // step's Next locked forever even after the portal really opened.
    useGuidedTourStore.getState().reportCompletion("hamilton-open")
  } catch {
    // never let tour bookkeeping break the real portal-open flow
  }
}

/** Any safe http(s) portal URL with a profile to bind the session to can be watched. */
export function canHamiltonWatch({ profileId, url } = {}) {
  const href = safeHttpUrl(url)
  return Boolean(profileId) && Boolean(href) && Boolean(hostFromUrl(href))
}

/**
 * Open `url` for `profileId` with Hamilton watching (secure co-browse +
 * session capture). Falls back to a plain open of the same URL when Hamilton
 * can't watch, so the control never breaks the user's flow.
 *
 * @param {object}   opts
 * @param {string}   opts.profileId  Profile the captured session binds to.
 * @param {string}   opts.url        Portal / application URL (http(s) only).
 * @param {string}   [opts.label]    Human label for the session ("FSEOG", …).
 * @param {Function} [opts.toast]    shadcn `toast` fn for honest error surfacing.
 * @returns {Promise<{opened: boolean, watched: boolean, blocked: boolean}>}
 */
export async function openWithHamiltonWatching({ profileId, url, label = null, toast = null } = {}) {
  const href = safeHttpUrl(url)
  if (!href) return { opened: false, watched: false, blocked: false }

  const host = hostFromUrl(href)

  // No profile to bind a session to (or unparsable host) → honest direct open.
  // window.open here is still inside the user gesture, so it isn't blocked.
  if (!profileId || !host) {
    if (typeof window !== "undefined") window.open(href, "_blank", "noopener,noreferrer")
    reportTourPortalOpened()
    return { opened: true, watched: false, blocked: false }
  }

  // MUST run before any await — popup blockers only trust the live gesture.
  const popup = openPendingLoginWindow({ title: `Opening ${label || host}…` })
  if (!popup || popup.blocked) {
    if (toast) {
      showErrorToast(
        toast,
        "Allow pop-ups to open portals",
        "Your browser blocked the secure window Hamilton watches through. Allow pop-ups for GrantFlow, then click again.",
      )
    }
    return { opened: false, watched: false, blocked: true }
  }

  try {
    const res = await startCloudLogin(profileId, {
      portalHost: host,
      loginUrl: href,
      label: label || host,
    })
    const liveUrl = resolveLiveLoginUrl(res)
    if (!liveUrl) throw new Error("No live-login link was returned.")
    popup.navigate(liveUrl)
    reportTourPortalOpened()
    return { opened: true, watched: true, blocked: false }
  } catch (err) {
    // Hamilton couldn't start — degrade to the portal itself in the SAME
    // window (never a dead popup), and say so instead of pretending.
    popup.navigate(href)
    if (toast) {
      showErrorToast(
        toast,
        "Opened without Hamilton watching",
        err?.message
          ? `The watched session couldn't start (${err.message}), so the portal opened directly.`
          : "The watched session couldn't start, so the portal opened directly.",
      )
    }
    reportTourPortalOpened()
    return { opened: true, watched: false, blocked: false }
  }
}
