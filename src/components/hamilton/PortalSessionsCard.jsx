/**
 * PortalSessionsCard
 *
 * Management surface for the saved portal sessions Hamilton reuses — the
 * AES-256-GCM-encrypted Playwright storageStates the owner captured by logging
 * in + clearing 2FA once. Lists each saved session for a profile (host, label,
 * status, expiry with a "expires in N days" / "expired" cue, last used) and
 * lets the owner revoke any of them so Hamilton can no longer act inside that
 * account.
 *
 * Data:    GET  /api/hamilton/automation/sessions?profileId=...
 * Revoke:  POST /api/hamilton/automation/sessions/:id/revoke
 * Capture: a "Set up a new session" helper mints a short-lived capture token
 *          (POST /api/hamilton/automation/sessions/capture-token) and renders a
 *          ready-to-run `node tools/hamilton-session-capture/capture.mjs ...`
 *          command pre-filled with the profileId — no copying a bearer token
 *          out of DevTools.
 */

import React, { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  listPortalSessions,
  revokePortalSession,
  getPortalSessionCaptureToken,
  getCloudLoginStatus,
  startCloudLogin,
  suggestPortalLogin,
} from "@/api/hamilton"
import { openPendingLoginWindow, resolveLiveLoginUrl } from "@/components/hamilton/liveLoginWindow"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/use-toast"
import { showSuccessToast, showErrorToast } from "@/components/shared/toastHelpers"
import { KeyRound, Loader2, ShieldCheck, ShieldX, Clock, Copy, Plus, X, Smartphone, Globe, Info, Wand2, Sparkles } from "lucide-react"

const DAY_MS = 86_400_000

function expiryInfo(session) {
  if (!session?.expires_at) return { label: "No expiry", tone: "muted" }
  const ms = new Date(session.expires_at).getTime() - Date.now()
  if (!Number.isFinite(ms)) return { label: "No expiry", tone: "muted" }
  if (ms <= 0) return { label: "Expired", tone: "bad" }
  const days = Math.ceil(ms / DAY_MS)
  return { label: `Expires in ${days} day${days === 1 ? "" : "s"}`, tone: days <= 2 ? "warn" : "ok" }
}

// Effective state: an explicit status wins, but a still-"valid" row whose
// expiry has passed, or one with no stored storageState, is surfaced honestly.
function effectiveStatus(session) {
  const raw = String(session?.status || "").toLowerCase()
  if (raw === "revoked") return { key: "revoked", label: "Revoked", variant: "secondary" }
  if (raw === "expired") return { key: "expired", label: "Expired", variant: "destructive" }
  if (!session?.has_storage_state) return { key: "missing", label: "Missing", variant: "destructive" }
  const exp = session?.expires_at ? new Date(session.expires_at).getTime() : null
  if (exp && exp <= Date.now()) return { key: "expired", label: "Expired", variant: "destructive" }
  return { key: "valid", label: "Valid", variant: "default" }
}

