import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Sparkles, X } from 'lucide-react'
import { useHamiltonSelection } from './HamiltonSelectionContext'
import { useToast } from '@/components/ui/use-toast'
import HamiltonAutopilotAuthorization from './HamiltonAutopilotAuthorization'

/**
 * HamiltonSelectionToolbar
 *
 * Floating action bar that appears when the user has selected one or
 * more pipeline cards. Clicking "Automate with Hamilton" opens the
 * HamiltonAutopilotAuthorization modal — that modal is where the user
 * grants Autopilot the rights to complete forms, upload docs, generate
 * narratives, save drafts, and submit unattended.
 *
 * Phase G wording: "Automate with Hamilton", "Run to completion", "Hamilton
 * Autopilot". No "supervised completion" / "manual review required"
 * framing on this surface.
 */
export default function HamiltonSelectionToolbar({ profileId, onComplete }) {
  const { enabled, selected, clear, getSelectedSources } = useHamiltonSelection()
  const [open, setOpen] = useState(false)
  const { toast } = useToast()

  if (!enabled) return null
  const count = selected?.size || 0
  if (count === 0) return null

  function openAuthorize() {
    if (!profileId) {
      toast({
        variant: 'destructive',
        title: 'Hamilton needs a profile',
        description: 'Open the pipeline from a specific profile so Hamilton knows whose application to fill.',
      })
      return
    }
    setOpen(true)
  }

  return (
    <>
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-3xl w-full px-4 pointer-events-none">
        <div className="pointer-events-auto bg-white border border-indigo-200 shadow-2xl rounded-xl px-4 py-3 flex items-center gap-3">
          <Sparkles className="w-5 h-5 text-indigo-600" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900">
              {count} selected · ready for Hamilton Autopilot
            </div>
            <div className="text-xs text-slate-500 truncate">
              Hamilton runs unattended after you authorize her — she stops only on a true hard blocker.
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={clear} title="Clear selection">
            <X className="w-4 h-4" />
          </Button>
          <Button onClick={openAuthorize} className="bg-indigo-600 hover:bg-indigo-700 text-white">
            <Sparkles className="w-4 h-4 mr-2" />
            Automate with Hamilton
          </Button>
        </div>
      </div>
      <HamiltonAutopilotAuthorization
        open={open}
        onOpenChange={setOpen}
        profileId={profileId}
        selectedSources={getSelectedSources()}
        onLaunched={(res) => { onComplete?.(res); clear() }}
      />
    </>
  )
}
