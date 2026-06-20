/**
 * ProfilePortalsCard
 *
 * The friendly, per-profile "Portals" dashboard that replaces the old
 * "type the portal name + URL" form. EVERY portal that applies to this
 * profile — its schools and the funding sources of grants in its pipeline —
 * is auto-listed by the backend. The user never types a portal: they just
 * click one.
 *
 * Data:   GET /api/profiles/:id/portals → { portals: [ {
 *           portalHost, loginUrl, label, kind ("school"|"funding_source"),
 *           sources:[{title,grantId|opportunityId}],
 *           status ("ready"|"needs_setup"), hasCredential, hasSession,
 *           connectorId, supportsTwoWaySync,
 *           lastSync:{direction,status,at}|null } ] }
 *
 * Per tile:
 *   • status==="ready"      → GREEN "Ready — Hamilton can sign in" badge, plus
 *                             two-way sync controls (Pull / Push) when the
 *                             portal supportsTwoWaySync, with the REAL lastSync
 *                             status shown honestly, and a "Refresh sign-in"
 *                             button to re-open the secure login window.
 *   • status==="needs_setup"→ RED "Needs first login" badge; clicking the tile
 *                             opens the secure live-login window prefilled with
 *                             the portal host + login URL (NO typing). On
 *                             completion / window close we refetch so the tile
 *                             flips to GREEN.
 *
 * Tiles are grouped by kind (Schools / Funding sources). The manual
 * portal-host/URL entry now lives under an "Advanced — add a portal manually"
 * disclosure on the Pipeline tab; this dashboard is the primary path.
 *
 * HONESTY: the two-way sync status reflects the real latest portal_sync_runs
 * row reported by the backend (lastSync) — never a faked "synced!".
 */

import React from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  listProfilePortals,
  startCloudLogin,
  runPortalSyncRead,
  runPortalSyncWrite,
} from "@/api/hamilton"
import { openApplicationPacket } from "@/components/hamilton/applicationPacketPrint"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { showSuccessToast, showErrorToast } from "@/components/shared/toastHelpers"
import {
  LayoutGrid,
  Loader2,
  ShieldCheck,
  ShieldX,
  GraduationCap,
  Landmark,
  Globe,
  Download,
  Upload,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ArrowLeftRight,
  Printer,
  Mail,
} from "lucide-react"

