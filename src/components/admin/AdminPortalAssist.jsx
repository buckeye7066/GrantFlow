/**
 * AdminPortalAssist
 *
 * Admin-only "Portal Assist" surface. Lets the configured operator (or any
 * authorized admin) pick ANY profile and open that user's official portal for
 * a visible manual handoff — the concrete case being a
 * deadline-pressed applicant (e.g. Demo Student) who can't get signed in herself.
 *
 * Why this exists even though admins can already reach any profile: the access
 * layer already authorizes an admin on every profile (getAccessibleProfileIds →
 * null = global), and the cloud-login start endpoint honors that. What was
 * missing was a single, purpose-built place to (a) jump to any profile's portals
 * and (b) knock out EVERY not-yet-signed-in portal one after another. This
 * component adds only that convenience; every action underneath is an existing,
 * vetted primitive.
 *
 * It reuses, unchanged:
 *   • listProfiles              → the profile picker
 *   • listProfilePortals        → the same GET /api/profiles/:id/portals the
 *                                 user's own Portals dashboard uses
 *   • openWithHamiltonWatching  → controlled-beta manual portal open; real
 *                                 domains never call the server-browser API.
 *   • <ProfilePortalsCard/>     → the full per-profile toolset (per-portal login,
 *                                 autopilot, packets, two-way sync) rendered
 *                                 below, so nothing is lost vs visiting the
 *                                 profile directly.
 *
 * The only new behavior is the "Open logins one at a time" guided bar: browsers
 * block a bulk window.open, so "open all" is honestly a sequential walk — open
 * the next not-ready portal on each click; when the admin returns to this tab
 * (the popup closed / login finished) the list refetches and signed-in portals
 * drop out of the queue.
 */

import React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { listProfiles } from "@/api/profiles"
import { listProfilePortals } from "@/api/hamilton"
import { openWithHamiltonWatching } from "@/components/hamilton/hamiltonWatchedOpen"
import ProfilePortalsCard from "@/components/hamilton/ProfilePortalsCard"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { useToast } from "@/components/ui/use-toast"
import { showErrorToast } from "@/components/shared/toastHelpers"
import {
  PanelsTopLeft,
  Search,
  Loader2,
  ShieldCheck,
  CheckCircle2,
  RefreshCw,
  UserCog,
} from "lucide-react"

// A portal still needs a login when it isn't "ready" AND we actually resolved a
// host to sign in to (process/mail tiles without a host can't be co-browsed).
function needsLogin(portal) {
  return portal && portal.status !== "ready" && Boolean(portal.portalHost)
}

