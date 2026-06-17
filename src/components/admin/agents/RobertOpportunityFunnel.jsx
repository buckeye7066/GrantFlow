import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Search } from 'lucide-react'
import AgentFunnelChart from './AgentFunnelChart'

export default function RobertOpportunityFunnel({ data }) {
  const funnel = data?.funnel?.funnel || []
  const installed = data?.summary?.installed
  const rejections = data?.funnel?.rejection_reasons || {}

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Search className="h-4 w-4 text-slate-500" />
          Robert opportunity discovery
          {!installed ? <span className="ml-2 text-xs font-normal text-slate-500">Not installed</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <AgentFunnelChart data={funnel} color="#2563eb" />
        {Object.keys(rejections).length ? (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <div className="col-span-full text-slate-500">Rejected candidates</div>
            {Object.entries(rejections)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, n]) => (
                <div
                  key={reason}
                  className="flex items-center justify-between rounded border bg-slate-50 px-2 py-1 dark:bg-slate-900/40"
                >
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
