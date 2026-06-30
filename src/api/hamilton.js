import { apiFetch } from '@/api/apiClient'
import client from '@/api/client'
import { getApiBasePrefixForFetch } from '@/config/env.js'

// â”€â”€ Student portals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function listStudentPortals(profileId) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/student-portals`)
}

export function createStudentPortal(profileId, payload) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/student-portals`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

export function patchStudentPortal(profileId, portalId, payload) {
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/student-portals/${encodeURIComponent(portalId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload || {}),
  })
}

// â”€â”€ Funding portal links â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function listFundingPortalLinks(profileId) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/funding-portal-links`)
}

export function linkOpportunityPortal(opportunityId, payload) {
  return apiFetch(`/api/opportunities/${encodeURIComponent(opportunityId)}/link-student-portal`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

// â”€â”€ Application tasks (Hamilton) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function listApplicationTasks({ profileId = null, status = null } = {}) {
  const params = new URLSearchParams()
  if (profileId) params.set('profile_id', profileId)
  if (status) params.set('status', status)
  const qs = params.toString()
  return apiFetch(`/api/application-tasks${qs ? `?${qs}` : ''}`)
}

export function getApplicationTask(taskId) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}`)
}

// Profile-page "Hamilton" summary: what she is working on + everywhere the owner
// must add information for her to finish. Read-only, profile-access scoped.
// Returns { ok, working_on:[...], needs_you:[...], next_run_at, counts }.
export function getHamiltonProfileSummary(profileId) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(
    `/api/hamilton/automation/profile-summary?profileId=${encodeURIComponent(profileId)}`,
  )
}

export function createApplicationTask({ profileId, opportunityId = null, grantId = null, portalId = null }) {
  return apiFetch(`/api/application-tasks`, {
    method: 'POST',
    body: JSON.stringify({
      profile_id: profileId,
      opportunity_id: opportunityId,
      grant_id: grantId,
      portal_id: portalId,
    }),
  })
}

export function startHamilton(taskId, opts = {}) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}/hamilton/start`, {
    method: 'POST',
    body: JSON.stringify(opts),
  })
}

export function continueHamilton(taskId, opts = {}) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}/hamilton/continue`, {
    method: 'POST',
    body: JSON.stringify(opts),
  })
}

export function supplyMissingInfo(taskId, items) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}/missing-info`, {
    method: 'POST',
    body: JSON.stringify({ items: Array.isArray(items) ? items : [] }),
  })
}

export function approveAutoSubmit(taskId, enable = true) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}/approve-submit`, {
    method: 'POST',
    body: JSON.stringify({ enable }),
  })
}

export function cancelApplicationTask(taskId, reason = null) {
  return apiFetch(`/api/application-tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export const TASK_STATUS_LABELS = Object.freeze({
  queued: 'Queued',
  ready: 'Ready',
  waiting_for_user: 'Needs your input',
  waiting_for_admin: 'Awaiting admin review',
  blocked_login_required: 'Needs school login',
  blocked_missing_info: 'Missing info',
  blocked_2fa: 'Blocked: 2FA',
  blocked_captcha: 'Blocked: CAPTCHA',
  blocked_terms_or_policy: 'Blocked: terms',
  in_progress: 'Hamilton is completing this application',
  draft_completed: 'Draft ready',
  submitted: 'Submitted',
  failed: 'Failed',
  cancelled: 'Cancelled',
})

export const PORTAL_TYPE_LABELS = Object.freeze({
  financial_aid: 'Financial Aid portal',
  scholarship: 'Scholarship portal',
  admissions: 'Admissions portal',
  student_account: 'Student account portal',
  bursar: 'Bursar portal',
  department: 'Department scholarship',
  graduate_school: 'Graduate school portal',
  program_specific: 'Program portal',
  external_application: 'External application',
  manual_or_offline: 'Manual / offline',
})

export function statusLabel(status) {
  return TASK_STATUS_LABELS[status] || status || 'Unknown'
}

export function portalTypeLabel(portalType) {
  return PORTAL_TYPE_LABELS[portalType] || portalType || 'Portal'
}

// -- Scheduled runs on the calendar + login readiness --------------------

// Hamilton's scheduled application runs as calendar events (each flagged
// requires_presence when a portal it touches needs login/2FA).
export function getHamiltonCalendar({ profileId, month } = {}) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  const qs = new URLSearchParams({ profileId })
  if (month) qs.set('month', month)
  return apiFetch(`/api/hamilton/automation/calendar?${qs.toString()}`)
}

// Login-time readiness: schedule status, next run, and which portals still need
// a session captured so Hamilton can act inside the real account.
export function getHamiltonReadiness({ profileId } = {}) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/hamilton/automation/readiness?profileId=${encodeURIComponent(profileId)}`)
}

// -- Captured portal sessions (the AES-256-GCM Playwright storageStates) ----

// List a profile's saved portal sessions (host, label, status, expiry, etc.).
export function listPortalSessions(profileId) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/hamilton/automation/sessions?profileId=${encodeURIComponent(profileId)}`)
}

