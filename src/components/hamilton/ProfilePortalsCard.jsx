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
 *   • status==="ready"      → GREEN "Ready" tile (emerald left-border + badge),
 *                             plus two-way sync controls (Pull / Push) when the
 *                             portal supportsTwoWaySync, with the REAL lastSync
 *                             status shown honestly, and a "Refresh sign-in"
 *                             button to re-open the secure login window.
 *   • status==="needs_setup"→ RED "Needs login" tile (coral left-border + badge);
 *                             clicking "Log in once" opens the secure live-login
 *                             window prefilled with the portal host + login URL
 *                             (NO typing). On completion / window close we refetch
 *                             so the tile flips to GREEN.
 *
 * Tiles are grouped by kind (Schools / Applications & forms / Funding sources).
 * The manual portal-host/URL entry lives under an "Advanced" disclosure.
 *
 * DESIGN: Funding Current identity — emerald=ready, coral=needs-you, amber focus
 * rings, Bricolage Grotesque display + Space Mono labels. This is a RESTYLE only:
 * all handlers, mutations and data flow are unchanged.
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
  saveApplicationPacket,
  packetDownloadUrl,
} from "@/api/hamilton"
import { openApplicationPacket } from "@/components/hamilton/applicationPacketPrint"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { StatusDot } from "@/components/ui/StatusDot"
import { useToast } from "@/components/ui/use-toast"
import { showSuccessToast, showErrorToast } from "@/components/shared/toastHelpers"
import {
  LayoutGrid,
  Loader2,
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
  FileText,
  HeartHandshake,
  ClipboardList,
  ExternalLink,
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
  if (!lastSync) return { label: "Never synced", tone: "muted", Icon: Clock }
  const s = String(lastSync.status || "").toLowerCase()
  if (lastSync.error || s === "error" || s === "failed") {
    return { label: "Sync failed", tone: "bad", Icon: AlertTriangle }
  }
  if (s === "ok" || s === "success" || s === "completed" || s === "done") {
    return { label: "Synced", tone: "ok", Icon: CheckCircle2 }
  }
  if (s === "running" || s === "queued" || s === "pending" || s === "in_progress") {
    return { label: "Syncing…", tone: "muted", Icon: Loader2 }
  }
  return { label: lastSync.status || "Unknown", tone: "muted", Icon: Clock }
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
  { key: "process", title: "Applications & forms", Icon: ClipboardList },
  { key: "funding_source", title: "Funding sources", Icon: Landmark },
  { key: "benefit", title: "Benefits & assistance", Icon: HeartHandshake },
]

// Shared Funding Current button styles (opt-in; do not affect global buttons).
const BTN_BASE =
  "inline-flex items-center gap-1.5 rounded-[10px] border border-current-line bg-transparent px-3.5 py-2 text-sm font-semibold text-current-ink transition-transform hover:-translate-y-px disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
const BTN_CORAL =
  "inline-flex items-center gap-1.5 rounded-[10px] border border-transparent bg-current-coral px-3.5 py-2 text-sm font-semibold text-white transition-transform hover:-translate-y-px disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
