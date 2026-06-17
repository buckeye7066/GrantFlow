import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sparkles, Loader2, X } from 'lucide-react'
import { useYanaSelection } from './YanaSelectionContext'
import client from '@/api/client'
import { useToast } from '@/components/ui/use-toast'

/**
 * YanaSelectionToolbar
 *
 * Floating action bar that appears when the user has selected one or
 * more pipeline cards for "Automate with Yana". Calls
 * /api/yana/automation/start with the selected sources and the
 * caller-supplied profileId.
 *
 * Props:
 *   - profileId   the active profile ID (required to dispatch). If
 *                 missing, the toolbar shows a clear inline message
 *                 instead of the action button.
 *   - onComplete  optional callback invoked with the API response
 */
export default function YanaSelectionToolbar({ profileId, onComplete }) {
  const { enabled, selected, clear, getSelectedSources } = useYanaSelection()
  const [submitting, setSubmitting] = useState(false)
  const [lastResult, setLastResult] = useState(null)
  const { toast } = useToast()
  // The result is stored only so we can show a "some failed" badge in this
  // toolbar render. We intentionally don't surface the full diagnostic
  // payload here — that lives in YanaTaskDrawer per-task.

  if (!enabled) return null
  const count = selected?.size || 0
  if (count === 0) return null

  async function automate() {
    if (!profileId) {
      toast({
        variant: 'destructive',
        title: 'Yana needs a profile',
        description: 'Open the pipeline from a specific profile so Yana knows whose application to fill.',
      })
      return
    }
    setSubmitting(true)
    try {
      const sources = getSelectedSources()
      const res = await client.post('/api/yana/automation/start', {
        profile_id: profileId,
        selected_sources: sources,
      })
      setLastResult(res || null)
      const ok = res?.ok !== false
      const total = res?.results?.length || 0
      const failed = (res?.results || []).filter((r) => r.ok === false).length
      toast({
        variant: failed > 0 ? 'destructive' : 'default',
        title: ok ? `Yana started ${total} task(s)` : 'Yana could not start',
        description: failed > 0
          ? `${failed} of ${total} sources failed; check the Yana queue for details.`
          : 'Yana is classifying and drafting your applications. Open each card to see status.',
      })
      onComplete?.(res || null)
      if (ok && failed === 0) clear()
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Yana automation failed',
        description: err?.message || 'Unknown error',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-3xl w-full px-4 pointer-events-none">
      <div className="pointer-events-auto bg-white border border-indigo-200 shadow-2xl rounded-xl px-4 py-3 flex items-center gap-3">
        <Sparkles className="w-5 h-5 text-indigo-600" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-900">
            {count} selected · ready for Yana
          </div>
          <div className="text-xs text-slate-500 truncate">
            Yana will classify each source (portal, PDF/DOCX, mail, fax, email, FAFSA-driven, or directory) and drive each to the right next step.
          </div>
          {lastResult?.results?.some((r) => r.ok === false) ? (
            <Badge variant="destructive" className="mt-1">Some sources failed — check queue</Badge>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={clear} disabled={submitting} title="Clear selection">
          <X className="w-4 h-4" />
        </Button>
        <Button onClick={automate} disabled={submitting || !profileId} className="bg-indigo-600 hover:bg-indigo-700 text-white">
          {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
          Automate selected with Yana
        </Button>
      </div>
    </div>
  )
}
