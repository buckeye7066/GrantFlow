import React from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createPageUrl } from '@/utils'
import { pickNextSource } from '@/lib/nextSource'

/**
 * The end-user home says ONE thing: what to do next, by name.
 *
 * Owner report 2026-09-07 (a senior on an iPad): "It isn't clear for him where
 * to go." The old hero offered seven buttons that all meant "open the
 * pipeline". This names the first funding source and opens it directly.
 */
export default function NextStepHero({ grants = [], today = '', isLoading = false }) {
  const list = Array.isArray(grants) ? grants : []
  const next = pickNextSource(list)
  const count = list.length
  const pipelineUrl = createPageUrl('Pipeline')
  const nextUrl = next ? `${pipelineUrl}?grant_id=${encodeURIComponent(String(next.id))}` : pipelineUrl

  return (
    <div className="relative overflow-hidden rounded-3xl border border-border/70 bg-card/90 p-6 shadow-lg md:p-8">
      <div className="absolute -right-12 -top-12 h-52 w-52 rounded-full bg-gradient-to-br from-primary/20 via-primary/15 to-transparent blur-3xl" />
      <div className="relative max-w-2xl space-y-4">
        {today ? (
          <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
            {today}
          </span>
        ) : null}
        <h1 className="text-2xl font-bold text-card-foreground md:text-3xl">Your next step</h1>

        {isLoading ? (
          <p className="text-sm text-foreground md:text-base">Loading your funding sources.</p>
        ) : next ? (
          <>
            <p className="text-sm text-foreground md:text-base">
              {count === 1
                ? 'GrantFlow found 1 funding source that fits you. Start with it below.'
                : `GrantFlow found ${count} funding sources that fit you. Start with the first one below. GrantFlow fills in what it can from your profile and asks you only for what it needs.`}
            </p>
            <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4" data-testid="next-source">
              <p className="text-xs font-semibold uppercase tracking-wide text-primary">Start here</p>
              <p className="mt-1 text-lg font-semibold text-card-foreground">{next.title || 'Funding source'}</p>
              {next.funder || next.sponsor ? (
                <p className="text-sm text-muted-foreground">{next.funder || next.sponsor}</p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild className="gap-2 shadow-md shadow-blue-200/40" size="lg">
                <Link to={nextUrl}>
                  <ArrowRight className="h-4 w-4" />
                  Start with this source
                </Link>
              </Button>
              {count > 1 ? (
                <Button asChild variant="outline" size="lg">
                  <Link to={pipelineUrl}>See all {count} sources</Link>
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-foreground md:text-base">
              No funding sources are ready yet. GrantFlow keeps looking for you, and Anya can tell you what to do in the meantime.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild className="gap-2" size="lg">
                <Link to={createPageUrl('Help')}>
                  <Sparkles className="h-4 w-4" />
                  Ask Anya what to do next
                </Link>
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