// Saved portal LOGINS (username/password, encrypted at rest). These are also
// portals Hamilton can sign in to — surfaced alongside sessions for sync.
export function listPortalCredentials(profileId) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/hamilton/automation/credentials?profileId=${encodeURIComponent(profileId)}`)
}

// "✨ Auto-fill with Hamilton": ask the backend to suggest the portal host,
// login URL, and username for a profile so the user only has to type their
// password (+ optional 2FA). Returns { portalHost, loginUrl, username, label,
// source }. Best-effort — any field may come back blank.
export function suggestPortalLogin(profileId, { portalHost = null, opportunityId = null, context = null } = {}) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/hamilton/automation/portal-login/suggest`, {
    method: 'POST',
    body: JSON.stringify({
      profileId,
      portalHost: portalHost || undefined,
      opportunityId: opportunityId || undefined,
      context: context || undefined,
    }),
  })
}

// Revoke a saved session so Hamilton can no longer reuse it.
export function revokePortalSession(sessionId, reason = null) {
  if (!sessionId) return Promise.reject(new Error('sessionId required'))
  return apiFetch(`/api/hamilton/automation/sessions/${encodeURIComponent(sessionId)}/revoke`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

// Mark a saved session expired (forces a fresh capture before reuse).
export function expirePortalSession(sessionId) {
  if (!sessionId) return Promise.reject(new Error('sessionId required'))
  return apiFetch(`/api/hamilton/automation/sessions/${encodeURIComponent(sessionId)}/expire`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

// Mint a short-lived capture token + api base so the user can run the
// session-capture tool without copying a bearer token out of DevTools.
export function getPortalSessionCaptureToken(profileId) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/hamilton/automation/sessions/capture-token`, {
    method: 'POST',
    body: JSON.stringify({ profileId }),
  })
}

// -- Capture requests (queue an intent the owner's laptop helper can fulfill) --

export function createCaptureRequest(profileId, { portalHost, loginUrl = null, label = null } = {}) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/hamilton/automation/sessions/capture-requests`, {
    method: 'POST',
    body: JSON.stringify({ profileId, portal_host: portalHost, login_url: loginUrl, label }),
  })
}

export function listCaptureRequests({ profileId, status = 'pending' } = {}) {
  const qs = new URLSearchParams({ status })
  if (profileId) qs.set('profileId', profileId)
  return apiFetch(`/api/hamilton/automation/sessions/capture-requests?${qs.toString()}`)
}

export function cancelCaptureRequest(id, reason = null) {
  if (!id) return Promise.reject(new Error('id required'))
  return apiFetch(`/api/hamilton/automation/sessions/capture-requests/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

// -- Cloud interactive login (Option B): self-serve on any device ------------

// Is cloud login configured on this deployment? (Off by default.)
export function getCloudLoginStatus() {
  return apiFetch(`/api/hamilton/automation/sessions/cloud-login/status`)
}

// Start a cloud login; returns { liveSessionId, liveUrl } the user opens to log in.
export function startCloudLogin(profileId, { portalHost, loginUrl = null, label = null, captureRequestId = null } = {}) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/hamilton/automation/sessions/cloud-login/start`, {
    method: 'POST',
    body: JSON.stringify({ profileId, portal_host: portalHost, login_url: loginUrl, label, capture_request_id: captureRequestId }),
  })
}

// Finish a cloud login: capture + import the authenticated session (profile-bound).
export function completeCloudLogin(liveSessionId) {
  if (!liveSessionId) return Promise.reject(new Error('liveSessionId required'))
  return apiFetch(`/api/hamilton/automation/sessions/cloud-login/${encodeURIComponent(liveSessionId)}/complete`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function cancelCloudLogin(liveSessionId) {
  if (!liveSessionId) return Promise.reject(new Error('liveSessionId required'))
  return apiFetch(`/api/hamilton/automation/sessions/cloud-login/${encodeURIComponent(liveSessionId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

// Relay ONE normalized live-view input event (mouse / wheel / key) to the live
// page. Coordinates x,y are 0..1 fractions of the displayed image; the server
// scales them to the page viewport. Fire-and-forget from the caller's view.
export function sendCloudLoginInput(liveSessionId, event) {
  if (!liveSessionId) return Promise.reject(new Error('liveSessionId required'))
  return apiFetch(`/api/hamilton/automation/sessions/cloud-login/${encodeURIComponent(liveSessionId)}/input`, {
    method: 'POST',
    body: JSON.stringify(event || {}),
  })
}

// Open the live screen stream (SSE). We use fetch (not EventSource) so we can
// send the Authorization header the backend's auth middleware requires — a
// liveSessionId alone must never grant control. Calls onFrame({ data, metadata })
// for every JPEG frame, onError(reason) on failure/stream-end. Returns a handle
// with close() that aborts the stream.
export function streamCloudLogin(liveSessionId, { onFrame, onError, onOpen } = {}) {
  if (!liveSessionId) throw new Error('liveSessionId required')
  const controller = new AbortController()
  const base = getApiBasePrefixForFetch()
  const url = `${base}/api/hamilton/automation/sessions/cloud-login/${encodeURIComponent(liveSessionId)}/stream`

  // The live-login window is a FRESH app load (opened via window.open), so its
  // auth bootstrap may not have refreshed the access token yet. The stream uses
  // a raw fetch (not apiFetch), so it must do its own refresh: proactively when
  // the stored token is expired/near-expiry, and reactively (refresh + retry
  // ONCE) on a 401/403. Without this the stream silently 401s and the window
  // shows a dead "connection ended" — even though the user is signed in.
  const openOnce = async () => {
    const token = client.getToken?.()
    const headers = { Accept: 'text/event-stream' }
    if (token) headers.Authorization = `Bearer ${token}`
    return fetch(url, { method: 'GET', headers, signal: controller.signal })
  }

  ;(async () => {
    try {
      // Proactive refresh if the access token is expired / about to expire.
      try {
        if (typeof window !== 'undefined' && client.getRefreshToken?.()) {
          const expiryRaw = window.localStorage.getItem('grantflow:access-expiry')
          const expiryMs = expiryRaw ? Number(expiryRaw) : NaN
          if (!Number.isFinite(expiryMs) || expiryMs <= Date.now() + 60_000) {
            await client.refreshTokens?.()
          }
        }
      } catch { /* fall through; the 401 retry below is the net */ }

      let resp = await openOnce()
      // Reactive refresh + single retry on an auth failure.
      if ((resp.status === 401 || resp.status === 403) && client.refreshTokens) {
        try {
          await client.refreshTokens()
          if (!controller.signal.aborted) resp = await openOnce()
        } catch { /* keep the original failing response */ }
      }
      if (!resp.ok || !resp.body) {
        onError?.(`stream_http_${resp.status}`)
        return
      }
      onOpen?.()
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // SSE frames are separated by a blank line. Parse incrementally.
      for (;;) {
        const { value, done } = await reader.read()
        if (done) { onError?.('stream_ended'); break }
        buffer += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const lines = chunk.split('\n')
          let eventType = 'message'
          let dataLine = ''
          for (const line of lines) {
            if (line.startsWith(':')) continue // heartbeat comment
            if (line.startsWith('event:')) eventType = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLine += line.slice(5).trim()
          }
          if (!dataLine) continue
          let payload
          try { payload = JSON.parse(dataLine) } catch { continue }
          if (eventType === 'error') onError?.(payload?.error || 'stream_error')
          else onFrame?.(payload)
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return
      onError?.(err?.message || 'stream_failed')
    }
  })()

  return { close: () => controller.abort() }
}

// ── Per-profile Portals dashboard ───────────────────────────────────────────
// Every REAL login/application portal that applies to this profile (its schools
// + the funding sources of pipeline grants), auto-listed so the user never has
// to type a portal name or URL — they click. Returns:
//   { portals: [ { portalHost, loginUrl, label, kind, sources, status,
//                  hasCredential, hasSession, connectorId, supportsTwoWaySync,
//                  lastSync } ],
//     mailFaxSources: [ { title, grantId, opportunityId, host, url,
//                  applicationMethod, contact:{name,email,phone,fax,address} } ] }
// `mailFaxSources` are real funding sources (URL present) that are NOT portals —
// they apply by mail/fax/email — so the UI offers a printable application packet
// instead of a login tile. Junk/search hosts are excluded from both lists.
export function listProfilePortals(profileId) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/portals`)
}

// ── Portal Autopilot Identity: master vault + identity + run ─────────────────
// The password-manager layer that lets Hamilton self-provision logins on portals
// the owner hasn't signed up to (ONE master passphrase per profile + a unique
// generated password per portal). The passphrase is sent over the authenticated
// request, consumed server-side, and NEVER stored/echoed/returned — responses
// carry only the public vault STATUS (has_passphrase / is_unlocked /
// identity_email).

// Read the master-vault / autopilot-identity status for a profile.
export function getPortalAutopilotStatus(profileId) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/portal-autopilot`)
}

// Set / rotate the master passphrase (optionally the identity email too).
export function setPortalAutopilotPassphrase(profileId, { passphrase, identityEmail = undefined } = {}) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  if (!passphrase) return Promise.reject(new Error('passphrase required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/portal-autopilot/passphrase`, {
    method: 'POST',
    body: JSON.stringify({ passphrase, identityEmail }),
  })
}

// Unlock the vault for this server process (passphrase consumed + discarded).
export function unlockPortalAutopilot(profileId, { passphrase } = {}) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  if (!passphrase) return Promise.reject(new Error('passphrase required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/portal-autopilot/unlock`, {
    method: 'POST',
    body: JSON.stringify({ passphrase }),
  })
}

// Lock the vault (drop the in-memory wrapping key).
export function lockPortalAutopilot(profileId) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/portal-autopilot/lock`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

// Set / clear the autopilot identity email (the username Hamilton registers with).
export function setPortalAutopilotIdentity(profileId, { identityEmail } = {}) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/portal-autopilot/identity`, {
    method: 'POST',
    body: JSON.stringify({ identityEmail: identityEmail ?? null }),
  })
}

