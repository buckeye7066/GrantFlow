import React from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList } from 'recharts'

/**
 * Generic horizontal funnel rendered as a bar chart. Recharts has no
 * stable Funnel chart in the version pinned in this repo, so we use a
 * horizontal bar chart with stage labels and value labels which gives the
 * same visual story without adding a dependency.
 */
export default function AgentFunnelChart({ data = [], height = 220, color = '#2563eb' }) {
  if (!Array.isArray(data) || !data.length) {
    return <div className="rounded border bg-slate-50 p-4 text-sm text-slate-500">No funnel data yet.</div>
  }

  const padded = data.map((d) => ({
    ...d,
    label: d.label || d.stage,
    value: Math.max(0, Number(d.value || 0)),
  }))

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={padded} layout="vertical" margin={{ top: 8, right: 32, left: 16, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
          <XAxis type="number" tick={{ fontSize: 11 }} />
          <YAxis dataKey="label" type="category" tick={{ fontSize: 11 }} width={140} />
          <Tooltip cursor={{ fill: 'rgba(37, 99, 235, 0.08)' }} />
          <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]}>
            <LabelList dataKey="value" position="right" style={{ fontSize: 11, fill: '#0f172a' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
