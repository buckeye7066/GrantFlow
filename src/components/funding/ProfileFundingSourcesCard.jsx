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
import { useQuery } from "@tanstack/react-query"
import { listProfileFundingSources } from "@/api/matching"
import { ExternalLink } from "lucide-react"
import { safeHttpUrl } from "@/lib/safeUrl"

function fmtAmount(min, max) {
  const f = (n) => `$${Number(n).toLocaleString()}`
  if (Number.isFinite(min) && Number.isFinite(max) && (min || max)) return `${f(min)} – ${f(max)}`
  if (Number.isFinite(max) && max) return `up to ${f(max)}`
  if (Number.isFinite(min) && min) return `from ${f(min)}`
  return null
}

function SourceRow({ s }) {
  const amount = fmtAmount(s.amount_min, s.amount_max)
  const href = safeHttpUrl(s.url)
  const RowTag = href ? "a" : "div"
  return (
    <li className="rounded-lg border border-slate-200 transition hover:border-blue-200 hover:bg-blue-50/40">
      <RowTag
        {...(href ? { href, target: "_blank", rel: "noopener noreferrer" } : {})}
        className="flex items-start justify-between gap-3 p-3 text-left"
        title={href ? `Open ${s.title}` : "No usable URL saved for this source yet"}
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
            Open <ExternalLink className="h-3 w-3" />
          </span>
        ) : (
          <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-slate-500">No URL</span>
        )}
      </div>
      </RowTag>
    </li>
  )
}

function Group({ title, hint, items }) {
  if (!items?.length) return null
  return (
    <section className="mt-4">
      <h4 className="text-sm font-semibold text-slate-800">
        {title} <span className="font-normal text-slate-400">({items.length})</span>
      </h4>
      {hint ? <p className="mb-2 text-xs text-slate-500">{hint}</p> : null}
      <ul className="space-y-2">
        {items.map((s) => <SourceRow key={s.id} s={s} />)}
      </ul>
    </section>
  )
}

export default function ProfileFundingSourcesCard({ profileId }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["profile-funding-sources", profileId],
    queryFn: () => listProfileFundingSources(profileId),
    enabled: Boolean(profileId),
  })

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
          <Group title="Best matches" hint="Apply-now opportunities that fit this profile." items={data.best_matches} />
          <Group title="Worth reviewing" hint="Plausible fits to confirm before applying." items={data.worth_reviewing} />
          <Group title="Directories to search" hint="Places to look — not a single apply-now grant." items={data.directories} />
          {data.geo_stubs_hidden ? (
            <p className="mt-3 text-[11px] text-slate-400">{data.geo_stubs_hidden} low-quality “near you” stub(s) hidden.</p>
          ) : null}
        </>
      )}
    </div>
  )
}