// Run Portal Autopilot: the whole profile (omit portalHost) or ONE portal. A
// single-portal run may return a one-time password view for a newly provisioned
// login; bulk runs never do.
export function runPortalAutopilot(profileId, { portalHost = null, loginUrl = null } = {}) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/portal-autopilot/run`, {
    method: 'POST',
    body: JSON.stringify({ portalHost: portalHost || undefined, loginUrl: loginUrl || undefined }),
  })
}

// Mark a portal MERGED (terminal, ends weekly reminders) or COMPLETE. A merge is
// only accepted server-side with explicit confirmation that the data was pulled
// into the profile — the dashboard "I merged this" is that confirmation.
export function setPortalMergeStatus(profileId, { portalHost, status, evidence = null } = {}) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  if (!portalHost) return Promise.reject(new Error('portalHost required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/portals/status`, {
    method: 'POST',
    body: JSON.stringify({ portalHost, status, evidence }),
  })
}

// Render + SAVE an application packet for a non-portal funding source as a durable
// Document on this profile (so the page reflects what Hamilton produced). Returns
// { documentId, reused, at }. Idempotent: re-saving the same source returns the
// existing document.
export function saveApplicationPacket(profileId, { source, profileName = '' } = {}) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  if (!source) return Promise.reject(new Error('source required'))
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/portals/packet`, {
    method: 'POST',
    body: JSON.stringify({ source, profileName }),
  })
}

// Bulk: have Hamilton make an INDIVIDUAL packet (PDF) per selected non-portal
// funder and save each to this profile's Documents. Idempotent per source
// (already-saved packets are reused). Returns
// { ok, results:[{ key, documentId, reused, mime_type, error? }], created, reused, failed }.
export function saveApplicationPackets(profileId, { sources, profileName = '' } = {}) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  if (!Array.isArray(sources) || sources.length === 0) {
    return Promise.reject(new Error('sources required'))
  }
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/portals/packets`, {
    method: 'POST',
    body: JSON.stringify({ sources, profileName }),
  })
}

