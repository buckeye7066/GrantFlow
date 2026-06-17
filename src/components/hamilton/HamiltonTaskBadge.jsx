/**
 * HamiltonTaskBadge — compact summary the pipeline GrantCard renders to show
 * the linked portal + Hamilton status + action buttons. Progressive
 * disclosure: this shows only the summary; the full task drawer lives
 * in HamiltonTaskDrawer.
 */

import React, { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sparkles, Loader2, AlertTriangle, CheckCircle2, ExternalLink, Info } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { showErrorToast, showInfoToast } from '@/components/shared/toastHelpers'
import * as hamiltonApi from '@/api/hamilton'

function statusVariantClass(status) {
  switch (status) {
    case 'submitted': return 'bg-emerald-100 text-emerald-800 border-emerald-300'
    case 'draft_completed': return 'bg-blue-100 text-blue-800 border-blue-300'
    case 'ready': return 'bg-blue-50 text-blue-700 border-blue-200'
    case 'in_progress': return 'bg-violet-100 text-violet-800 border-violet-300'
    case 'blocked_login_required':
    case 'blocked_missing_info':
    case 'blocked_2fa':
    case 'blocked_captcha':
    case 'blocked_terms_or_policy':
      return 'bg-amber-100 text-amber-800 border-amber-300'
    case 'failed': return 'bg-red-100 text-red-800 border-red-300'
    case 'cancelled': return 'bg-slate-100 text-slate-700 border-slate-300'
    default: return 'bg-slate-50 text-slate-700 border-slate-200'
  }
}

export default function HamiltonTaskBadge({ profileId, grant, onTaskUpdated, onOpenDrawer }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [task, setTask] = useState(null)
  const [link, setLink] = useState(null)

  // We don't auto-fetch on mount because the pipeline page renders many
  // cards. The badge becomes interactive only when a parent triggers
  // ensureTask via the action button.

  async function ensureAndStart() {
    if (!profileId || !grant?.id) {
      showErrorToast(toast, 'Hamilton cannot start', 'A profile and grant are required.')
      return null
    }
    setLoading(true)
    try {
      const created = await hamiltonApi.createApplicationTask({
        profileId,
        grantId: grant.id,
        opportunityId: grant.funding_opportunity_id || grant.opportunity_id || null,
      })
      const taskRow = created?.task || created
      const result = await hamiltonApi.startHamilton(taskRow.id, { trigger: 'pipeline_card' })
      setTask(result?.task || taskRow)
      if (result?.adapter_result?.message) {
        showInfoToast(toast, 'Hamilton update', result.adapter_result.message)
      } else {
        showInfoToast(toast, 'Hamilton started', `Working on “${grant.title}�.`)
      }
      onTaskUpdated?.(result?.task || taskRow)
      return result?.task || taskRow
    } catch (err) {
      showErrorToast(toast, 'Hamilton could not start', err?.message || 'See logs for details.')
      return null
    } finally {
      setLoading(false)
    }
  }

  const status = task?.status || null
  const portalType = link?.portal_type || null

  return (
    <div className="mt-2 pt-2 border-t border-slate-100 flex flex-wrap items-center gap-2">
      <Badge variant="outline" className="text-xs gap-1 border-purple-200 text-purple-700">
        <Sparkles className="w-3 h-3" />
        Hamilton
      </Badge>
      {portalType && (
        <Badge variant="outline" className="text-xs">
          {hamiltonApi.portalTypeLabel(portalType)}
        </Badge>
      )}
      {status && (
        <Badge variant="outline" className={`text-xs ${statusVariantClass(status)}`}>
          {hamiltonApi.statusLabel(status)}
        </Badge>
      )}
      <div className="flex-1" />
      {task?.id ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-xs h-6 px-2"
            onClick={() => onOpenDrawer?.(task)}
          >
            <Info className="w-3 h-3 mr-1" />
            Review
          </Button>
          {!['submitted', 'cancelled', 'failed'].includes(status) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-xs h-6 px-2"
              disabled={loading}
              onClick={async () => {
                setLoading(true)
                try {
                  const result = await hamiltonApi.continueHamilton(task.id)
                  setTask(result?.task || task)
                  if (result?.adapter_result?.message) {
                    showInfoToast(toast, 'Hamilton update', result.adapter_result.message)
                  }
                  onTaskUpdated?.(result?.task || task)
                } catch (err) {
                  showErrorToast(toast, 'Hamilton could not continue', err?.message || 'See logs.')
                } finally {
                  setLoading(false)
                }
              }}
            >
              {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="w-3 h-3 mr-1" />}
              Continue
            </Button>
          )}
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="text-xs h-6 px-2 border-purple-300 text-purple-700 hover:bg-purple-50"
          disabled={loading}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            ensureAndStart()
          }}
        >
          {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="w-3 h-3 mr-1" />}
          Let Hamilton help
        </Button>
      )}
    </div>
  )
}
