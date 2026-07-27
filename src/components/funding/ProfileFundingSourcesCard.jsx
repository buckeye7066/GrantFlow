/**
 * ProfileFundingSourcesCard
 *
 * The owner-facing, friendly list of funding sources matched to a profile by the
 * Crawler OS. This is the curated per-profile match list (NOT the raw discovery
 * catalog and NOT Hamilton's mail/fax packet list): it reads
 *   GET /api/profiles/:id/funding-sources
 * which serves profile_opportunity_matches joined to the global catalog, with
 * geo-stubs excluded, grouped honestly into:
 *   • Best matches      — apply-now opportunities (decision=accept)
 *   • Worth reviewing   — plausible but unconfirmed fit (decision=review)
 *   • Directories       — places to search (never shown as an apply-now grant)
 *
 * HONESTY: a directory is labeled a directory; match scores + the "why" come
 * straight from the canonical match engine. Empty state tells the owner to run
 * discovery rather than showing stale/fabricated results.
 */
import React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { listProfileFundingSources, dismissProfileFundingSource } from "@/api/matching"
import { ExternalLink, Loader2, X } from "lucide-react"
import { safeHttpUrl } from "@/lib/safeUrl"
import { openWithHamiltonWatching } from "@/components/hamilton/hamiltonWatchedOpen"
import { useToast } from "@/components/ui/use-toast"

function fmtAmount(min, max) {
  const f = (n) => `$${Number(n).toLocaleString()}`
  if (Number.isFinite(min) && Number.isFinite(max) && (min || max)) return `${f(min)} – ${f(max)}`
  if (Number.isFinite(max) && max) return `up to ${f(max)}`
  if (Number.isFinite(min) && min) return `from ${f(min)}`
  return null
}

function SourceRow({ s, profileId, onRemoved }) {
  const { toast } = useToast()
  const [opening, setOpening] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)
  const amount = fmtAmount(s.amount_min, s.amount_max)
  const href = safeHttpUrl(s.url)
  // Opening a source is a WATCHED open: Hamilton's secure co-browse window, so
  // he sees the portal and captures/learns the session for this profile —
  // never a bare tab. The popup opens inside this click gesture (first line of
  // openWithHamiltonWatching), so no awaits may come before the call.
  const openSource = () => {
    if (!href || opening) return
    setOpening(true)
    openWithHamiltonWatching({ profileId, url: href, label: s.title, toast })
      .finally(() => setOpening(false))
  }
  // STICKY remove: records a dismissal tombstone server-side, so discovery /
  // re-crawl can never resurrect this source for this profile.
  const removeSource = () => {
    if (removing) return
    setRemoving(true)
    dismissProfileFundingSource(profileId, s.id)
      .then(() => {
        toast({
          title: "Source removed",
          description: `“${s.title}” won’t be matched to this profile again.`,
        })
        onRemoved?.()
      })
      .catch(() => {
        toast({
          title: "Couldn’t remove source",
          description: "Something went wrong — the source is still listed. Try again.",
          variant: "destructive",
        })
      })
      .finally(() => setRemoving(false))
  }
  const RowTag = href ? "button" : "div"
  return (
    <li className={`flex items-stretch rounded-lg border border-slate-200 transition hover:border-blue-200 hover:bg-blue-50/40 ${removing ? "opacity-50" : ""}`}>
      <RowTag
        {...(href ? { type: "button", onClick: openSource, disabled: opening || removing } : {})}
        className="flex min-w-0 flex-1 items-start justify-between gap-3 p-3 text-left"
        title={href ? `Open ${s.title} with Hamilton watching` : "No usable URL saved for this source yet"}
      >
      <div className="min-w-0">
        <div className="flex items-start gap-2">
          <span className="inline-flex h-6 min-w-[2.25rem] items-center justify-center rounded bg-emerald-50 px-1.5 text-xs font-mono font-semibold text-emerald-700">
            {s.match_score}
          </span>
          <span className="font-medium text-slate-900 hover:underline">
            {s.title}
          </span>
        </div>
        <div className="mt-0.5 break-words text-xs text-slate-500">
          {[s.sponsor, s.geography, amount].filter(Boolean).join(" - ")}
        </div>
        {s.why ? <div className="mt-1 line-clamp-2 text-xs text-slate-600">{s.why}</div> : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2 text-right text-xs">
        {s.is_rolling ? <span className="text-slate-500">Rolling</span> : s.deadline ? <span className="text-slate-500">{s.deadline}</span> : null}
        {href ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-white px-2 py-1 font-medium text-blue-700">
            Open {opening ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" /> : <ExternalLink className="h-3 w-3" />}
          </span>
        ) : (
          <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-slate-500">No URL</span>
        )}
      </div>
      </RowTag>
      <button
        type="button"
        onClick={removeSource}
        disabled={removing}
        aria-label={`Remove ${s.title} from this profile's matches`}
        title="Remove — this source will never be matched to this profile again"
        className="flex shrink-0 items-center self-stretch rounded-r-lg border-l border-slate-100 px-2 text-slate-300 transition hover:bg-red-50 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-300"
      >
        {removing ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <X className="h-4 w-4" />}
      </button>
    </li>
  )
}

function Group({ title, hint, items, profileId, onRemoved }) {
  if (!items?.length) return null
  return (
    <section className="mt-4">
      <h4 className="text-sm font-semibold text-slate-800">
        {title} <span className="font-normal text-slate-400">({items.length})</span>
      </h4>
      {hint ? <p className="mb-2 text-xs text-slate-500">{hint}</p> : null}
      <ul className="space-y-2">
        {items.map((s) => <SourceRow key={s.id} s={s} profileId={profileId} onRemoved={onRemoved} />)}
      </ul>
    </section>
  )
}

export default function ProfileFundingSourcesCard({ profileId }) {
  const queryClient = useQueryClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ["profile-funding-sources", profileId],
    queryFn: () => listProfileFundingSources(profileId),
    enabled: Boolean(profileId),
  })
  const refreshSources = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["profile-funding-sources", profileId] })
  }, [queryClient, profileId])

  return (
    <div id="profile-funding-sources" className="scroll-mt-24 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-slate-900">Funding Sources</h3>
        {data?.total ? <span className="text-xs text-slate-500">{data.total} matched</span> : null}
      </div>
      <p className="mt-0.5 text-xs text-slate-500">
        Matched to this profile by the Crawler OS — best apply-now fits first, then worth-reviewing, then directories to search.
      </p>

      {isLoading ? (
        <p className="mt-4 text-sm text-slate-500">Loading funding sources…</p>
      ) : isError ? (
        <p className="mt-4 text-sm text-slate-500">Funding sources are unavailable right now.</p>
      ) : !data?.total ? (
        <p className="mt-4 text-sm text-slate-500">
          No funding sources matched yet. Run discovery for this profile and they’ll appear here.
        </p>
      ) : (
        <>
          <Group title="Best matches" hint="Apply-now opportunities that fit this profile." items={data.best_matches} profileId={profileId} onRemoved={refreshSources} />
          <Group title="Worth reviewing" hint="Plausible fits to confirm before applying." items={data.worth_reviewing} profileId={profileId} onRemoved={refreshSources} />
          <Group title="Directories to search" hint="Places to look — not a single apply-now grant." items={data.directories} profileId={profileId} onRemoved={refreshSources} />
          {data.geo_stubs_hidden ? (
            <p className="mt-3 text-[11px] text-slate-400">{data.geo_stubs_hidden} low-quality “near you” stub(s) hidden.</p>
          ) : null}
        </>
      )}
    </div>
  )
}