// Durable download URL for a saved packet document (serves the stored bytes so it
// works even after Railway's filesystem is wiped).
export function packetDownloadUrl(profileId, documentId) {
  if (!profileId || !documentId) return null
  return `/api/profiles/${encodeURIComponent(profileId)}/portals/packet/${encodeURIComponent(documentId)}/download`
}

// ── Two-way portal sync (Hamilton) ─────────────────────────────────────────
// Endpoints provided by the portal-sync backend framework, mounted at
// /api/hamilton/portal-sync. The status reader returns real portal_sync_runs
// rows — the UI surfaces actual run status/errors, never a faked "synced!".

// Pull data FROM the portal into this profile.
export function runPortalSyncRead(profileId, portalHost) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  if (!portalHost) return Promise.reject(new Error('portalHost required'))
  return apiFetch('/api/hamilton/portal-sync/read', {
    method: 'POST',
    body: JSON.stringify({ profileId, portalHost }),
  })
}

// Push this profile's data TO the portal.
export function runPortalSyncWrite(profileId, portalHost) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  if (!portalHost) return Promise.reject(new Error('portalHost required'))
  return apiFetch('/api/hamilton/portal-sync/write', {
    method: 'POST',
    body: JSON.stringify({ profileId, portalHost }),
  })
}

// Two-way sync (read + write).
export function runPortalSyncBoth(profileId, portalHost) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  if (!portalHost) return Promise.reject(new Error('portalHost required'))
  return apiFetch('/api/hamilton/portal-sync/sync', {
    method: 'POST',
    body: JSON.stringify({ profileId, portalHost }),
  })
}

// Recent portal_sync_runs for a profile (optionally one host).
export function listPortalSyncRuns(profileId, portalHost = null) {
  if (!profileId) return Promise.reject(new Error('profileId required'))
  const params = new URLSearchParams({ profileId })
  if (portalHost) params.set('portalHost', portalHost)
  return apiFetch(`/api/hamilton/portal-sync/runs?${params.toString()}`)
}
