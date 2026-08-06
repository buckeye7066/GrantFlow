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
  saveApplicationPacket,
  saveApplicationPackets,
  packetDownloadUrl,
  setPortalAutopilotPassphrase,
  unlockPortalAutopilot,
  lockPortalAutopilot,
  setPortalAutopilotIdentity,
  setPortalMergeStatus,
} from "@/api/hamilton"
import { deleteGrant } from "@/api/grants"
import { openApplicationPacket } from "@/components/hamilton/applicationPacketPrint"
import { openWithHamiltonWatching } from "@/components/hamilton/hamiltonWatchedOpen"
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
  ShieldCheck,
  Lock,
  Unlock,
  KeyRound,
  UserCheck,
  PanelsTopLeft,
  Trash2,
} from "lucide-react"

// Plain, human-readable label per autopilot state for the dashboard. Co-browse /
// can't-auto-merge states route to the LAST-RESORT side-by-side login. Keep these
// in lockstep with AUTOPILOT_STATE in hamiltonPortalAutopilotIdentity.js.
const AUTOPILOT_LABELS = {
  auto_provisioned: {
    text: "Saved login available",
    Icon: ShieldCheck,
    tone: "ok",
  },
  has_existing_credentials: {
    text: "You already have an account",
    Icon: CheckCircle2,
    tone: "ok",
  },
  identity_proof_required: {
    text: "Needs your ID verification in the official portal",
    Icon: UserCheck,
    tone: "warn",
  },
  needs_user: {
    text: "Manual portal login required",
    Icon: PanelsTopLeft,
    tone: "warn",
  },
  vault_locked: {
    text: "Vault locked — unlock to reuse a saved login",
    Icon: Lock,
    tone: "warn",
  },
  automation_disabled: {
    text: "Preparation automation off",
    Icon: AlertTriangle,
    tone: "muted",
  },
}

// Resolve the autopilot label for a tile. A tile flagged cantAutoMerge always
// reads as the plain "can't auto-merge — open side-by-side login" message so an
// unmergeable portal is never left ambiguous (owner requirement).
function autopilotLabelFor(portal) {
  if (portal?.cantAutoMerge && portal?.autopilotState !== "identity_proof_required") {
    return AUTOPILOT_LABELS.needs_user
  }
  return AUTOPILOT_LABELS[portal?.autopilotState] || null
}

function autopilotToneClass(tone) {
  if (tone === "ok") return "border-[#bfe0cd] bg-current-emeraldSoft text-[#0d5536]"
  if (tone === "warn") return "border-[#f1cabd] bg-current-coralSoft text-[#9a3320]"
  return "border-current-line bg-transparent text-current-ink/70"
}

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

// Compact date for the global "Synced • <date>" badge (no time-of-day noise).
function formatWhenShort(iso) {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
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

// Stable identifier for a mail/fax source row (independent of object identity).
function sourceKeyOf(src) {
  if (!src || typeof src !== "object") return ""
  return src.grantId || src.opportunityId || `${src.host || ""}-${src.title || ""}`
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

// Strict host match for the ?cobrowse deep-link: equal, or a true subdomain on a
// dot boundary (so "mtsu.edu.evil.com" never matches "mtsu.edu"). Used to gate a
// user-controlled URL param against the profile's real portals.
function hostMatches(a, b) {
  const norm = (v) => String(v || "").toLowerCase().trim().replace(/^https?:\/\//, "").split("/")[0]
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)
}

// Prepend https:// when the owner pastes a bare host ("mtsu.edu") so both the URL
// parser below and the secure-login window get a well-formed address.
function normalizeUrl(raw) {
  const v = String(raw || "").trim()
  if (!v) return ""
  return /^https?:\/\//i.test(v) ? v : `https://${v}`
}

// Derive a clean host from whatever the owner pasted — a bare host or a full URL.
// Returns "" when it isn't a plausible web address (no dot / unparseable) so the
// caller can prompt for a real one instead of starting a login to nowhere.
function deriveHostFromUrl(raw) {
  const normalized = normalizeUrl(raw)
  if (!normalized) return ""
  try {
    const host = new URL(normalized).hostname.toLowerCase()
    return host.includes(".") ? host : ""
  } catch {
    return ""
  }
}

// Inline "add this school's login" affordance for a tile whose school we know but
// whose portal host we never resolved. The old UI rendered a dead-end note ("add
// it under Advanced") that pointed at a section with no per-school field — a
// literal dead end. Here the owner pastes the school's login page; we derive the
// host and hand a fully-formed portal to the SAME secure-login flow every other
// tile uses (onStart → startLogin), so one paste both names the portal and opens
// the sign-in window. No new endpoint, no separate "add portal" step.
function AddSchoolLoginInline({ schoolLabel, busy, onStart }) {
  const [open, setOpen] = React.useState(false)
  const [url, setUrl] = React.useState("")
  const [error, setError] = React.useState("")

  const submit = () => {
    const host = deriveHostFromUrl(url)
    if (!host) {
      setError("Enter the school's login web address, e.g. mtsu.edu")
      return
    }
    setError("")
    onStart({ portalHost: host, loginUrl: normalizeUrl(url), label: schoolLabel })
  }

  if (!open) {
    return (
      <button
        type="button"
        className={BTN_CORAL}
        onClick={() => setOpen(true)}
        title="Add this school's login page and sign in once through the secure window"
      >
        <Globe className="h-4 w-4" /> Add this school&rsquo;s login
      </button>
    )
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <label className="space-y-1">
        <span className="money text-[11.5px] font-bold uppercase tracking-[0.06em] text-current-ink/60">
          School login web address
        </span>
        <input
          type="url"
          inputMode="url"
          autoFocus
          className="w-full rounded-[10px] border border-current-line bg-transparent px-3 py-2 text-sm text-current-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber"
          placeholder="mtsu.edu or https://portal.mtsu.edu/login"
          value={url}
          onChange={(e) => { setUrl(e.target.value); if (error) setError("") }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit() } }}
        />
      </label>
      {error && <p className="text-[11.5px] font-semibold text-current-coral">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={BTN_CORAL}
          disabled={busy || !url.trim()}
          onClick={submit}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Globe className="h-4 w-4" />}
          Open portal manually &rarr;
        </button>
        <button
          type="button"
          className={BTN_BASE}
          onClick={() => { setOpen(false); setUrl(""); setError("") }}
        >
          Cancel
        </button>
      </div>
      <p className="text-[11.5px] text-current-ink/60">
        Paste the page where you sign in to {schoolLabel || "this school"}. Hamilton opens a secure window so you
        sign in once, then remembers it.
      </p>
    </div>
  )
}

