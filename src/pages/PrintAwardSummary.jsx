import React, { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Printer, X, Loader2, AlertTriangle } from 'lucide-react'
import { apiFetch } from '@/api/client'
import '@/styles/print.css'

/**
 * PrintAwardSummary
 * -----------------
 * A printable / save-as-PDF document of a profile's award amounts and where each
 * came from. Fetches /api/profiles/:id/award-summary and renders awarded vs
 * applied funding with totals. Mounted at /PrintAwardSummary?profile_id=<id>;
 * opened in a new tab so the browser print dialog shows the document (use the
 * dialog's "Save as PDF" to export). Uses the shared print.css.
 */

const fmtMoney = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toLocaleString()}`)

function useQueryParam(name) {
  const { search } = useLocation()
  return new URLSearchParams(search).get(name)
}

function AwardTable({ title, data, accent }) {
  const items = data?.items || []
  return (
    <section className="avoid-break mb-6">
      <div className="flex items-baseline justify-between border-b-2 border-slate-800 pb-1">
        <h2 className="text-lg font-bold text-slate-900">{title}</h2>
        <span className={`text-lg font-bold ${accent}`}>{fmtMoney(data?.total)} <span className="text-sm font-normal text-slate-500">({data?.count || 0})</span></span>
      </div>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">None recorded.</p>
      ) : (
        <table className="mt-2 w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-1 pr-2">Award / scholarship</th>
              <th className="py-1 pr-2">From</th>
              <th className="py-1 pr-2">Status</th>
              <th className="py-1 pr-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className="border-t border-slate-200 align-top">
                <td className="py-1.5 pr-2 font-medium text-slate-900">
                  {it.name}
                  {it.source ? <div className="text-xs font-normal text-slate-400 break-all">{it.source}</div> : null}
                </td>
                <td className="py-1.5 pr-2 text-slate-700">{it.from || '—'}</td>
                <td className="py-1.5 pr-2 capitalize text-slate-600">{it.status}</td>
                <td className="py-1.5 pr-2 text-right font-semibold text-slate-900">{fmtMoney(it.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export default function PrintAwardSummary() {
  const profileId = useQueryParam('profile_id')
  const [state, setState] = useState({ loading: true, error: null, data: null })

  useEffect(() => {
    let cancelled = false
    if (!profileId) { setState({ loading: false, error: 'No profile specified.', data: null }); return undefined }
    apiFetch(`/api/profiles/${profileId}/award-summary`)
      .then((d) => { if (!cancelled) setState({ loading: false, error: null, data: d }) })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: e?.message || 'Failed to load.', data: null }) })
    return () => { cancelled = true }
  }, [profileId])

  const { loading, error, data } = state
  const summary = data?.summary

  return (
    <div className="mx-auto max-w-3xl bg-white p-6 text-slate-900 md:p-10">
      {/* Toolbar — hidden when printing */}
      <div className="no-print mb-6 flex items-center justify-between">
        <Button onClick={() => window.print()} disabled={loading || !!error}><Printer className="mr-2 h-4 w-4" /> Print / Save as PDF</Button>
        <Button variant="ghost" onClick={() => window.close()}><X className="mr-2 h-4 w-4" /> Close</Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading award summary…</div>
      ) : error ? (
        <div className="flex items-center gap-2 text-amber-700"><AlertTriangle className="h-4 w-4" /> {error}</div>
      ) : (
        <>
          <header className="avoid-break mb-6">
            <h1 className="text-2xl font-bold">Award Summary</h1>
            <p className="text-slate-600">{data.profile?.name}{data.committed_college ? ` · ${data.committed_college}` : ''}</p>
            <p className="text-xs text-slate-400">Generated {new Date(data.generated_at).toLocaleString()}</p>
          </header>

          <div className="avoid-break mb-6 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-md border border-slate-200 p-3">
              <div className="text-xs uppercase text-slate-500">Awarded</div>
              <div className="text-xl font-bold text-emerald-700">{fmtMoney(summary?.awarded?.total)}</div>
            </div>
            <div className="rounded-md border border-slate-200 p-3">
              <div className="text-xs uppercase text-slate-500">Applied (pending)</div>
              <div className="text-xl font-bold text-amber-700">{fmtMoney(summary?.applied?.total)}</div>
            </div>
            <div className="rounded-md border border-slate-200 p-3">
              <div className="text-xs uppercase text-slate-500">Total in play</div>
              <div className="text-xl font-bold text-slate-900">{fmtMoney(summary?.total_in_play)}</div>
            </div>
          </div>

          <AwardTable title="Awarded" data={summary?.awarded} accent="text-emerald-700" />
          <AwardTable title="Applied / pending" data={summary?.applied} accent="text-amber-700" />

          <p className="mt-8 text-xs text-slate-400">
            Amounts are drawn from this profile’s committed-college financial-aid pipeline and tracked grants in GrantFlow.
          </p>
        </>
      )}
    </div>
  )
}
