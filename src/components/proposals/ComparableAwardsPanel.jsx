import React from 'react'
import client from '@/api/client'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Award, ExternalLink, X, Loader2, Info } from 'lucide-react'

/**
 * ComparableAwardsPanel — REAL comparable funded awards (NIH RePORTER) for a
 * selected proposal, clearly labeled as grounding references only.
 *
 * Honesty contract (G0): every row shown here is a real historical award to
 * ANOTHER applicant, fetched live from the backend. Zero results renders an
 * honest empty state — never placeholder rows. When the backend flag
 * (COMPARABLE_AWARDS) is off, the panel explains that instead of pretending.
 */
export default function ComparableAwardsPanel({ grantId, grantTitle, onClose }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['comparable-awards', grantId],
    queryFn: () => client.get(`/api/ai/comparable-awards?grant_id=${encodeURIComponent(grantId)}`),
    enabled: Boolean(grantId),
    staleTime: 10 * 60 * 1000,
  })

  const awards = Array.isArray(data?.data) ? data.data : []

  return (
    <Card className="shadow-lg border-0 h-fit">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Award className="w-5 h-5 text-amber-600 shrink-0" />
            <CardTitle className="text-base leading-snug">
              {data?.label || 'Comparable funded awards (reference only)'}
            </CardTitle>
          </div>
          {onClose && (
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} aria-label="Close comparable awards">
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
        {grantTitle && (
          <CardDescription className="line-clamp-2">For: {grantTitle}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start gap-2 text-xs text-slate-500 bg-amber-50 border border-amber-100 rounded-md p-2">
          <Info className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
          <span>
            These are real awards previously made to <strong>other applicants</strong> (NIH RePORTER).
            Use them to gauge scope, framing, and award size — never as facts about your own application.
          </span>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Looking up real funded awards…
          </div>
        )}

        {error && !isLoading && (
          <p className="text-sm text-red-600">
            Comparable awards lookup failed{error?.message ? `: ${error.message}` : ''}. Try again later.
          </p>
        )}

        {!isLoading && !error && data?.enabled === false && (
          <p className="text-sm text-slate-500">
            Comparable-awards lookups are not enabled on this server yet (owner setting COMPARABLE_AWARDS).
          </p>
        )}

        {!isLoading && !error && data?.enabled !== false && awards.length === 0 && (
          <p className="text-sm text-slate-500">
            No comparable funded awards were found for this opportunity's keywords
            {data?.lookup_error ? ` (lookup issue: ${data.lookup_error})` : ''}. Nothing is shown rather than showing made-up examples.
          </p>
        )}

        {awards.map((award, idx) => (
          <div key={`${award.detail_url || award.title}-${idx}`} className="border border-slate-200 rounded-lg p-3 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium text-slate-900 leading-snug">{award.title}</p>
              <Badge variant="secondary" className="text-[10px] shrink-0">Reference</Badge>
            </div>
            {award.recipient && (
              <p className="text-xs text-slate-600">
                Recipient: {award.recipient}
                {award.recipient_state ? ` (${award.recipient_state})` : ''}
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-slate-600">
                {typeof award.amount === 'number' ? `$${award.amount.toLocaleString()}` : 'Amount not reported'}
                {award.agency ? ` · ${award.agency}` : ''}
              </span>
              {award.detail_url && (
                <a
                  href={award.detail_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
                >
                  Details <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
