import React from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Loader2, Eye } from 'lucide-react'
import { formatAmount, formatDeadline } from './fundingLibraryFormatters'

export default function FundingLibraryTable({ items, total, loading, onSelect, onLoadMore, hasMore }) {
  if (loading && (!items || items.length === 0)) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-6 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the funding library…
        </CardContent>
      </Card>
    )
  }

  if (!items || items.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-slate-500">
          No verified opportunities match these filters yet. Try widening the filters or
          checking back after Robert's next discovery cycle.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-slate-500">
          <span>Showing {items.length.toLocaleString()} of {total.toLocaleString()}</span>
          <span>Verified opportunities only by default</span>
        </div>

        <div className="divide-y dark:divide-slate-800">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect?.(item)}
              className="block w-full px-3 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-900/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{item.title || 'Untitled opportunity'}</span>
                    {item.is_national ? (
                      <Badge variant="outline" className="text-[10px]">National</Badge>
                    ) : item.state ? (
                      <Badge variant="outline" className="text-[10px]">{item.state}</Badge>
                    ) : null}
                    {item.opportunity_kind ? (
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {item.opportunity_kind}
                      </Badge>
                    ) : null}
                    {item.source_trust_tier ? (
                      <Badge variant="secondary" className="text-[10px]">{item.source_trust_tier}</Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 truncate text-xs text-slate-500">
                    {item.sponsor || item.source || '—'}
                  </div>
                  {item.description ? (
                    <p className="mt-1 line-clamp-2 text-xs text-slate-600 dark:text-slate-400">
                      {item.description}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col items-end gap-1 text-xs">
                  <span className="font-mono">{formatAmount(item.amount_min, item.amount_max, item.amount_description)}</span>
                  <span className="text-slate-500">Deadline: {formatDeadline(item.deadline, item.deadline_type)}</span>
                  <Eye className="mt-1 h-3.5 w-3.5 text-slate-400" />
                </div>
              </div>
            </button>
          ))}
        </div>

        {hasMore ? (
          <div className="border-t p-3 text-center">
            <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loading}>
              {loading ? (
                <span className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</span>
              ) : (
                'Load more'
              )}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
