import React, { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MapPin } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'

/**
 * Robert opportunity map — v1 implementation.
 *
 * The codebase does not ship a map library. Per the dashboard spec, we
 * implement a state-level heatmap + city/lat-lng table as a stable v1
 * that does not require new dependencies. A future enhancement can swap
 * the heatmap section for a real US-states choropleth.
 */
export default function RobertOpportunityMap({ data }) {
  const [selectedState, setSelectedState] = useState(null)
  const installed = data?.installed
  const byState = Array.isArray(data?.by_state) ? data.by_state : []
  const byCity = Array.isArray(data?.by_city) ? data.by_city : []
  const unknown = Number(data?.unknown_count || 0)

  const top = byState.slice(0, 12)
  const totalIngested = byState.reduce((s, x) => s + (x.count || 0), 0) + unknown
  const cityRows = selectedState ? byCity.filter((c) => c.state === selectedState) : byCity.slice(0, 25)

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <MapPin className="h-4 w-4 text-slate-500" />
          Robert opportunity map
        </CardTitle>
        <span className="text-xs text-slate-500">
          {installed ? `${totalIngested.toLocaleString()} ingested` : 'Not installed'}
          {unknown ? ` · ${unknown.toLocaleString()} unknown location` : ''}
        </span>
      </CardHeader>
      <CardContent>
        {!installed ? (
          <div className="rounded border bg-slate-50 p-4 text-sm text-slate-500">
            Robert is not installed yet — once he ingests opportunities they will appear here.
          </div>
        ) : top.length === 0 ? (
          <div className="rounded border bg-slate-50 p-4 text-sm text-slate-500">
            No ingested opportunities in the selected range.
          </div>
        ) : (
          <>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={top} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="state" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar
                    dataKey="count"
                    fill="#2563eb"
                    radius={[4, 4, 0, 0]}
                    cursor="pointer"
                    onClick={(d) => setSelectedState(d?.state || null)}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-500">States:</span>
              {top.map((s) => (
                <button
                  key={s.state}
                  type="button"
                  onClick={() => setSelectedState(selectedState === s.state ? null : s.state)}
                  className={`rounded border px-2 py-0.5 ${
                    selectedState === s.state
                      ? 'border-blue-500 bg-blue-50 text-blue-900'
                      : 'border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40'
                  }`}
                >
                  {s.state} <span className="font-mono">{s.count}</span>
                </button>
              ))}
              {selectedState ? (
                <button
                  type="button"
                  onClick={() => setSelectedState(null)}
                  className="text-blue-600 underline"
                >
                  Clear filter
                </button>
              ) : null}
            </div>

            {selectedState && top.find((s) => s.state === selectedState) ? (
              <div className="mt-3 rounded border bg-slate-50 p-3 text-xs dark:bg-slate-900/40">
                <div className="mb-1 font-semibold">
                  {selectedState} — top categories
                </div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(top.find((s) => s.state === selectedState).categories || {})
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 8)
                    .map(([cat, n]) => (
                      <span key={cat} className="rounded border bg-white px-2 py-0.5 dark:bg-slate-800">
                        {cat} <span className="font-mono">{n}</span>
                      </span>
                    ))}
                </div>
                {(top.find((s) => s.state === selectedState).examples || []).length ? (
                  <ul className="mt-2 space-y-0.5">
                    {top
                      .find((s) => s.state === selectedState)
                      .examples.slice(0, 5)
                      .map((ex) => (
                        <li key={ex.opportunity_id} className="truncate text-slate-700 dark:text-slate-300">
                          • {ex.title}
                        </li>
                      ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {cityRows.length ? (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left text-slate-500">
                      <th className="py-1 pr-2 font-medium">City</th>
                      <th className="py-1 pr-2 font-medium">State</th>
                      <th className="py-1 pr-2 font-medium text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cityRows.slice(0, 30).map((c) => (
                      <tr key={`${c.state}|${c.city}`} className="border-b border-slate-100 dark:border-slate-800">
                        <td className="py-1 pr-2">{c.city || '—'}</td>
                        <td className="py-1 pr-2">{c.state || '—'}</td>
                        <td className="py-1 pr-2 text-right font-mono">{c.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
