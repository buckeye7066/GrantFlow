import React from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createPageUrl } from '@/utils'
import { pickDashboardNextAction } from '@/lib/dashboardNextAction'

/** One decision supplied by Dashboard, also used by its other guidance. */
export default function NextStepHero({ grants = [], today = '', isLoading = false, nextAction, onRetry }) {
  const list = Array.isArray(grants) ? grants.filter((grant) => grant?.id !== null && grant?.id !== undefined) : []
  const action = nextAction ?? pickDashboardNextAction({ isSimplified: true, completionPct: 100, grants: list, activeCount: list.length })
  const next = list.find((grant) => String(grant.id) === String(action?.params?.grant_id))
  const loading = isLoading || action?.key === 'loading'
  const url = action?.href || createPageUrl(action?.route || 'Dashboard', action?.params)
  return (
    <section aria-labelledby="next-step-heading" className="rounded-3xl border border-border bg-card p-6 shadow-sm md:p-8">
      {today ? <p className="mb-3 text-sm text-foreground">{today}</p> : null}
      <h1 id="next-step-heading" className="text-2xl font-bold text-card-foreground md:text-3xl">Your next step</h1>
      <p role={loading ? 'status' : undefined} className="mt-3 text-base leading-relaxed text-foreground">
        {loading ? 'Checking your profile and saved work...' : action?.description}
      </p>
      {next && !loading ? (
        <div className="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-4" data-testid="next-source">
          <p className="font-semibold text-card-foreground">{next.title || 'Funding source'}</p>
          {next.funder || next.sponsor ? <p className="mt-1 text-sm text-foreground">{next.funder || next.sponsor}</p> : null}
        </div>
      ) : null}
      {!loading && action ? (
        <div className="mt-5 flex flex-wrap gap-3">
          {action.key === 'load_error' && onRetry ? (
            <Button size="lg" onClick={onRetry}>{action.label}</Button>
          ) : (
            <Button asChild size="lg" className="h-auto min-h-11 whitespace-normal py-3 text-left">
              <Link to={url}><ArrowRight className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />{action.label}</Link>
            </Button>
          )}
          {list.length > 1 && action.params?.grant_id ? (
            <Button asChild variant="outline" size="lg"><Link to={createPageUrl('Pipeline')}>See all {list.length} sources</Link></Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