function formatWhen(iso) {
  if (!iso) return "never"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "never"
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

function buildCaptureCommand({ apiBase, token, profileId }) {
  const base = apiBase || "https://grantflow-production.up.railway.app"
  const tok = token || "<your GrantFlow access token>"
  return [
    "node tools/hamilton-session-capture/capture.mjs \\",
    `  --api-base ${base} \\`,
    `  --token ${tok} \\`,
    `  --profile-id ${profileId} \\`,
    "  --portal-host school.edu \\",
    "  --login-url https://login.microsoftonline.com/ \\",
    '  --label "School SSO" --expires-days 14',
  ].join("\n")
}

function buildOutModeCommand(profileId) {
  return [
    "node tools/hamilton-session-capture/capture.mjs \\",
    `  --profile-id ${profileId} \\`,
    "  --portal-host school.edu \\",
    "  --login-url https://login.microsoftonline.com/ \\",
    "  --out session.json",
  ].join("\n")
}

export default function PortalSessionsCard({ profileId }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [setupOpen, setSetupOpen] = useState(false)

  const { data, isLoading, isError } = useQuery({
    queryKey: ["hamilton-portal-sessions", profileId],
    queryFn: () => listPortalSessions(profileId),
    enabled: !!profileId,
    staleTime: 30_000,
  })

  const sessions = Array.isArray(data?.sessions) ? data.sessions : []

  const revokeMutation = useMutation({
    mutationFn: (sessionId) => revokePortalSession(sessionId, "Revoked from session manager"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hamilton-portal-sessions", profileId] })
      showSuccessToast(toast, "Session revoked", "Hamilton can no longer reuse that saved login.")
    },
    onError: (err) => {
      showErrorToast(toast, "Could not revoke session", err?.message || "Please try again.")
    },
  })

  const tokenMutation = useMutation({
    mutationFn: () => getPortalSessionCaptureToken(profileId),
    onError: (err) => {
      showErrorToast(toast, "Could not generate a capture token", err?.message || "Please try again.")
    },
  })

  // Option B (cloud interactive login): self-serve on any device, owner-independent.
  // The self_hosted provider is ON by default and serves the live login window
  // from GrantFlow itself (a same-origin live view at /HamiltonLiveLogin), so it
  // works on Railway's single public port with no extra setup.
  const [portalHost, setPortalHost] = useState("")
  const [loginUrl, setLoginUrl] = useState("")
  // True once a secure login window has been opened, so we can show a
  // "finish in the window, then refresh" affordance. Capture/complete now
  // happens inside the live-view window, not here.
  const [liveOpened, setLiveOpened] = useState(false)
  // Subtle "filled by Hamilton" hint after a successful auto-fill.
  const [cloudFilledByHamilton, setCloudFilledByHamilton] = useState(false)

  const { data: cloudStatus } = useQuery({
    queryKey: ["hamilton-cloud-login-status"],
    queryFn: () => getCloudLoginStatus(),
    staleTime: 5 * 60_000,
  })
  const cloudConfigured = Boolean(cloudStatus?.configured)

  // "✨ Auto-fill with Hamilton": resolve the portal host + login URL she
  // already knows so the user only supplies credentials + 2FA in the window.
  const cloudSuggestMutation = useMutation({
    mutationFn: () => suggestPortalLogin(profileId, {
      portalHost: portalHost.trim() || null,
      context: portalHost.trim() || null,
    }),
    onSuccess: (resp) => {
      let filled = false
      if (resp?.portalHost && !portalHost.trim()) { setPortalHost(resp.portalHost); filled = true }
      if (resp?.loginUrl && !loginUrl.trim()) { setLoginUrl(resp.loginUrl); filled = true }
      setCloudFilledByHamilton(filled)
      if (!filled && !portalHost.trim()) {
        showErrorToast(toast, "Nothing to auto-fill yet", "Type the portal name (or open this from an opportunity) and try again.")
      }
    },
    onError: (err) => showErrorToast(toast, "Auto-fill failed", err?.message || "Enter the portal manually."),
  })

  // Start a cloud login. The host is OPTIONAL in the form: when it's blank we
  // first ask Hamilton to resolve the portal she already knows, then start with
  // whatever she filled. The user only ever needs their credentials + 2FA in the
  // secure window.
  const cloudStartMutation = useMutation({
    mutationFn: async ({ popup }) => {
      let host = portalHost.trim()
      let url = loginUrl.trim()
      if (!host) {
        try {
          const resp = await suggestPortalLogin(profileId, { context: portalHost.trim() || null })
          if (resp?.portalHost) { host = resp.portalHost; setPortalHost(resp.portalHost) }
          if (resp?.loginUrl && !url) { url = resp.loginUrl; setLoginUrl(resp.loginUrl) }
          if (host) setCloudFilledByHamilton(true)
        } catch { /* fall through to the missing-host error below */ }
      }
      if (!host) throw new Error("Hamilton couldn't tell which portal to open. Type the portal name, then try again.")
      // Cancel the placeholder popup if the start itself rejects.
      try {
        return await startCloudLogin(profileId, {
          portalHost: host,
          loginUrl: url || null,
          label: `${host} session`,
        })
      } catch (err) {
        popup?.fail(err?.message || "Could not start cloud login. Please try again.")
        throw err
      }
    },
    onSuccess: (res, { popup }) => {
      // res.liveUrl points at our own full-screen live-view page
      // (/HamiltonLiveLogin?session=...). The popup was opened synchronously on
      // click (see handleStartCloudLogin) and is navigated here — opening it
      // after the await would be popup-blocked (dead window).
      const url = resolveLiveLoginUrl(res)
      if (!url) {
        popup?.fail("We couldn't open the secure login. Please try again.")
        showErrorToast(toast, "Could not start cloud login", "No login window link was returned. Please try again.")
        return
      }
      popup?.navigate(url)
      setLiveOpened(true)
      showSuccessToast(toast, "Secure login window opened", "Sign in + approve 2FA in the new window, then click “Done” there. Come back and Refresh to see the saved session.")
    },
    onError: (err, { popup }) => {
      popup?.fail(err?.message || "Could not start cloud login. Please try again.")
      showErrorToast(toast, "Could not start cloud login", err?.message || "Please try again.")
    },
  })

  // Open the secure-login popup while the click gesture is live, then start.
  const handleStartCloudLogin = () => {
    const popup = openPendingLoginWindow()
    if (popup.blocked) {
      showErrorToast(
        toast,
        "Allow pop-ups to sign in",
        "Your browser blocked the secure login window. Allow pop-ups for GrantFlow, then click again.",
      )
      return
    }
    cloudStartMutation.mutate({ popup })
  }

  const handleCopy = (text, what) => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => showSuccessToast(toast, "Copied", `${what} copied to your clipboard.`))
        .catch(() => showErrorToast(toast, "Copy failed", "Select and copy the text manually."))
    }
  }

  const handleOpenSetup = () => {
    const next = !setupOpen
    setSetupOpen(next)
    if (next && !tokenMutation.data && !tokenMutation.isPending) tokenMutation.mutate()
  }

  const captureCommand = buildCaptureCommand({
    apiBase: tokenMutation.data?.api_base,
    token: tokenMutation.data?.token,
    profileId,
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4" /> Saved portal sessions
            </CardTitle>
            <CardDescription>
              Encrypted logins Hamilton reuses to act inside your real portal accounts. You capture
              one by logging in + clearing 2FA once. GrantFlow relays live input to the portal but does not store or replay it.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={handleOpenSetup}>
            {setupOpen ? <X className="h-4 w-4 mr-1.5" /> : <Plus className="h-4 w-4 mr-1.5" />}
            {setupOpen ? "Close" : "Set up a new session"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {setupOpen && (
          <div className="space-y-4">
            {/* Plain-language disclaimer — what's captured, why, and the scope. */}
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 space-y-2 text-sm text-indigo-950">
              <p className="font-medium flex items-center gap-1.5">
                <Info className="h-4 w-4" /> What this does — please read
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li><strong>What:</strong> relays your live input to the private portal browser without storing, analyzing, logging, or replaying it, then captures the logged-in session only after you finish.</li>
                <li><strong>Why:</strong> lets Hamilton act inside this portal for you later (e.g. submit an application) without making you log in or approve 2FA every time.</li>
                <li><strong>Scope:</strong> the session is tied to <strong>this profile only</strong> and reused only for this profile’s work. You can revoke it anytime below.</li>
              </ul>
            </div>

            {/* OPTION B — cloud interactive login: self-serve on any device. */}
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 space-y-3 text-sm text-emerald-900">
              <p className="font-medium flex items-center gap-1.5">
                <Smartphone className="h-4 w-4" /> Log in from your phone or computer
              </p>
              {cloudConfigured ? (
                <>
                  <p>
                    You only need your <strong>username, password, and 2FA</strong> — Hamilton already knows the
                    portal. GrantFlow opens a clean, full-screen secure login window with a live view of a real
                    browser. You sign in and approve 2FA on your phone right there; when you’re done, click
                    “Done — I’ve finished logging in” in that window and the session is captured for this profile.
                  </p>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-emerald-800/80">Leave the portal blank and Hamilton fills it in — or let her auto-fill now.</p>
                    <Button
                      type="button" size="sm" variant="outline"
                      className="h-7 gap-1 px-2 text-xs border-indigo-200 bg-indigo-50 text-indigo-900 hover:bg-indigo-100"
                      onClick={() => cloudSuggestMutation.mutate()}
                      disabled={cloudSuggestMutation.isPending}
                      title="Let Hamilton fill the portal host + login URL"
                    >
                      {cloudSuggestMutation.isPending
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Wand2 className="h-3.5 w-3.5" />}
                      Auto-fill with Hamilton
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input placeholder="Portal host (optional — Hamilton knows it)" value={portalHost} onChange={(e) => setPortalHost(e.target.value)} />
                    <Input placeholder="Login URL (optional)" value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} />
                  </div>
                  {cloudFilledByHamilton && (
                    <p className="text-xs text-indigo-700 flex items-center gap-1">
                      <Sparkles className="h-3 w-3" /> Filled by Hamilton — edit if needed.
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" disabled={cloudStartMutation.isPending} onClick={handleStartCloudLogin}>
                      {cloudStartMutation.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Globe className="h-4 w-4 mr-1.5" />}
                      Open secure login window
                    </Button>
                    {liveOpened && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => queryClient.invalidateQueries({ queryKey: ["hamilton-portal-sessions", profileId] })}
                      >
                        <ShieldCheck className="h-4 w-4 mr-1.5" /> Refresh saved sessions
                      </Button>
                    )}
                  </div>
                  {liveOpened && (
                    <p className="text-xs text-emerald-800">
                      Finished in the login window? Click <strong>Refresh saved sessions</strong> to see it
                      appear below. If the window didn’t open, allow pop-ups for GrantFlow and try again.
                    </p>
                  )}
                </>
              ) : (
                <p>
                  In-app cloud login isn’t enabled on this deployment yet. Use <strong>Saved Login</strong>
                  {" "}below (works on any phone or computer), or an admin can capture a session from a computer.
                </p>
              )}
            </div>

            {/* OPTION A pointer — phone-friendly, owner-independent: save the login. */}
            <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 space-y-1 text-sm text-sky-900">
              <p className="font-medium flex items-center gap-1.5">
                <KeyRound className="h-4 w-4" /> Or save your login (works on any device)
              </p>
              <p>
                Enter your portal username + password (and an authenticator/2FA secret if you have one)
                in <strong>Saved Logins</strong>. Hamilton signs in for you each run. For portals that send
                a “tap to approve” 2FA push, Hamilton will notify you to approve it when it runs.
              </p>
            </div>

            {/* Advanced / owner: capture from a computer via the CLI tool. */}
            <details className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
              <summary className="cursor-pointer font-medium">Advanced: capture from a computer (owner)</summary>
              <p className="mt-2">
              Run this in the GrantFlow repo. A browser window opens — log in and clear 2FA, then
              return to the terminal and press Enter. The session uploads encrypted and Hamilton
              reuses it.
            </p>
            {tokenMutation.isPending && (
              <p className="flex items-center gap-1.5 text-sky-700">
                <Loader2 className="h-4 w-4 animate-spin" /> Generating a one-click capture token…
              </p>
            )}
            <div className="relative">
              <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 pr-10 text-xs text-slate-100">
                {captureCommand}
              </pre>
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-1.5 top-1.5 h-7 w-7 text-slate-300 hover:text-white"
                onClick={() => handleCopy(captureCommand, "Capture command")}
                title="Copy command"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            {!tokenMutation.data && !tokenMutation.isPending && (
              <Button size="sm" variant="secondary" onClick={() => tokenMutation.mutate()}>
                Generate a one-click token
              </Button>
            )}
            <details className="text-xs text-sky-800">
              <summary className="cursor-pointer font-medium">No token? Use file mode instead</summary>
              <p className="mt-2">
                Pass <code>--out session.json</code> to write the captured session to a local file
                (no token needed), then hand the file to Hamilton to import:
              </p>
              <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">
                {buildOutModeCommand(profileId)}
              </pre>
            </details>
            </details>
          </div>
        )}

        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading saved sessions…
          </p>
        )}

        {isError && !isLoading && (
          <p className="text-sm text-destructive">Could not load saved sessions. Please try again.</p>
        )}

        {!isLoading && !isError && sessions.length === 0 && (
          <div className="rounded-lg border border-dashed border-muted-foreground/30 p-6 text-center">
            <ShieldX className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">No saved sessions yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Capture one so Hamilton can act inside your real portal account. Run{" "}
              <code>tools/hamilton-session-capture/capture.mjs</code> with{" "}
              <code>--out session.json</code> (file mode, no token), or click{" "}
              <span className="font-medium">Set up a new session</span> above for a one-click command.
            </p>
          </div>
        )}

        {!isLoading && !isError && sessions.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border">
            {sessions.map((session) => {
              const status = effectiveStatus(session)
              const exp = expiryInfo(session)
              const isActionable = status.key !== "revoked"
              return (
                <li key={session.id} className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium truncate">{session.portal_host || "Unknown host"}</span>
                      <Badge variant={status.variant}>
                        {status.key === "valid" ? (
                          <ShieldCheck className="h-3 w-3 mr-1" />
                        ) : (
                          <ShieldX className="h-3 w-3 mr-1" />
                        )}
                        {status.label}
                      </Badge>
                    </div>
                    {session.label && (
                      <p className="text-sm text-muted-foreground truncate">{session.label}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span
                        className={
                          exp.tone === "bad"
                            ? "text-destructive font-medium"
                            : exp.tone === "warn"
                              ? "text-amber-600 font-medium"
                              : ""
                        }
                      >
                        <Clock className="inline h-3 w-3 mr-1 -mt-0.5" />
                        {exp.label}
                      </span>
                      <span>Last used {formatWhen(session.last_used_at)}</span>
                      <span>Captured {formatWhen(session.established_at)}</span>
                    </div>
                  </div>
                  {isActionable && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={revokeMutation.isPending}
                      onClick={() => revokeMutation.mutate(session.id)}
                    >
                      {revokeMutation.isPending && revokeMutation.variables === session.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Revoke"
                      )}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
