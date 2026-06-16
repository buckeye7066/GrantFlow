import React from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ExternalLink, BookmarkPlus, MessageCircle, ListChecks } from 'lucide-react'
import { formatMatchAmount, formatMatchDeadline } from './anyaResultsFormatters'

function scoreLabel(score) {
  const n = Number(score || 0)
  if (n >= 0.85) return { label: 'Excellent fit', tone: 'default' }
  if (n >= 0.7) return { label: 'Strong fit', tone: 'default' }
  if (n >= 0.5) return { label: 'Possible fit', tone: 'secondary' }
  return { label: 'Worth a look', tone: 'outline' }
}

function trustLabel(match) {
  const t = (match?.source_trust_tier || match?.source_trust || '').toLowerCase()
  if (!t) return null
  if (t.includes('verified') || t.includes('high')) return { label: 'Verified source', tone: 'default' }
  if (t.includes('directory')) return { label: 'Directory record', tone: 'secondary' }
  if (t.includes('low') || t.includes('unverified')) return { label: 'Unverified — review', tone: 'outline' }
  return { label: t, tone: 'outline' }
}

/**
 * Single match card surfaced after Anya intake. Shows potential funding
 * (never a guaranteed amount), score, fit reasons, and next-step actions.
 */
export function AnyaFundingMatchCard({ match, onView, onSave, onAddToPipeline, onAsk }) {
  if (!match) return null
  const fit = scoreLabel(match.match_score ?? match.score)
  const trust = trustLabel(match)
  const deadline = formatMatchDeadline(match)
  const reasons = Array.isArray(match.match_reasons) ? match.match_reasons : Array.isArray(match.reasons) ? match.reasons : []

  return (
    <Card data-testid="anya-funding-match-card">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">{match.title || match.name || 'Funding opportunity'}</CardTitle>
          <Badge variant={fit.tone}>{fit.label}</Badge>
        </div>
        <CardDescription>
          {match.sponsor || match.funder || match.source || 'Source pending verification'}
          {match.is_national ? <span className="ml-2 text-xs">· National</span> : null}
          {match.state ? <span className="ml-2 text-xs">· {match.state}</span> : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Potential amount</div>
            <div className="font-medium">{formatMatchAmount(match)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Deadline</div>
            <div className="font-medium">{deadline || 'Rolling / not posted'}</div>
          </div>
        </div>

        {reasons.length > 0 ? (
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Why it matched</div>
            <ul className="mt-1 list-disc pl-4 text-sm">
              {reasons.slice(0, 4).map((r, i) => (
                <li key={i}>{typeof r === 'string' ? r : r.label || r.reason || JSON.stringify(r)}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {match.applicant_type ? <Badge variant="outline">{match.applicant_type}</Badge> : null}
          {trust ? <Badge variant={trust.tone}>{trust.label}</Badge> : null}
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          {onView ? (
            <Button size="sm" variant="default" onClick={() => onView(match)}>
              <ExternalLink className="mr-2 h-4 w-4" />
              View details
            </Button>
          ) : null}
          {onSave ? (
            <Button size="sm" variant="secondary" onClick={() => onSave(match)}>
              <BookmarkPlus className="mr-2 h-4 w-4" />
              Save for later
            </Button>
          ) : null}
          {onAddToPipeline ? (
            <Button size="sm" variant="outline" onClick={() => onAddToPipeline(match)}>
              <ListChecks className="mr-2 h-4 w-4" />
              Add to pipeline
            </Button>
          ) : null}
          {onAsk ? (
            <Button size="sm" variant="ghost" onClick={() => onAsk(match)}>
              <MessageCircle className="mr-2 h-4 w-4" />
              Ask Anya about this
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

export default AnyaFundingMatchCard
