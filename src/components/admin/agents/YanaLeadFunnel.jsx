import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Users } from 'lucide-react'
import AgentFunnelChart from './AgentFunnelChart'

export default function YanaLeadFunnel({ data }) {
  const funnel = data?.funnel?.funnel || []
  const summary = data?.summary || null
  const websites = funnel.find((f) => f.stage === 'websites_checked')?.value || 0
  const sentToJohn = funnel.find((f) => f.stage === 'leads_sent_to_john')?.value || 0
  const conversion = websites > 0 ? Math.round((sentToJohn / websites) * 100) : null
  const installed = data?.summary?.installed

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Users className="h-4 w-4 text-slate-500" />
          Yana lead funnel
        </CardTitle>
        <span className="text-xs text-slate-500">
          {installed ? (
            <>
              {websites.toLocaleString()} pages → {sentToJohn.toLocaleString()} sent to John
              {conversion !== null ? ` (${conversion}%)` : ''}
            </>
          ) : (
            'Not installed'
          )}
        </span>
      </CardHeader>
      <CardContent>
        <AgentFunnelChart data={funnel} color="#9333ea" />
        {summary?.primary_metrics?.rejection_reasons &&
        Object.keys(summary.primary_metrics.rejection_reasons).length ? (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <div className="col-span-full text-slate-500">Top rejection reasons</div>
            {Object.entries(summary.primary_metrics.rejection_reasons)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6)
              .map(([reason, n]) => (
                <div key={reason} className="flex items-center justify-between rounded border bg-slate-50 px-2 py-1 dark:bg-slate-900/40">
                  <span className="capitalize">{reason.replace(/_/g, ' ')}</span>
                  <span className="font-mono">{n}</span>
                </div>
              ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