function formatWhen(iso) {
  if (!iso) return "never"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "never"
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

// Map the real lastSync row to an honest visual cue. We never invent "synced!":
// running/queued stays neutral, only a recorded ok/success is green, and
// error/failed (or a present error string) is surfaced as bad.
function syncTone(lastSync) {
  if (!lastSync) return { label: "Never synced", variant: "secondary", tone: "muted", Icon: Clock }
  const s = String(lastSync.status || "").toLowerCase()
  if (lastSync.error || s === "error" || s === "failed") {
    return { label: "Sync failed", variant: "destructive", tone: "bad", Icon: AlertTriangle }
  }
  if (s === "ok" || s === "success" || s === "completed" || s === "done") {
    return { label: "Synced", variant: "default", tone: "ok", Icon: CheckCircle2 }
  }
  if (s === "running" || s === "queued" || s === "pending" || s === "in_progress") {
    return { label: "Syncing…", variant: "secondary", tone: "muted", Icon: Loader2 }
  }
  return { label: lastSync.status || "Unknown", variant: "secondary", tone: "muted", Icon: Clock }
}

function directionLabel(dir) {
  const d = String(dir || "").toLowerCase()
  if (d === "read") return "pulled from portal"
  if (d === "write") return "pushed to portal"
  if (d === "both") return "two-way sync"
  return d || "sync"
}

function sourceKey(src, idx) {
  return src?.grantId || src?.opportunityId || `${src?.title || "source"}-${idx}`
}

// Open the GrantFlow secure live-login window for this portal, prefilled — no
// typing. We prefer the backend-built liveUrl; if it's absent we build the
// same-origin /HamiltonLiveLogin route from the returned ids.
function openLiveLogin(res) {
  if (typeof window === "undefined") return false
  let url = res?.liveUrl
  if (!url) {
    const sessionId = res?.liveSessionId || res?.id
    if (!sessionId) return false
    const params = new URLSearchParams({ session: sessionId })
    if (res?.portalHost) params.set("host", res.portalHost)
    url = `/HamiltonLiveLogin?${params.toString()}`
  }
  window.open(url, "_blank", "noopener,noreferrer")
  return true
}

const KIND_GROUPS = [
  { key: "school", title: "Schools", Icon: GraduationCap },
  { key: "funding_source", title: "Funding sources", Icon: Landmark },
]

export default function ProfilePortalsCard({ profileId, profileName = "" }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const { data, isLoading, isError } = useQuery({
    queryKey: ["hamilton-profile-portals", profileId],
    queryFn: () => listProfilePortals(profileId),
    enabled: !!profileId,
    staleTime: 30_000,
  })

  const portals = Array.isArray(data?.portals) ? data.portals : []
  // Real funding sources that are NOT login portals — apply by mail/fax/email.
  const mailFaxSources = Array.isArray(data?.mailFaxSources) ? data.mailFaxSources : []

  const refetchPortals = () =>
    queryClient.invalidateQueries({ queryKey: ["hamilton-profile-portals", profileId] })

  // Click a RED tile → start a cloud login and open the prefilled secure window.
  const loginMutation = useMutation({
    mutationFn: (portal) =>
      startCloudLogin(profileId, {
        portalHost: portal.portalHost,
        loginUrl: portal.loginUrl || null,
        label: portal.label || `${portal.portalHost} session`,
      }),
    onSuccess: (res) => {
      const opened = openLiveLogin(res)
      if (opened) {
        showSuccessToast(
          toast,
          "Secure login window opened",
          "Sign in + approve 2FA in the new window, then click “Done” there. We’ll update this list automatically.",
        )
        // Refetch when the user returns to this tab (window closed / login done).
        const onFocus = () => {
          refetchPortals()
          window.removeEventListener("focus", onFocus)
        }
        if (typeof window !== "undefined") window.addEventListener("focus", onFocus)
      } else {
        showErrorToast(toast, "Couldn’t open the login window", "Allow pop-ups for GrantFlow and try again.")
      }
    },
    onError: (err) => showErrorToast(toast, "Could not start the secure login", err?.message || "Please try again."),
  })

  const readMutation = useMutation({
    mutationFn: (portal) => runPortalSyncRead(profileId, portal.portalHost),
    onSuccess: (res, portal) => {
      refetchPortals()
      if (res?.ok === false) {
        showErrorToast(toast, "Pull failed", res?.error || res?.detail || "See the status line for details.")
      } else {
        showSuccessToast(toast, "Pull started", `Pulling data from ${portal.portalHost}. Watch the status line for the result.`)
      }
    },
    onError: (err) => showErrorToast(toast, "Could not start pull", err?.message || "Please try again."),
  })

  const writeMutation = useMutation({
    mutationFn: (portal) => runPortalSyncWrite(profileId, portal.portalHost),
    onSuccess: (res, portal) => {
      refetchPortals()
      if (res?.ok === false) {
        showErrorToast(toast, "Push failed", res?.error || res?.detail || "See the status line for details.")
      } else {
        showSuccessToast(toast, "Push started", `Pushing this profile’s data to ${portal.portalHost}. Watch the status line for the result.`)
      }
    },
    onError: (err) => showErrorToast(toast, "Could not start push", err?.message || "Please try again."),
  })

  const busyLoginHost = loginMutation.isPending ? loginMutation.variables?.portalHost : null
  const busyReadHost = readMutation.isPending ? readMutation.variables?.portalHost : null
  const busyWriteHost = writeMutation.isPending ? writeMutation.variables?.portalHost : null

  const renderTile = (portal) => {
    const ready = portal.status === "ready"
    const host = portal.portalHost
    const sources = Array.isArray(portal.sources) ? portal.sources : []
    const sync = syncTone(portal.lastSync)
    const SyncIcon = sync.Icon
    const isLoggingIn = busyLoginHost === host
    const isReading = busyReadHost === host
    const isWriting = busyWriteHost === host
    const syncBusy = isReading || isWriting

    return (
      <li
        key={portal.connectorId || host}
        className={`rounded-lg border p-3 ${ready ? "border-emerald-200 bg-emerald-50/40" : "border-rose-200 bg-rose-50/40"}`}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium truncate">{portal.label || host}</span>
              {ready ? (
                <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white">
                  <ShieldCheck className="h-3 w-3 mr-1" /> Ready — Hamilton can sign in
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <ShieldX className="h-3 w-3 mr-1" /> Needs first login
                </Badge>
              )}
            </div>
            {portal.label && host && portal.label !== host && (
              <p className="text-xs text-muted-foreground truncate">{host}</p>
            )}
            {sources.length > 0 && (
              <p className="text-sm text-muted-foreground">
                <span className="text-muted-foreground/80">Serves:</span>{" "}
                {sources.map((src, idx) => (
                  <span key={sourceKey(src, idx)}>
                    {idx > 0 ? ", " : ""}
                    {src?.title || "Untitled"}
                  </span>
                ))}
              </p>
            )}
            {/* Honest last-sync status for ready portals. */}
            {ready && portal.supportsTwoWaySync && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <SyncIcon className={`h-3 w-3 ${sync.label === "Syncing…" ? "animate-spin" : ""}`} />
                  <span className={sync.tone === "bad" ? "text-destructive font-medium" : ""}>{sync.label}</span>
                </span>
                {portal.lastSync && (
                  <span>
                    Last {directionLabel(portal.lastSync.direction)} {formatWhen(portal.lastSync.at)}
                  </span>
                )}
                {portal.lastSync?.error && (
                  <span className="text-destructive">Error: {String(portal.lastSync.error).slice(0, 160)}</span>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
            {ready ? (
              <div className="flex flex-wrap items-center gap-2">
                {portal.supportsTwoWaySync && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={syncBusy}
                      onClick={() => readMutation.mutate(portal)}
                    >
                      {isReading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
                      Pull from portal
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={syncBusy}
                      onClick={() => writeMutation.mutate(portal)}
                    >
                      {isWriting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Upload className="h-4 w-4 mr-1.5" />}
                      Push to portal
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isLoggingIn}
                  onClick={() => loginMutation.mutate(portal)}
                  title="Re-open the secure login window to refresh this session"
                >
                  {isLoggingIn ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}
                  Refresh sign-in
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                disabled={isLoggingIn}
                onClick={() => loginMutation.mutate(portal)}
              >
                {isLoggingIn ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Globe className="h-4 w-4 mr-1.5" />}
                Sign in to set up
              </Button>
            )}
          </div>
        </div>

        {/* What two-way exchange means for this portal. */}
        {ready && portal.supportsTwoWaySync && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
            <ArrowLeftRight className="mt-0.5 h-3 w-3 shrink-0" />
            Shares this profile&rsquo;s other scholarships with the portal (e.g. the school&rsquo;s
            financial-aid office), and updates GrantFlow from the portal&rsquo;s award info.
          </p>
        )}
      </li>
    )
  }

  // A non-portal real funding source: apply by mail/fax/email. No login tile —
  // instead show its contact block + a "Print application packet" action.
  const renderMailFaxSource = (src, idx) => {
    const host = src.host || ""
    const title = src.title || host || "Funding source"
    const method = String(src.applicationMethod || "").trim()
    const contact = (src.contact && typeof src.contact === "object") ? src.contact : {}
    const key = src.grantId || src.opportunityId || `${host}-${idx}`
    return (
      <li key={key} className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium truncate">{title}</span>
              <Badge variant="secondary" className="capitalize">
                <Mail className="h-3 w-3 mr-1" /> Apply by {method || "mail/fax/email"}
              </Badge>
            </div>
            {host && host !== title && <p className="text-xs text-muted-foreground truncate">{host}</p>}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {contact.name && <span>{contact.name}</span>}
              {contact.email && (
                <a href={`mailto:${encodeURIComponent(contact.email)}`} className="text-indigo-600 hover:underline">{contact.email}</a>
              )}
              {contact.phone && <span>{contact.phone}</span>}
              {contact.fax && <span>Fax: {contact.fax}</span>}
              {contact.address && <span className="truncate">{contact.address}</span>}
            </div>
            {!contact.name && !contact.email && !contact.phone && !contact.fax && !contact.address && (
              <p className="text-xs italic text-muted-foreground">
                No contact details on file yet — the packet links the funder&rsquo;s page for how to apply.
              </p>
            )}
          </div>
          <div className="shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={() => openApplicationPacket({ profileName, source: src })}
              title="Open a printable application packet — contact info + how to mail/fax/email"
            >
              <Printer className="h-4 w-4 mr-1.5" /> Print application packet
            </Button>
          </div>
        </div>
      </li>
    )
  }

  const nothingToShow =
    !isLoading && !isError && portals.length === 0 && mailFaxSources.length === 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <LayoutGrid className="h-4 w-4" /> Portals
            </CardTitle>
            <CardDescription>
              Every portal that applies to this profile — its schools and the funding sources of grants
              in its pipeline — is listed for you. No typing: a <strong>green</strong> portal is ready for
              Hamilton to sign in; click a <strong>red</strong> one to log in once in a secure window.
            </CardDescription>
          </div>
          <Button size="sm" variant="ghost" onClick={refetchPortals} title="Refresh portals">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Finding portals for this profile…
          </p>
        )}

        {isError && !isLoading && (
          <p className="text-sm text-destructive">Could not load this profile&rsquo;s portals. Please try again.</p>
        )}

        {nothingToShow && (
          <div className="rounded-lg border border-dashed border-muted-foreground/30 p-6 text-center">
            <Globe className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">No portals to show yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              As this profile gains schools or grants in its pipeline, the portals Hamilton can sign in
              to will appear here automatically. You can also add one under{" "}
              <span className="font-medium">Advanced — add a portal manually</span> below.
            </p>
          </div>
        )}

        {!isLoading && !isError && portals.length > 0 &&
          KIND_GROUPS.map((group) => {
            const groupPortals = portals.filter((p) => p.kind === group.key)
            if (groupPortals.length === 0) return null
            const GroupIcon = group.Icon
            return (
              <div key={group.key} className="space-y-2">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
                  <GroupIcon className="h-4 w-4" /> {group.title}
                </h4>
                <ul className="space-y-2">{groupPortals.map(renderTile)}</ul>
              </div>
            )
          })}

        {/* Any portals whose kind isn't one of the known groups still get shown. */}
        {!isLoading && !isError && portals.length > 0 && (() => {
          const known = new Set(KIND_GROUPS.map((g) => g.key))
          const other = portals.filter((p) => !known.has(p.kind))
          if (other.length === 0) return null
          return (
            <div className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
                <Globe className="h-4 w-4" /> Other portals
              </h4>
              <ul className="space-y-2">{other.map(renderTile)}</ul>
            </div>
          )
        })()}

        {/* NON-PORTAL real funding sources: apply by mail/fax/email. These have
            a URL but no login portal, so we never show a sign-in tile — instead
            Hamilton produces a printable application packet. */}
        {!isLoading && !isError && mailFaxSources.length > 0 && (
          <div className="space-y-2">
            <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              <Mail className="h-4 w-4" /> Apply by mail/fax/email
            </h4>
            <p className="text-xs text-muted-foreground">
              These funders don&rsquo;t use an online login portal. Print an application packet — the
              funder&rsquo;s contact info plus clear instructions on where to mail, fax, or email the application.
            </p>
            <ul className="space-y-2">{mailFaxSources.map(renderMailFaxSource)}</ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