export default function ProfilePortalsCard({ profileId, profileName = "" }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const { data, isLoading, isError } = useQuery({
    queryKey: ["hamilton-profile-portals", profileId],
    queryFn: () => listProfilePortals(profileId),
    enabled: !!profileId,
    staleTime: 120_000,
  })

  const portals = Array.isArray(data?.portals) ? data.portals : []
  // Real funding sources that are NOT login portals — apply by mail/fax/email.
  const mailFaxSources = Array.isArray(data?.mailFaxSources) ? data.mailFaxSources : []
  // Per-profile master-vault / autopilot-identity status.
  const vaultStatus = (data?.vaultStatus && typeof data.vaultStatus === "object")
    ? data.vaultStatus
    : { has_passphrase: false, is_unlocked: false, identity_email: null }
  // Can Hamilton USE the vault right now? `is_unlocked` is only the server's
  // in-process cache — after a backend restart it reads false even when the
  // owner enabled AUTONOMOUS UNLOCK (escrowed key), which the server opens on
  // its own at run time. Gate capabilities on the effective state so a restart
  // doesn't hide saved-login controls behind a phantom lock.
  const vaultUsable = Boolean(vaultStatus.is_unlocked || vaultStatus.autonomous_unlock)

  const refetchPortals = () =>
    queryClient.invalidateQueries({ queryKey: ["hamilton-profile-portals", profileId] })

  // Deep-link from a 2FA / CAPTCHA / identity-proof notification: it lands here
  // with ?cobrowse=<host> and surfaces a clickable "Open side-by-side login" card.
  // SECURITY: the param is USER-CONTROLLED, so we only ever honor it when it
  // resolves to a portal ALREADY on this profile — we never launch a co-browse to
  // an arbitrary host from the URL (open-redirect / phishing guard). An unknown
  // host resolves to null and renders nothing.
  const [cobrowseHost, setCobrowseHost] = React.useState("")
  // Why the co-browse card is showing: a generic 2FA/CAPTCHA/identity step the
  // user clears, or a full-page bot-protection dead-end (Cloudflare/anti-bot)
  // where the site refuses the automated browser and side-by-side is the fix.
  const [cobrowseReason, setCobrowseReason] = React.useState("")
  const cobrowseRef = React.useRef(null)
  React.useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const h = params.get("cobrowse")
      if (h) setCobrowseHost(h)
      const reason = params.get("cobrowse_reason")
      if (reason) setCobrowseReason(reason)
    } catch { /* ignore */ }
  }, [])
  const cobrowseIsBotWall = cobrowseReason === "bot_protected"
  const cobrowsePortal = cobrowseHost
    ? portals.find((p) => hostMatches(p.portalHost || p.host, cobrowseHost)) || null
    : null
  const cobrowseTargetHost = cobrowsePortal ? (cobrowsePortal.portalHost || cobrowsePortal.host || "") : ""
  React.useEffect(() => {
    if (cobrowseTargetHost && cobrowseRef.current) {
      cobrowseRef.current.scrollIntoView({ behavior: "smooth", block: "center" })
    }
  }, [cobrowseTargetHost])

  // Controlled beta opens real portals in the user's browser. The shared helper
  // never calls cloud login for a real origin and states the manual handoff.
  const loginMutation = useMutation({
    mutationFn: (portal) => openWithHamiltonWatching({
      profileId,
      url: portal.loginUrl || (portal.portalHost ? `https://${portal.portalHost}/` : null),
      label: portal.label || portal.portalHost,
      toast,
    }),
    onSettled: () => refetchPortals(),
  })

  const startLogin = (portal) => {
    loginMutation.mutate(portal)
  }

  // Human "I merged this" confirmation — the ONLY manual path to the terminal
  // `merged` state (which ends the weekly unmerged-portals reminder). The
  // backend refuses a merge without explicit confirmation; this button IS that
  // confirmation. Successful two-way syncs mark it automatically server-side.
  const mergeMutation = useMutation({
    mutationFn: (portal) => setPortalMergeStatus(profileId, { portalHost: portal.portalHost, status: "merged" }),
    onSuccess: (res, portal) => {
      refetchPortals()
      showSuccessToast(
        toast,
        "Marked merged",
        `${portal.label || portal.portalHost} is recorded as merged — its data is in this profile and weekly reminders for it stop.`,
      )
    },
    onError: (err) => showErrorToast(toast, "Could not mark merged", err?.message || "Please try again."),
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

  // ── Bulk packets: select mail/fax funders, then Hamilton makes a packet each ──
  // Local selection (keyed by the same stable id the rows use) so we don't need
  // the Pipeline-only HamiltonSelectionProvider here.
  const [selectedMailFax, setSelectedMailFax] = React.useState(() => new Set())
  const allMailFaxKeys = React.useMemo(() => mailFaxSources.map(sourceKeyOf), [mailFaxSources])
  const allMailFaxSelected =
    allMailFaxKeys.length > 0 && allMailFaxKeys.every((k) => selectedMailFax.has(k))
  const toggleMailFax = (src) =>
    setSelectedMailFax((prev) => {
      const next = new Set(prev)
      const k = sourceKeyOf(src)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const toggleSelectAllMailFax = () =>
    setSelectedMailFax(() => (allMailFaxSelected ? new Set() : new Set(allMailFaxKeys)))
  // Drop selections for rows that no longer exist after a refetch.
  React.useEffect(() => {
    setSelectedMailFax((prev) => {
      if (prev.size === 0) return prev
      const valid = new Set(allMailFaxKeys)
      const next = new Set([...prev].filter((k) => valid.has(k)))
      return next.size === prev.size ? prev : next
    })
  }, [allMailFaxKeys])

  const bulkPacketMutation = useMutation({
    mutationFn: (sources) => saveApplicationPackets(profileId, { sources, profileName }),
    onSuccess: (res) => {
      refetchPortals()
      setSelectedMailFax(new Set())
      const created = Number(res?.created || 0)
      const reused = Number(res?.reused || 0)
      const failed = Number(res?.failed || 0)
      if (failed > 0) {
        showErrorToast(
          toast,
          `Made ${created} packet${created === 1 ? "" : "s"}, ${failed} failed`,
          "Saved packets are in this profile's Documents; retry the ones that failed.",
        )
      } else {
        showSuccessToast(
          toast,
          `Made ${created + reused} packet${created + reused === 1 ? "" : "s"}`,
          reused > 0
            ? `${created} new, ${reused} already saved. Find them in this profile's Documents.`
            : "Saved to this profile's Documents as PDFs.",
        )
      }
    },
    onError: (err) => showErrorToast(toast, "Could not make packets", err?.message || "Please try again."),
  })

  const makeSelectedPackets = () => {
    const sources = mailFaxSources.filter((s) => selectedMailFax.has(sourceKeyOf(s)))
    if (sources.length > 0) bulkPacketMutation.mutate(sources)
  }

  // Remove "not interested" funding sources from this profile's pipeline. The
  // backend (DELETE /api/grants/:id) authorizes the ADMIN or the PROFILE OWNER
  // and records a sticky dismissal so the matcher/crawlers don't silently re-add
  // them. Works one-at-a-time (per row) or in bulk (the selection checkboxes).
  const removeMutation = useMutation({
    mutationFn: async (grantIds) => {
      const ids = (Array.isArray(grantIds) ? grantIds : [grantIds]).filter(Boolean)
      const results = await Promise.allSettled(ids.map((id) => deleteGrant(id)))
      const removed = results.filter((r) => r.status === "fulfilled").length
      return { removed, failed: results.length - removed }
    },
    onSuccess: ({ removed, failed }) => {
      refetchPortals()
      setSelectedMailFax(new Set())
      if (failed > 0) {
        showErrorToast(
          toast,
          `Removed ${removed}, ${failed} could not be removed`,
          "Some sources couldn't be removed. Please try again.",
        )
      } else {
        showSuccessToast(
          toast,
          `Removed ${removed} funding source${removed === 1 ? "" : "s"}`,
          "They won't come back unless you add them again.",
        )
      }
    },
    onError: (err) => showErrorToast(toast, "Could not remove", err?.message || "Please try again."),
  })

  const removeOneSource = (src) => {
    if (!src?.grantId) return
    const ok = window.confirm(
      `Remove "${src.title || "this funding source"}" from this profile?\n\nIt won't come back unless you add it again.`,
    )
    if (ok) removeMutation.mutate([src.grantId])
  }

  const removeSelectedSources = () => {
    const ids = mailFaxSources
      .filter((s) => selectedMailFax.has(sourceKeyOf(s)))
      .map((s) => s.grantId)
      .filter(Boolean)
    if (ids.length === 0) return
    const ok = window.confirm(
      `Remove ${ids.length} selected funding source${ids.length === 1 ? "" : "s"} from this profile?\n\nThey won't come back unless you add them again.`,
    )
    if (ok) removeMutation.mutate(ids)
  }

  // ── Portal Autopilot vault controls ───────────────────────────────────────
  // The saved-login master passphrase is a PASSWORD field, consumed on submit and cleared —
  // never stored in component state beyond the moment of submission, never echoed.
  const [passInput, setPassInput] = React.useState("")
  // RECOVERY PATH: once a passphrase is set the vault only offers "unlock". If the
  // owner forgets it (or it can't be verified), they were permanently locked out
  // — a dead-end failure state. `resetMode` flips the password field into
  // "set a NEW passphrase" mode so they can recover. The backend's
  // setMasterPassphrase already UPDATEs the salt+verifier (a true rotation), and
  // previously saved secrets degrade gracefully (reveal returns vault_locked
  // rather than throwing). Account recovery remains a human portal step.
  const [resetMode, setResetMode] = React.useState(false)
  const [identityInput, setIdentityInput] = React.useState(vaultStatus.identity_email || "")
  React.useEffect(() => {
    setIdentityInput(vaultStatus.identity_email || "")
  }, [vaultStatus.identity_email])

  const passphraseMutation = useMutation({
    mutationFn: ({ passphrase, identityEmail }) =>
      setPortalAutopilotPassphrase(profileId, { passphrase, identityEmail }),
    onSuccess: () => {
      setPassInput("")
      setResetMode(false)
      refetchPortals()
      showSuccessToast(toast, "Master passphrase saved", "The saved-login vault is protected. The passphrase is never stored or shown.")
    },
    onError: (err) => showErrorToast(toast, "Could not set the passphrase", err?.message || "Please try again."),
  })

  const unlockMutation = useMutation({
    mutationFn: ({ passphrase }) => unlockPortalAutopilot(profileId, { passphrase }),
    onSuccess: () => {
      setPassInput("")
      refetchPortals()
      showSuccessToast(toast, "Vault unlocked", "Hamilton can use the saved logins for this profile.")
    },
    onError: (err) => showErrorToast(toast, "Unlock failed", err?.message || "Check the passphrase and try again."),
  })

  const lockMutation = useMutation({
    mutationFn: () => lockPortalAutopilot(profileId),
    onSuccess: () => {
      refetchPortals()
      showSuccessToast(toast, "Vault locked", "Hamilton can no longer use the saved logins until you unlock.")
    },
    onError: (err) => showErrorToast(toast, "Could not lock the vault", err?.message || "Please try again."),
  })

  const identityMutation = useMutation({
    mutationFn: ({ identityEmail }) => setPortalAutopilotIdentity(profileId, { identityEmail }),
    onSuccess: (_res, vars) => {
      refetchPortals()
      if (vars?.identityEmail) {
        showSuccessToast(toast, "Portal contact email saved", "New portal accounts and required verification remain your handoff.")
      } else {
        showSuccessToast(toast, "Portal contact email cleared", "Hamilton will not use a saved contact email in portal drafts.")
      }
    },
    onError: (err) => showErrorToast(toast, "Could not save the identity email", err?.message || "Please try again."),
  })

  // ── One button: start Hamilton on EVERYTHING for this profile ──────────────
  // Packets can be prepared in bulk. Portal account creation, login, identity
  // checks, and final submission remain visible human handoffs.
  const startingPackets = bulkPacketMutation.isPending
  const startAllPackets = () => {
    if (mailFaxSources.length === 0) {
      showErrorToast(
        toast,
        "No mail or fax packets to prepare",
        "Use each portal tile for the required login and manual handoff.",
      )
      return
    }
    bulkPacketMutation.mutate(mailFaxSources)
    showSuccessToast(
      toast,
      "Packet preparation started",
      `Making ${mailFaxSources.length} application packet${mailFaxSources.length === 1 ? "" : "s"}. Portal login and submission remain your handoff.`,
    )
  }

  const busyLoginHost = loginMutation.isPending ? loginMutation.variables?.portalHost : null

  const renderTile = (portal) => {
    const ready = portal.status === "ready"
    const host = portal.portalHost
    const sources = Array.isArray(portal.sources) ? portal.sources : []
    const sync = syncTone(portal.lastSync)
    const SyncIcon = sync.Icon
    const isLoggingIn = busyLoginHost === host

    const tileKey = host || portal.label || portal.connectorId || "tile"

    const apLabel = autopilotLabelFor(portal)
    const ApIcon = apLabel?.Icon
    // A portal Hamilton can't auto-merge is plainly labeled and routed to the
    // LAST-RESORT side-by-side co-browse (Hamilton helps the user answer live).
    const offerCobrowse = Boolean(portal.cantAutoMerge && host)

    // Build the served-sources text as a single, robust string (no fragile
    // inline index/comma logic, no empty string nodes).
    const servedText = sources.map((src) => src?.title || "Untitled").join(", ")

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
                {servedText}
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

          <div className="flex shrink-0 flex-wrap items-center gap-1.5 self-start">
            {/* Global "Synced • <date>" tag — rendered for ANY portal whose last
                COMPLETED sync run exists (failed runs never earn it), regardless
                of ready/two-way state, so the owner can see at a glance that
                information moved and when. */}
            {portal.lastSyncedAt && (
              <span
                className="money inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#bfe0cd] bg-current-emeraldSoft px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.06em] text-[#0d5536]"
                title={`Last successful sync ${formatWhen(portal.lastSyncedAt)} (${directionLabel(portal.lastSyncedDirection)})`}
              >
                <CheckCircle2 className="h-3 w-3" /> Synced • {formatWhenShort(portal.lastSyncedAt)}
              </span>
            )}
            {/* Merge lifecycle badge — the backend annotates every tile with its
                real merged/complete state (profile_portal_status); render it so
                the dashboard matches reality instead of silently dropping it. */}
            {portal.isMerged && (
              <span
                className="money inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#bfe0cd] bg-current-emeraldSoft px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.06em] text-[#0d5536]"
                title={portal.mergedAt ? `Merged ${formatWhen(portal.mergedAt)} — data pulled into this profile` : "Merged — data pulled into this profile"}
              >
                <CheckCircle2 className="h-3 w-3" /> Merged
              </span>
            )}
            {!portal.isMerged && portal.isComplete && (
              <span
                className="money inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-current-line bg-transparent px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.06em] text-current-ink/70"
                title="Application complete — results not yet pulled into the profile"
              >
                <ClipboardList className="h-3 w-3" /> Complete
              </span>
            )}
            <span
              className={`money inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.06em] ${
                ready
                  ? "border-[#bfe0cd] bg-current-emeraldSoft text-[#0d5536]"
                  : "border-[#f1cabd] bg-current-coralSoft text-[#9a3320]"
              }`}
            >
              <StatusDot tone={ready ? "ready" : "needs"} size="sm" />
              {ready ? "Ready" : "Needs login"}
            </span>
          </div>
        </div>

        {/* Plain autopilot-state label — what Hamilton can/can't do for this
            login. A can't-auto-merge portal is plainly labeled and points to the
            side-by-side login (the last-resort assist). */}
        {apLabel && (
          <div
            className={`money inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold ${autopilotToneClass(
              apLabel.tone,
            )}`}
            title={portal.autopilotDetail || apLabel.text}
          >
            {ApIcon && <ApIcon className="h-3.5 w-3.5 shrink-0" />}
            {apLabel.text}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {ready ? (
            <>
              {portal.supportsTwoWaySync && (
                <span className="money rounded-full border border-current-line px-2.5 py-1 text-[11.5px] text-current-ink/75 dark:text-slate-300">
                  Controlled beta: update portal data manually
                </span>
              )}
              {/* A portal that's signed in but that Hamilton still can't auto-merge
                  (2FA/CAPTCHA/identity-proof each visit) must offer the live
                  side-by-side co-browse RIGHT HERE — the "Ready" tile's autopilot
                  label promises it, so the button has to exist in this branch too,
                  not only in the "needs login" branch below. Clicking it opens the
                  Hamilton live-login window (startLogin → secure co-browse). */}
              {offerCobrowse && (
                <button
                  type="button"
                  className={BTN_CORAL}
                  disabled={isLoggingIn}
                  onClick={() => startLogin(portal)}
                  title="Open the official portal for manual login and required checks"
                >
                  {isLoggingIn ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <PanelsTopLeft className="h-4 w-4" />}
                  Open portal manually
                </button>
              )}
              <button
                type="button"
                className={BTN_BASE}
                disabled={isLoggingIn}
                onClick={() => startLogin(portal)}
                title="Open the official portal for manual login or review"
              >
                {isLoggingIn ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-4 w-4" />}
                Refresh sign-in
              </button>
              {/* Human merge confirmation ("I merged this"). A successful Pull
                  marks merged automatically; this is the manual path for data
                  the user pulled in themselves. Ends the weekly reminder. */}
              {host && !portal.isMerged && (
                <button
                  type="button"
                  className={BTN_BASE}
                  disabled={mergeMutation.isPending}
                  onClick={() => mergeMutation.mutate(portal)}
                  title="Confirm this portal's data is already in the profile — stops the weekly unmerged-portal reminder"
                >
                  {mergeMutation.isPending && mergeMutation.variables?.portalHost === host
                    ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                    : <CheckCircle2 className="h-4 w-4" />}
                  Mark merged
                </button>
              )}
              {/* Watched open, never a bare tab: re-enter the portal through the
                  same secure co-browse window so Hamilton sees the visit and
                  keeps the captured session fresh. */}
              {!portal.supportsTwoWaySync && portal.loginUrl && (
                <button
                  type="button"
                  className={BTN_BASE}
                  disabled={isLoggingIn}
                  onClick={() => startLogin(portal)}
                  title="Open the official portal for manual work"
                >
                  {isLoggingIn ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ExternalLink className="h-4 w-4" />}
                  Open portal
                </button>
              )}
            </>
          ) : host ? (
            <>
              <button
                type="button"
                className={offerCobrowse ? BTN_CORAL : BTN_BASE}
                disabled={isLoggingIn}
                onClick={() => startLogin(portal)}
                title={offerCobrowse
                  ? "Open the official portal for manual login and required checks"
                  : "Open the official portal"}
              >
                {isLoggingIn ? (
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                ) : offerCobrowse ? (
                  <PanelsTopLeft className="h-4 w-4" />
                ) : (
                  <Globe className="h-4 w-4" />
                )}
                Open portal manually
              </button>
            </>
          ) : portal.loginUrl ? (
            // Process/school tile with a URL but no pre-resolved portal host:
            // openWithHamiltonWatching derives the host from the URL and runs
            // the same watched co-browse (falls back to a direct open only if
            // Hamilton can't start) — never a bare tab Hamilton can't see.
            <button
              type="button"
              className={BTN_BASE}
              onClick={() => openWithHamiltonWatching({ profileId, url: portal.loginUrl, label: portal.label, toast })}
              title="Open the official portal for manual work"
            >
              <ExternalLink className="h-4 w-4" /> Open
            </button>
          ) : (
            // The student's own school with no resolved portal host/URL yet.
            // Instead of a dead-end note, let the owner paste the school's login
            // page right here and start the same secure sign-in every other tile
            // uses. On completion we refetch, so the tile flips to green.
            <AddSchoolLoginInline
              schoolLabel={portal.label || host || "this school"}
              busy={loginMutation.isPending}
              onStart={startLogin}
            />
          )}
        </div>

        {/* What two-way exchange means for this portal. */}
        {ready && portal.supportsTwoWaySync && (
          <p className="money flex items-start gap-1.5 text-[11.5px] text-current-ink/70">
            <ArrowLeftRight className="mt-0.5 h-3 w-3 shrink-0" />
            Controlled beta keeps portal comparison and profile updates manual.
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
    // Compare a STABLE identifier, not object identity, so the spinner shows on
    // the right row even after data is re-derived on refetch.
    const isSaving =
      packetMutation.isPending &&
      packetMutation.variables &&
      sourceKeyOf(packetMutation.variables) === sourceKeyOf(src)
    // Open the printable packet AND save a durable copy to Documents in one click.
    const handlePacket = () => {
      openApplicationPacket({ profileName, source: src })
      packetMutation.mutate(src)
    }
    const selected = selectedMailFax.has(sourceKeyOf(src))
    return (
      <li key={key} className="flex flex-col gap-3 border-b border-current-line py-3 last:border-b-0 sm:flex-row sm:items-center">
        <label className="flex shrink-0 cursor-pointer items-center pt-0.5 sm:pt-0" title="Select for making a packet">
          <input
            type="checkbox"
            className="h-4 w-4 cursor-pointer accent-current-emerald"
            checked={selected}
            onChange={() => toggleMailFax(src)}
            aria-label={`Select ${title} for a packet`}
          />
        </label>
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
          {src.grantId && (
            <button
              type="button"
              className={`${BTN_BASE} text-rose-600 hover:bg-rose-50`}
              disabled={removeMutation.isPending}
              onClick={() => removeOneSource(src)}
              title="Not interested — remove this funding source from the profile"
            >
              <Trash2 className="h-4 w-4" />
              Not interested
            </button>
          )}
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

  // Resolve the vault badge in ONE place so every state (incl. unexpected ones)
  // has a defined, consistent appearance.
  const vaultBadge = (() => {
    if (!vaultStatus.has_passphrase) {
      return {
        cls: "border-[#f1cabd] bg-current-coralSoft text-[#9a3320]",
        node: (<><AlertTriangle className="h-3 w-3" /> No passphrase</>),
      }
    }
    if (vaultStatus.is_unlocked) {
      return {
        cls: "border-[#bfe0cd] bg-current-emeraldSoft text-[#0d5536]",
        node: (<><Unlock className="h-3 w-3" /> Unlocked</>),
      }
    }
    // Autonomous unlock: the runtime cache is locked (e.g. after a restart) but
    // the escrowed key lets Hamilton open the vault on her own — honest AND usable.
    if (vaultStatus.autonomous_unlock) {
      return {
        cls: "border-[#bfe0cd] bg-current-emeraldSoft text-[#0d5536]",
        node: (<><ShieldCheck className="h-3 w-3" /> Auto-unlock on</>),
      }
    }
    return {
      cls: "border-current-line bg-transparent text-current-ink/70",
      node: (<><Lock className="h-3 w-3" /> Locked</>),
    }
  })()

  const trimmedPass = passInput.trim()

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
        {!isLoading && !isError && mailFaxSources.length > 0 && (
          <div className="flex flex-col gap-3 rounded-2xl border border-[#bfe0cd] bg-current-emeraldSoft p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-display text-[15px] font-bold text-current-ink">
                Prepare every mail/fax packet for {profileName || "this profile"}
              </p>
              <p className="mt-0.5 text-[13px] text-current-ink/70">
                Hamilton prepares the packets. Portal accounts, login, required human checks, and final submission remain your handoff.
              </p>
            </div>
            <button
              type="button"
              className={`${BTN_EMERALD} shrink-0`}
              disabled={startingPackets}
              onClick={startAllPackets}
              title="Prepare every mail and fax application packet for this profile"
            >
              {startingPackets ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Printer className="h-4 w-4" />}
              {startingPackets ? "Preparing packets…" : "Prepare all packets"}
            </button>
          </div>
        )}

        {/* Co-browse call-to-action: Hamilton hit a wall only a human can clear
            (2FA approval, CAPTCHA, identity proofing). Deep-linked from the
            notification; one click opens the side-by-side window. */}
        {cobrowsePortal && (
          <div ref={cobrowseRef} className="rounded-2xl border-2 border-current-coral bg-current-coral/10 p-4">
            <div className="flex items-start gap-3">
              <PanelsTopLeft className="h-5 w-5 shrink-0 text-current-coral" />
              <div className="min-w-0 flex-1">
                <p className="font-display font-bold text-current-ink">
                  {cobrowseIsBotWall
                    ? "This site requires your browser"
                    : "Hamilton needs you to finish signing in"}
                </p>
                <p className="mt-1 text-[13px] text-current-ink/75">
                  {cobrowseIsBotWall ? (
                    <>
                      <span className="money">{cobrowsePortal.label || cobrowseTargetHost}</span> blocks automated
                      access with bot protection (a Cloudflare / anti-bot security check). Open the official
                      portal and complete the work in your own browser.
                    </>
                  ) : (
                    <>
                      <span className="money">{cobrowsePortal.label || cobrowseTargetHost}</span> hit a step only you
                      can clear — a 2FA approval, a CAPTCHA, or identity verification. Open the official portal and
                      complete the required work yourself. Final Submit remains yours.
                    </>
                  )}
                </p>
                <button
                  type="button"
                  className={`${BTN_CORAL} mt-3`}
                  disabled={loginMutation.isPending}
                  onClick={() => startLogin(cobrowsePortal)}
                >
                  {loginMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <PanelsTopLeft className="h-4 w-4" />
                  )}
                  Open portal manually
                </button>
              </div>
              <button
                type="button"
                className="text-current-ink/40 hover:text-current-ink"
                onClick={() => setCobrowseHost("")}
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* ── Portal Autopilot (master vault) controls ──────────────────────
            This vault protects saved logins; it never creates portal accounts. */}
        {!isLoading && !isError && (
          <details className="rounded-2xl border border-current-line bg-current-card px-4 py-1 [&_summary]:list-none" open={!vaultStatus.has_passphrase}>
            <summary className="flex cursor-pointer items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber focus-visible:ring-offset-2">
              <span className="inline-flex items-center gap-2 font-display text-[15px] font-bold text-current-ink">
                <KeyRound className="h-4 w-4" /> Saved-login vault
              </span>
              <span
                className={`money inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.06em] ${vaultBadge.cls}`}
              >
                {vaultBadge.node}
              </span>
            </summary>
            <div className="space-y-4 pb-4 pt-1">
              <p className="text-sm text-current-ink/70">
                Protect existing or imported saved logins with one master passphrase. Hamilton can reuse a
                saved login for draft preparation after you establish the account; it does not create new
                portal accounts. The passphrase is never stored or shown.
              </p>

              {/* Optional contact email used while preparing portal drafts. */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex-1 space-y-1">
                  <span className="money text-[11.5px] font-bold uppercase tracking-[0.06em] text-current-ink/60">Portal contact email</span>
                  <input
                    type="email"
                    autoComplete="email"
                    className="w-full rounded-[10px] border border-current-line bg-transparent px-3 py-2 text-sm text-current-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber"
                    placeholder="name@example.com"
                    value={identityInput}
                    onChange={(e) => setIdentityInput(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className={BTN_BASE}
                  disabled={identityMutation.isPending}
                  onClick={() => identityMutation.mutate({ identityEmail: identityInput.trim() || null })}
                >
                  {identityMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <UserCheck className="h-4 w-4" />}
                  {identityInput.trim() ? "Save contact email" : "Clear contact email"}
                </button>
              </div>

              {/* Master passphrase (password field). Set on first use, unlock when a
                  passphrase exists, or RESET it when the owner forgot it (resetMode)
                  so a set vault is never an unlock-only dead end. */}
              {(() => {
                const showSetForm = !vaultStatus.has_passphrase || resetMode
                return (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <label className="flex-1 space-y-1">
                        <span className="money text-[11.5px] font-bold uppercase tracking-[0.06em] text-current-ink/60">
                          Master passphrase {showSetForm
                            ? (vaultStatus.has_passphrase ? "(set a new one — 8+ chars)" : "(set one — 8+ chars)")
                            : "(enter to unlock)"}
                        </span>
                        <input
                          type="password"
                          autoComplete="new-password"
                          className="w-full rounded-[10px] border border-current-line bg-transparent px-3 py-2 text-sm text-current-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber"
                          placeholder="••••••••"
                          value={passInput}
                          onChange={(e) => setPassInput(e.target.value)}
                        />
                      </label>
                      {showSetForm ? (
                        <button
                          type="button"
                          className={BTN_EMERALD}
                          disabled={passphraseMutation.isPending || trimmedPass.length < 8}
                          onClick={() => {
                            const value = passInput
                            setPassInput("")
                            passphraseMutation.mutate({ passphrase: value, identityEmail: identityInput.trim() || undefined })
                          }}
                        >
                          {passphraseMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <KeyRound className="h-4 w-4" />}
                          {vaultStatus.has_passphrase ? "Reset passphrase" : "Set passphrase"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={BTN_EMERALD}
                          disabled={unlockMutation.isPending || !trimmedPass}
                          onClick={() => {
                            const value = passInput
                            setPassInput("")
                            unlockMutation.mutate({ passphrase: value })
                          }}
                        >
                          {unlockMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Unlock className="h-4 w-4" />}
                          Unlock
                        </button>
                      )}
                    </div>
                    {/* Recovery affordance: a set vault must never strand the owner on
                        unlock-only — a forgotten passphrase would otherwise be fatal. */}
                    {vaultStatus.has_passphrase && (
                      <button
                        type="button"
                        className="self-start money text-[11.5px] text-current-ink/55 underline underline-offset-2 hover:text-current-ink/80"
                        onClick={() => { setResetMode((v) => !v); setPassInput("") }}
                      >
                        {resetMode ? "Cancel — I remember it (go back to unlock)" : "Forgot your passphrase? Reset it"}
                      </button>
                    )}
                    {vaultStatus.has_passphrase && resetMode && (
                      <p className="money text-[11px] text-current-amber">
                        Resetting replaces the passphrase. Saved credentials encrypted
                        under the old passphrase may need to be imported again.
                      </p>
                    )}
                  </div>
                )
              })()}

              <div className="flex flex-wrap items-center gap-2">
                {vaultStatus.has_passphrase && vaultUsable && (
                  <button
                    type="button"
                    className={BTN_BASE}
                    disabled={lockMutation.isPending}
                    onClick={() => lockMutation.mutate()}
                  >
                    {lockMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Lock className="h-4 w-4" />}
                    Lock
                  </button>
                )}
              </div>
              <p role="status" className="text-sm text-current-ink/70">
                Create new portal accounts yourself and complete login, verification, signatures, and final Submit.
                Afterward, Hamilton can reuse an authorized saved login to prepare and save drafts.
              </p>
              {vaultStatus.has_passphrase && vaultStatus.identity_email && (
                <p className="money text-[11.5px] text-current-ink/55">
                  Saved portal contact email: <strong className="text-current-ink/75">{vaultStatus.identity_email}</strong>.
                </p>
              )}
            </div>
          </details>
        )}

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
              Select the ones you want and Hamilton makes an individual PDF packet for each, saved to this
              profile&rsquo;s Documents.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-current-ink/80">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-current-emerald"
                  checked={allMailFaxSelected}
                  onChange={toggleSelectAllMailFax}
                  aria-label="Select all funders"
                />
                Select all
              </label>
              {selectedMailFax.size > 0 && (
                <span className="money text-xs text-current-ink/70">{selectedMailFax.size} selected</span>
              )}
              <button
                type="button"
                className={BTN_EMERALD}
                disabled={selectedMailFax.size === 0 || bulkPacketMutation.isPending}
                onClick={makeSelectedPackets}
                title="Hamilton makes an individual PDF packet for each selected funder and saves them to Documents"
              >
                {bulkPacketMutation.isPending
                  ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  : <FileText className="h-4 w-4" />}
                {bulkPacketMutation.isPending
                  ? "Making packets\u2026"
                  : `Make ${selectedMailFax.size || ""} packet${selectedMailFax.size === 1 ? "" : "s"}`.replace("  ", " ")}
              </button>
              {selectedMailFax.size > 0 && (
                <button
                  type="button"
                  className={`${BTN_BASE} text-rose-600 hover:bg-rose-50`}
                  disabled={removeMutation.isPending}
                  onClick={removeSelectedSources}
                  title="Remove the selected funding sources from this profile (admin or profile owner)"
                >
                  {removeMutation.isPending
                    ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                    : <Trash2 className="h-4 w-4" />}
                  Remove {selectedMailFax.size}
                </button>
              )}
            </div>
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
