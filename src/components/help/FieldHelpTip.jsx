import React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { HelpCircle, Lock } from 'lucide-react'
import { fetchFieldUsageBundle } from '@/api/fieldUsage'

/**
 * Mission Goal 11 — Field-to-Funding accountability.
 *
 * Renders the canonical "why_we_ask" tooltip for a profile field, sourced
 * from /api/field-usage (which mirrors profileFieldUsageRegistry on the
 * backend). The whole bundle is fetched once per session and cached by
 * React Query, so dropping <FieldHelpTip id="..." /> into any form has
 * effectively zero runtime cost.
 *
 * If the field id is unknown to the registry the tip degrades to a quiet
 * "Why we ask" generic copy — never blank, never throwing — so a missing
 * registration does not break the form.
 *
 * Usage:
 *
 *   <Label htmlFor="uei">UEI <FieldHelpTip id="organization.uei" /></Label>
 *   <Input id="uei" ... />
 */

function useFieldUsageEntry(id) {
  const { data, isLoading } = useQuery({
    queryKey: ['field-usage', 'bundle'],
    queryFn: fetchFieldUsageBundle,
    staleTime: 1000 * 60 * 30, // 30 minutes — registry only changes on deploy
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  })
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const entry = entries.find((e) => e?.id === id) || null
  return { entry, isLoading }
}

export default function FieldHelpTip({ id, children, className }) {
  const { entry, isLoading } = useFieldUsageEntry(id)

  // Build user-facing copy. Pii fields get an extra "stored locally only" note.
  const lines = []
  if (entry?.why_we_ask) {
    lines.push(entry.why_we_ask)
  } else if (!isLoading) {
    lines.push(
      `We use this to find better funding for you. Field "${id}" is not yet documented in the field-usage registry — Anya can explain it on request.`,
    )
  }
  if (entry?.pii) {
    lines.push('Sensitive: kept locally for application readiness; never sent to crawlers or external search.')
  }
  const text = lines.join(' ')

  const trigger = children ?? (
    <span
      className={`inline-flex cursor-help align-middle text-muted-foreground ${className ?? ''}`}
      aria-label={`Why we ask: ${entry?.label ?? id}`}
    >
      {entry?.pii ? (
        <Lock className="h-3.5 w-3.5" />
      ) : (
        <HelpCircle className="h-3.5 w-3.5" />
      )}
    </span>
  )

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-[320px]">
          {text || 'Loading…'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