const BTN_EMERALD =
  "inline-flex items-center gap-1.5 rounded-[10px] border border-transparent bg-current-emerald px-3.5 py-2 text-sm font-semibold text-white transition-transform hover:-translate-y-px disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0"

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

  // Save (or re-use) a durable application packet Document for a mail/fax source.
  // The button ALSO opens the printable view; this mutation persists it so the
  // page shows "Packet saved to Documents" with a link.
  const packetMutation = useMutation({
    mutationFn: (src) => saveApplicationPacket(profileId, { source: src, profileName }),
    onSuccess: (res) => {
      refetchPortals()
      if (res?.documentId) {
        showSuccessToast(
          toast,
          res?.reused ? "Packet already saved" : "Packet saved to Documents",
          "You can print it now and find it later in this profile's Documents.",
        )
      }
    },
    onError: (err) => showErrorToast(toast, "Could not save the packet", err?.message || "It still opened for printing."),
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

    const tileKey = host || portal.label || portal.connectorId || "tile"

    return (
      <li
        key={tileKey}
        className={`relative flex flex-col gap-3 rounded-2xl border border-current-line bg-current-card p-[18px] transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[0_18px_36px_-26px_rgba(20,36,31,0.55)] motion-reduce:transition-none motion-reduce:hover:translate-y-0 ${
          ready ? "border-l-[5px] border-l-current-emerald" : "border-l-[5px] border-l-current-coral"
        }`}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h3 className="font-display text-[18px] font-bold leading-tight tracking-[-0.01em] text-current-ink">
              {portal.label || host}
            </h3>
            {portal.label && host && portal.label !== host && (
              <p className="money truncate text-xs text-current-ink/60">{host}</p>
            )}
            {sources.length > 0 && (
              <p className="text-[13px] text-current-ink/70">
                <span className="text-current-ink/55">Serves:</span>{" "}
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
              <div className="money flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[11.5px] text-current-ink/70">
                <span className="inline-flex items-center gap-1">
                  <SyncIcon className={`h-3 w-3 ${sync.label === "Syncing…" ? "animate-spin motion-reduce:animate-none" : ""}`} />
                  <span className={sync.tone === "bad" ? "font-bold text-current-coral" : ""}>{sync.label}</span>
                </span>
                {portal.lastSync && (
                  <span>
                    Last {directionLabel(portal.lastSync.direction)} {formatWhen(portal.lastSync.at)}
                  </span>
                )}
                {portal.lastSync?.error && (
                  <span className="text-current-coral">Error: {String(portal.lastSync.error).slice(0, 160)}</span>
                )}
              </div>
            )}
          </div>

          <span
            className={`money inline-flex shrink-0 items-center gap-1.5 self-start whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.06em] ${
              ready
                ? "border-[#bfe0cd] bg-current-emeraldSoft text-[#0d5536]"
                : "border-[#f1cabd] bg-current-coralSoft text-[#9a3320]"
            }`}
          >
            <StatusDot tone={ready ? "ready" : "needs"} size="sm" />
            {ready ? "Ready" : "Needs login"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {ready ? (
            <>
              {portal.supportsTwoWaySync && (
                <>
                  <button
                    type="button"
                    className={BTN_BASE}
                    disabled={syncBusy}
                    onClick={() => readMutation.mutate(portal)}
                  >
                    {isReading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Download className="h-4 w-4" />}
                    Pull from portal
                  </button>
                  <button
                    type="button"
                    className={BTN_BASE}
                    disabled={syncBusy}
                    onClick={() => writeMutation.mutate(portal)}
                  >
                    {isWriting ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Upload className="h-4 w-4" />}
                    Push to portal
                  </button>
                </>
              )}
              <button
                type="button"
                className={BTN_BASE}
                disabled={isLoggingIn}
                onClick={() => loginMutation.mutate(portal)}
                title="Re-open the secure login window to refresh this session"
              >
                {isLoggingIn ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-4 w-4" />}
                Refresh sign-in
              </button>
              {!portal.supportsTwoWaySync && portal.loginUrl && (
                <a className={BTN_BASE} href={portal.loginUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" /> Open portal
                </a>
              )}
            </>
          ) : host ? (
            <button
              type="button"
              className={BTN_CORAL}
              disabled={isLoggingIn}
              onClick={() => loginMutation.mutate(portal)}
            >
              {isLoggingIn ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Globe className="h-4 w-4" />}
              Log in once →
            </button>
          ) : portal.loginUrl ? (
            // Process/school tile we resolved a URL for but can't host-scope a
            // login session: just open it in a new tab.
            <a className={BTN_BASE} href={portal.loginUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" /> Open
            </a>
          ) : (
            // The student's own school with no resolved portal yet — still
            // listed so it's not forgotten; no login to set up.
            <span className="text-xs text-current-ink/60">Add this school&rsquo;s login under Advanced</span>
          )}
        </div>

        {/* What two-way exchange means for this portal. */}
        {ready && portal.supportsTwoWaySync && (
          <p className="money flex items-start gap-1.5 text-[11.5px] text-current-ink/70">
            <ArrowLeftRight className="mt-0.5 h-3 w-3 shrink-0" />
            two-way: shares this profile&rsquo;s scholarships ↔ updates from the portal&rsquo;s award info
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
    const packet = (src.packet && typeof src.packet === "object") ? src.packet : {}
    const packetSaved = Boolean(packet.generated && packet.documentId)
    const downloadHref = packetSaved ? packetDownloadUrl(profileId, packet.documentId) : null
    const isSaving = packetMutation.isPending && packetMutation.variables === src
    // Open the printable packet AND save a durable copy to Documents in one click.
    const handlePacket = () => {
      openApplicationPacket({ profileName, source: src })
      packetMutation.mutate(src)
    }
    return (
      <li key={key} className="flex flex-col gap-3 border-b border-current-line py-3 last:border-b-0 sm:flex-row sm:items-center">
        <div className="min-w-0 space-y-1">
          <div className="font-semibold text-current-ink">{title}</div>
          <div className="money text-xs text-current-ink/70">
            {method || "mail/fax/email"}
            {host && host !== title ? ` · ${host}` : ""}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-current-ink/70">
            {contact.name && <span>{contact.name}</span>}
            {contact.email && (
              <a href={`mailto:${encodeURIComponent(contact.email)}`} className="text-current-emerald hover:underline">{contact.email}</a>
            )}
            {contact.phone && <span>{contact.phone}</span>}
            {contact.fax && <span>Fax: {contact.fax}</span>}
            {contact.address && <span className="truncate">{contact.address}</span>}
          </div>
          {!contact.name && !contact.email && !contact.phone && !contact.fax && !contact.address && (
            <p className="text-xs italic text-current-ink/60">
              No contact details on file yet — the packet links the funder&rsquo;s page for how to apply.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ml-auto">
          {packetSaved && (
            <span className="money inline-flex items-center gap-1 rounded-full border border-[#bfe0cd] bg-current-emeraldSoft px-2.5 py-1 text-[11.5px] text-[#0d5536]">
              <FileText className="h-3 w-3" />
              Packet saved to Documents
              {downloadHref && (
                <a href={downloadHref} target="_blank" rel="noopener noreferrer" className="underline">
                  view
                </a>
              )}
            </span>
          )}
          <button
            type="button"
            className={packetSaved ? BTN_BASE : BTN_EMERALD}
            disabled={isSaving}
            onClick={handlePacket}
            title="Open a printable application packet and save a copy to this profile's Documents"
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Printer className="h-4 w-4" />}
            {packetSaved ? "View / print" : "Make packet"}
          </button>
        </div>
      </li>
    )
  }

  const nothingToShow =
    !isLoading && !isError && portals.length === 0 && mailFaxSources.length === 0

  const renderGroup = (title, GroupIcon, groupPortals) => (
    <div className="space-y-3">
      <h4 className="money flex items-center gap-2.5 text-xs font-bold uppercase tracking-[0.12em] text-current-ink/60">
        <GroupIcon className="h-4 w-4" />
        {title}
        <span aria-hidden="true" className="h-px flex-1 bg-current-line" />
      </h4>
      <ul className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">{groupPortals.map(renderTile)}</ul>
    </div>
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 font-display text-current-ink">
              <LayoutGrid className="h-4 w-4" /> Portals
            </CardTitle>
            <CardDescription>
              These are the places you sign in to get your funding. Sign in once and Hamilton remembers it.
            </CardDescription>
            {/* Legend — the color status language. */}
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-current-ink/70">
              <span className="inline-flex items-center gap-2">
                <StatusDot tone="ready" />
                <strong className="font-semibold text-current-ink">Green</strong> — all set, Hamilton can sign in
              </span>
              <span className="inline-flex items-center gap-2">
                <StatusDot tone="needs" />
                <strong className="font-semibold text-current-ink">Red</strong> — click it to log in once
              </span>
            </div>
          </div>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-[10px] border border-current-line bg-transparent p-2 text-current-ink transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            onClick={refetchPortals}
            title="Refresh portals"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>

      <CardContent className="space-y-7">
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-current-ink/70">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Finding portals for this profile…
          </p>
        )}

        {isError && !isLoading && (
          <p className="text-sm text-current-coral">Could not load this profile&rsquo;s portals. Please try again.</p>
        )}

        {nothingToShow && (
          <div className="rounded-2xl border border-dashed border-current-line p-6 text-center">
            <Globe className="mx-auto h-6 w-6 text-current-ink/50" />
            <p className="mt-2 text-sm font-semibold text-current-ink">No portals to show yet</p>
            <p className="mt-1 text-sm text-current-ink/70">
              As this profile gains schools or grants in its pipeline, the portals Hamilton can sign in
              to will appear here automatically. You can also add one under{" "}
              <span className="font-medium">Advanced</span> below.
            </p>
          </div>
        )}

        {!isLoading && !isError && portals.length > 0 &&
          KIND_GROUPS.map((group) => {
            const groupPortals = portals.filter((p) => p.kind === group.key)
            if (groupPortals.length === 0) return null
            return (
              <React.Fragment key={group.key}>
                {renderGroup(group.title, group.Icon, groupPortals)}
              </React.Fragment>
            )
          })}

        {/* Any portals whose kind isn't one of the known groups still get shown. */}
        {!isLoading && !isError && portals.length > 0 && (() => {
          const known = new Set(KIND_GROUPS.map((g) => g.key))
          const other = portals.filter((p) => !known.has(p.kind))
          if (other.length === 0) return null
          return renderGroup("Other portals", Globe, other)
        })()}

        {/* NON-PORTAL real funding sources: apply by mail/fax/email. These have
            a URL but no login portal, so we never show a sign-in tile — instead
            Hamilton produces a printable application packet. */}
        {!isLoading && !isError && mailFaxSources.length > 0 && (
          <div className="space-y-3">
            <h4 className="money flex items-center gap-2.5 text-xs font-bold uppercase tracking-[0.12em] text-current-ink/60">
              <Mail className="h-4 w-4" />
              Apply by mail or fax
              <span aria-hidden="true" className="h-px flex-1 bg-current-line" />
            </h4>
            <p className="text-xs text-current-ink/70">
              These funders don&rsquo;t use an online login portal. Make an application packet — the
              funder&rsquo;s contact info plus clear instructions on where to mail, fax, or email the application.
            </p>
            <ul className="rounded-2xl border border-current-line bg-[#eef1ec] px-5 py-1">{mailFaxSources.map(renderMailFaxSource)}</ul>
          </div>
        )}

        {/* Advanced disclosure — manual portal entry, saved logins & sessions. */}
        {!isLoading && !isError && (
          <details className="rounded-xl border border-dashed border-current-line px-4 py-1 [&_summary]:list-none">
            <summary className="money cursor-pointer py-3 text-[12.5px] tracking-[0.06em] text-current-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber focus-visible:ring-offset-2">
              Advanced — add a portal manually, saved logins &amp; sessions
            </summary>
            <p className="pb-3 text-sm text-current-ink/70">
              For power users: add a portal by hand, manage saved usernames/passwords, capture a browser
              session, or set when Hamilton may sign in. Most people never need this.
            </p>
          </details>
        )}
      </CardContent>
    </Card>
  )
}
