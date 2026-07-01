import React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Sparkles, Loader2, RefreshCw, CheckCircle2, AlertTriangle,
  KeyRound, LogIn, FileText, ArrowRight, Clock,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { StatusDot } from '@/components/ui/StatusDot'
import { getHamiltonProfileSummary, statusLabel } from '@/api/hamilton'

/**
 * HamiltonWorkPanel
 *
 * A single profile-page button + dialog answering two owner questions:
 *   1. "What is Hamilton working on for this profile?"  → working_on
 *   2. "Where do I need to add information so she can finish?" → needs_you
 *
 * Data comes from GET /api/hamilton/automation/profile-summary (read-only,
 * profile-access scoped). Each "needs you" item carries a `where` hint; the
 * parent supplies onNavigate(where, item) to jump to the right tab/card so the
 * panel is actionable, never a dead end.
 *
 * The trigger button shows a live count badge of outstanding "needs you" items.
 */

// Where a needs-you item should send the owner, mapped to a friendly action.
const WHERE_LABEL = {
  pipeline: 'Open Portals',
  documents: 'Open Documents',
  profile: 'Open Profile',
  'action-plan': 'Open Action Plan',
}

function needIcon(kind) {
  switch (kind) {
    case 'portal_session': return LogIn
    case 'vault': return KeyRound
    case 'missing_document':
    case 'missing_field': return FileText
    case 'task_blocked': return AlertTriangle
    default: return AlertTriangle
  }
}

export default function HamiltonWorkPanel({ profileId, onNavigate }) {
  const [open, setOpen] = React.useState(false)

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['hamilton-profile-summary', profileId],
    queryFn: () => getHamiltonProfileSummary(profileId),
    enabled: !!profileId,
    // Keep the badge fresh, but don't hammer the API: poll slowly, faster while open.
    refetchInterval: open ? 15000 : 60000,
    staleTime: 10000,
  })

  const workingOn = Array.isArray(data?.working_on) ? data.working_on : []
  const needsYou = Array.isArray(data?.needs_you) ? data.needs_you : []
  const needsCount = needsYou.length

  if (!profileId) return null

  const handleNavigate = (item) => {
    setOpen(false)
    if (typeof onNavigate === 'function') onNavigate(item.where, item)
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} title="See what Hamilton is doing and what she needs from you">
        <Sparkles className="mr-2 h-4 w-4 text-emerald-600" />
        Hamilton
        {needsCount > 0 && (
          <span className="ml-2 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold text-white">
            {needsCount}
          </span>
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto overflow-x-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-emerald-600" />
              Hamilton on this profile
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto"
                onClick={() => refetch()}
                title="Refresh"
              >
                {isFetching ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </DialogTitle>
            <DialogDescription>
              What Hamilton is working on, and anywhere she needs you to add information to finish.
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Checking with Hamilton…
            </div>
          ) : (
            <div className="space-y-6">
              {/* What Hamilton needs from you — most actionable, shown first. */}
              <section className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <AlertTriangle className="h-4 w-4 text-rose-500" />
                  Needs your input
                  <Badge variant="outline" className="border-slate-200 text-[10px] text-slate-600">{needsCount}</Badge>
                </h3>
                {needsCount === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700">
                    <CheckCircle2 className="h-4 w-4" />
                    Nothing needed from you right now — Hamilton has everything she needs.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {needsYou.map((item) => {
                      const Icon = needIcon(item.kind)
                      const actionLabel = WHERE_LABEL[item.where] || 'Open'
                      // The WHOLE row is the button: clicking (or Enter/Space on)
                      // anywhere navigates to where the owner fixes it. This is the
                      // durable fix for the report that these items "should be
                      // clickable" — it no longer matters if the trailing action
                      // button gets clipped; the row itself always navigates.
                      return (
                        <li
                          key={item.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => handleNavigate(item)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              handleNavigate(item)
                            }
                          }}
                          className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-rose-300 hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                        >
                          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-slate-900 break-words">
                              {item.title}
                              {item.required && (
                                <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-600">required</span>
                              )}
                            </div>
                            {item.detail && <p className="mt-0.5 text-xs text-slate-500 break-words">{item.detail}</p>}
                          </div>
                          <span
                            aria-hidden="true"
                            className="inline-flex shrink-0 items-center gap-1 self-center rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600"
                          >
                            {actionLabel}
                            <ArrowRight className="h-3.5 w-3.5" />
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>

              {/* What Hamilton is working on right now. */}
              <section className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Sparkles className="h-4 w-4 text-emerald-600" />
                  Working on now
                  <Badge variant="outline" className="border-slate-200 text-[10px] text-slate-600">{workingOn.length}</Badge>
                </h3>
                {workingOn.length === 0 ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-500">
                    Hamilton has no active work on this profile. Select funding sources in the Pipeline and start automation to put her to work.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {workingOn.map((t) => (
                      <li
                        key={t.id}
                        className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5"
                      >
                        <StatusDot tone="ready" className="mt-1 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-slate-900">{t.title}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                            <span>{statusLabel(t.status)}</span>
                            {t.automation_type && t.automation_type !== 'unknown' && (
                              <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700">
                                {String(t.automation_type).replace(/[_-]+/g, ' ')}
                              </Badge>
                            )}
                            {t.current_step && <span>· {t.current_step}</span>}
                          </div>
                          {t.last_message && <p className="mt-0.5 truncate text-xs text-slate-400">{t.last_message}</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {data?.next_run_at && (
                <p className="flex items-center gap-1.5 text-xs text-slate-400">
                  <Clock className="h-3.5 w-3.5" />
                  Next scheduled run: {new Date(data.next_run_at).toLocaleString()}
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
