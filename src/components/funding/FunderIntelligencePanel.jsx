import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { getFunderIntelligence } from '@/api/foundations'

function money(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value))
}

function dateTime(value) {
  if (!value) return 'Unknown'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : String(value)
}

export default function FunderIntelligencePanel({ ein }) {
  const normalizedEin = String(ein ?? '').replace(/\D/g, '')
  const query = useQuery({
    queryKey: ['funder-intelligence', normalizedEin],
    queryFn: () => getFunderIntelligence(normalizedEin),
    enabled: /^\d{9}$/.test(normalizedEin),
    staleTime: 300_000,
  })
  const envelope = query.data?.data ?? query.data ?? {}
  const intelligence = envelope.intelligence ?? null

  if (!/^\d{9}$/.test(normalizedEin)) return null
  if (query.isLoading) return <p className="text-sm text-slate-500">Loading filed grant history…</p>
  if (query.error) {
    return <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Filed grant history is temporarily unavailable.</p>
  }
  if (!intelligence || intelligence.data_state !== 'available') {
    const message = intelligence?.data_state === 'no_itemized_grants'
      ? 'The retrieved filing did not contain an itemized grant list.'
      : intelligence?.data_state === 'no_matches'
        ? 'No filed transactions match the selected filters.'
        : 'Itemized grant transactions have not been ingested for this funder yet.'
    return (
      <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <h4 className="font-semibold text-sm text-slate-800">Filed grant intelligence</h4>
        <p className="mt-1 text-sm text-slate-600">{message}</p>
      </section>
    )
  }

  const summary = intelligence.summary ?? {}
  const patterns = intelligence.recipient_patterns ?? {}
  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-4" aria-labelledby="funder-intelligence-title">
      <div>
        <h4 id="funder-intelligence-title" className="font-semibold text-slate-800">Filed grant intelligence</h4>
        <p className="mt-1 text-xs text-slate-500">{intelligence.interpretation}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded bg-slate-50 p-3"><p className="text-xs text-slate-500">Transactions</p><p className="font-semibold">{summary.transaction_count}</p></div>
        <div className="rounded bg-slate-50 p-3"><p className="text-xs text-slate-500">Total filed</p><p className="font-semibold">{money(summary.total_amount)}</p></div>
        <div className="rounded bg-slate-50 p-3"><p className="text-xs text-slate-500">Average</p><p className="font-semibold">{money(summary.average_amount)}</p></div>
        <div className="rounded bg-slate-50 p-3"><p className="text-xs text-slate-500">Median</p><p className="font-semibold">{money(summary.median_amount)}</p></div>
      </div>

      {intelligence.amount_trends?.length > 0 && (
        <div>
          <h5 className="mb-2 text-sm font-semibold text-slate-700">Amount trends by filing year</h5>
          <div className="overflow-x-auto rounded border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50"><tr><th className="px-3 py-2 text-left">Year</th><th className="px-3 py-2 text-right">Grants</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Average</th></tr></thead>
              <tbody>{intelligence.amount_trends.map((row) => (
                <tr key={row.tax_year ?? 'unknown'} className="border-t"><td className="px-3 py-2">{row.tax_year ?? 'Unknown'}</td><td className="px-3 py-2 text-right">{row.transaction_count}</td><td className="px-3 py-2 text-right">{money(row.total_amount)}</td><td className="px-3 py-2 text-right">{money(row.average_amount)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h5 className="mb-2 text-sm font-semibold text-slate-700">Top recipients</h5>
          <ul className="space-y-2 text-sm">
            {(patterns.top_recipients ?? []).slice(0, 5).map((row) => (
              <li key={row.recipient_name} className="flex justify-between gap-3"><span className="truncate">{row.recipient_name}</span><span className="whitespace-nowrap font-medium">{money(row.total_amount)}</span></li>
            ))}
          </ul>
        </div>
        <div>
          <h5 className="mb-2 text-sm font-semibold text-slate-700">Recipient geography</h5>
          <ul className="space-y-2 text-sm">
            {(patterns.recipient_states ?? []).slice(0, 8).map((row) => (
              <li key={row.recipient_state} className="flex justify-between gap-3"><span>{row.recipient_state}</span><span>{row.grant_count} grants · {money(row.total_amount)}</span></li>
            ))}
          </ul>
        </div>
      </div>

      {intelligence.transactions?.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">View persisted transactions</summary>
          <div className="mt-2 max-h-72 overflow-auto rounded border border-slate-200">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50"><tr><th className="px-2 py-2 text-left">Recipient</th><th className="px-2 py-2 text-left">Purpose</th><th className="px-2 py-2 text-right">Amount</th></tr></thead>
              <tbody>{intelligence.transactions.map((row) => (
                <tr key={row.id} className="border-t align-top"><td className="px-2 py-2">{row.recipient_name}</td><td className="px-2 py-2 text-slate-600">{row.purpose || 'Not stated'}</td><td className="px-2 py-2 text-right font-medium">{money(row.amount)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}

      {intelligence.filing_provenance?.map((filing) => (
        <p key={filing.source_object_id} className="text-xs text-slate-500">
          Filing {filing.tax_year ?? 'year unknown'} · retrieved {dateTime(filing.retrieved_at)}
          {filing.filing_xml_url && (
            <> · <a className="text-blue-600 underline" href={filing.filing_xml_url} target="_blank" rel="noreferrer">source XML</a></>
          )}
        </p>
      ))}
    </section>
  )
}