export default function AdminPortalAssist() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [filter, setFilter] = React.useState("")
  const [selectedId, setSelectedId] = React.useState("")

  // Every profile (admin gets the full list, up to the API's admin page size).
  const profilesQuery = useQuery({
    queryKey: ["admin-portal-assist-profiles"],
    queryFn: () => listProfiles({ summary: true }),
    staleTime: 120_000,
  })
  const profiles = React.useMemo(() => {
    const res = profilesQuery.data
    const list = Array.isArray(res) ? res : res?.profiles || res?.items || res?.data || []
    return list
      .map((p) => ({
        id: p.id,
        name: p.display_name || p.name || p.full_name || "(unnamed profile)",
        type: p.primary_type || p.type || "",
      }))
      .filter((p) => p.id)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [profilesQuery.data])

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return profiles
    return profiles.filter(
      (p) => p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q),
    )
  }, [profiles, filter])

  const selectedProfile = profiles.find((p) => p.id === selectedId) || null

  // The chosen profile's portals — SAME query key the ProfilePortalsCard uses,
  // so this bar and the card share one cache and update together.
  const portalsQuery = useQuery({
    queryKey: ["hamilton-profile-portals", selectedId],
    queryFn: () => listProfilePortals(selectedId),
    enabled: !!selectedId,
    staleTime: 120_000,
  })
  const portals = Array.isArray(portalsQuery.data?.portals) ? portalsQuery.data.portals : []
  const pending = portals.filter(needsLogin)
  const readyCount = portals.filter((p) => p.status === "ready").length

  const refetchPortals = () =>
    queryClient.invalidateQueries({ queryKey: ["hamilton-profile-portals", selectedId] })

  // Refresh the list the next time the admin returns to this tab — the honest
  // signal that they finished (or closed) the secure login popup, since the
  // popup handle exposes no close event. One-shot so listeners never accumulate.
  const refreshOnReturn = React.useRef(false)
  React.useEffect(() => {
    const onFocus = () => {
      if (refreshOnReturn.current) {
        refreshOnReturn.current = false
        refetchPortals()
      }
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [selectedId])

  const [openingHost, setOpeningHost] = React.useState(null)

  // Open one official portal in the admin's own browser. The shared helper
  // never calls cloud login for real domains during controlled beta.
  const openPortalLogin = async (portal) => {
    if (!selectedId || !portal?.portalHost) return
    setOpeningHost(portal.portalHost)
    try {
      await openWithHamiltonWatching({
        profileId: selectedId,
        url: portal.loginUrl || `https://${portal.portalHost}/`,
        label: portal.label || `${portal.portalHost} session`,
        toast,
      })
      refreshOnReturn.current = true
    } catch (err) {
      showErrorToast(toast, "Could not open the official portal", err?.message || "Please try again.")
    } finally {
      setOpeningHost(null)
    }
  }

  // "Open logins one at a time": open the FIRST portal still needing a login.
  // Each click handles one; returning to the tab refetches and the queue shrinks.
  const openNextLogin = () => {
    const next = pending[0]
    if (next) openPortalLogin(next)
  }

  // ANY-portal launcher: the owner asked to be able to open a portal that is
  // NOT on the profile's discovered list (or one whose tile has no resolved
  // host) with Hamilton watching, so a session exists before the user needs it.
  // Paste a login URL → we derive the host and run the exact same secure
  // cloud-login flow; the captured session binds to the selected profile.
  const [customUrl, setCustomUrl] = React.useState("")
  const openCustomPortal = () => {
    const raw = customUrl.trim()
    if (!selectedId || !raw) return
    let parsed
    try {
      parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    } catch {
      showErrorToast(toast, "Not a valid portal address", "Paste the portal's login page URL (e.g. https://portal.school.edu/login).")
      return
    }
    const host = parsed.hostname.replace(/^www\./i, "")
    openPortalLogin({
      portalHost: host,
      loginUrl: parsed.href,
      label: host,
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserCog className="h-5 w-5 text-primary" />
            Portal Assist — sign in for a user
          </CardTitle>
          <CardDescription>
            Pick a profile and open its official portals for a visible manual handoff. Controlled
            beta does not run a server browser, capture logins, or submit anything on the user&rsquo;s behalf.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Profile picker */}
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search profiles by name or type…"
                className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            {profilesQuery.isLoading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading profiles…
              </div>
            ) : profilesQuery.isError ? (
              <p className="py-2 text-sm text-red-600">Could not load profiles. Try again.</p>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                {filtered.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">No profiles match “{filter}”.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {filtered.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(p.id)}
                          className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 ${
                            selectedId === p.id ? "bg-muted font-semibold" : ""
                          }`}
                        >
                          <span className="truncate">{p.name}</span>
                          <span className="flex items-center gap-2">
                            {p.type && (
                              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                                {p.type}
                              </span>
                            )}
                            {selectedId === p.id && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Guided "open each login" bar for the selected profile */}
          {selectedProfile && (
            <div className="rounded-lg border border-border bg-muted/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 font-semibold text-foreground">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    Assisting {selectedProfile.name}
                  </p>
                  {portalsQuery.isLoading ? (
                    <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading portals…
                    </p>
                  ) : (
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {portals.length} portal{portals.length === 1 ? "" : "s"} · {readyCount} with saved access ·{" "}
                      <span className={pending.length ? "font-semibold text-amber-600" : ""}>
                        {pending.length} need{pending.length === 1 ? "s" : ""} login
                      </span>
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => refetchPortals()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title="Refresh portal statuses"
                  >
                    <RefreshCw className={`h-4 w-4 ${portalsQuery.isFetching ? "animate-spin" : ""}`} />
                    Refresh
                  </button>
                  {pending.length > 0 ? (
                    <button
                      type="button"
                      onClick={openNextLogin}
                      disabled={Boolean(openingHost)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      title={`Open the official portal for ${pending[0]?.label || pending[0]?.portalHost}`}
                    >
                      {openingHost ? <Loader2 className="h-4 w-4 animate-spin" /> : <PanelsTopLeft className="h-4 w-4" />}
                      Open next portal manually → {pending[0]?.label || pending[0]?.portalHost}
                    </button>
                  ) : (
                    !portalsQuery.isLoading && (
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
                        <CheckCircle2 className="h-4 w-4" /> No portal login flagged
                      </span>
                    )
                  )}
                </div>
              </div>
              {pending.length > 1 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Open the {pending.length} remaining portals one at a time and complete each login or required check manually.
                </p>
              )}

              {/* Launch ANY portal — even one not on this profile's list yet. */}
              <div className="mt-4 border-t border-border pt-3">
                <p className="text-sm font-medium text-foreground">Launch any portal</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Not listed above? Paste the official login page and open it directly. Controlled beta
                  does not capture or replay the session.
                </p>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input
                    type="url"
                    value={customUrl}
                    onChange={(e) => setCustomUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") openCustomPortal() }}
                    placeholder="https://portal.example.edu/login"
                    className="w-full flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={openCustomPortal}
                    disabled={Boolean(openingHost) || !customUrl.trim()}
                    className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {openingHost ? <Loader2 className="h-4 w-4 animate-spin" /> : <PanelsTopLeft className="h-4 w-4" />}
                    Open with Hamilton watching
                  </button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Full per-profile portals dashboard for the selected profile — the same
          card the user sees, giving the admin every action (per-portal login,
          autopilot, packets, two-way sync) in addition to the guided bar above. */}
      {selectedProfile && (
        <ProfilePortalsCard profileId={selectedId} profileName={selectedProfile.name} />
      )}
    </div>
  )
}
