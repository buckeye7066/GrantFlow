import React, { useState, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Sparkles, X, Trash2, Loader2 } from 'lucide-react'
import { useHamiltonSelection } from './HamiltonSelectionContext'
import { useToast } from '@/components/ui/use-toast'
import HamiltonAutopilotAuthorization from './HamiltonAutopilotAuthorization'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/**
 * HamiltonSelectionToolbar
 *
 * Floating action bar that appears when the user has selected one or
 * more pipeline cards. From here the user can:
 *   - "Prepare with Hamilton" — opens HamiltonAutopilotAuthorization to
 *     grant scoped draft-preparation rights for the SELECTED sources. Final
 *     portal submission remains a visible human handoff.
 *   - "Delete unselected" — removes every other pipeline card so only the
 *     sources the user picked for Hamilton remain. This is the "click the
 *     ones you want Hamilton to process; delete the rest" workflow.
 *
 * `grants` is the full list of currently-visible pipeline grants and
 * `onDeleteGrants(ids)` performs the deletion (wired to the page's bulk
 * delete mutation). Both are optional — when omitted, the delete action
 * is hidden and the toolbar behaves as before.
 */
export default function HamiltonSelectionToolbar({ profileId, onComplete, grants = [], onDeleteGrants }) {
  const { enabled, selected, clear, getSelectedSources, isSelected } = useHamiltonSelection()
  const [open, setOpen] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const { toast } = useToast()

  // Grants the user did NOT pick for Hamilton — candidates for deletion.
  const unselectedIds = useMemo(() => {
    return (Array.isArray(grants) ? grants : [])
      .filter((g) => g && g.id && !isSelected({
        grant_id: g.id,
        opportunity_id: g.opportunity_id || g.funding_opportunity_id || null,
      }))
      .map((g) => g.id)
  }, [grants, isSelected])

  if (!enabled) return null
  const count = selected?.size || 0
  if (count === 0) return null

  const canDeleteUnselected = typeof onDeleteGrants === 'function' && unselectedIds.length > 0

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

  async function handleDeleteUnselected() {
    if (!canDeleteUnselected) return
    setIsDeleting(true)
    try {
      await onDeleteGrants(unselectedIds)
      toast({
        title: 'Pipeline trimmed',
        description: `Removed ${unselectedIds.length} unselected source${unselectedIds.length === 1 ? '' : 's'}. Your ${count} Hamilton pick${count === 1 ? '' : 's'} remain.`,
      })
      setConfirmDeleteOpen(false)
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Could not remove unselected sources',
        description: err?.message || 'Try again.',
      })
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-3xl w-full px-4 pointer-events-none">
        <div className="pointer-events-auto bg-white border border-indigo-200 shadow-2xl rounded-xl px-4 py-3 flex items-center gap-3">
          <Sparkles className="w-5 h-5 text-indigo-600" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900">
              {count} selected · ready for Hamilton preparation
            </div>
            <div className="text-xs text-slate-500 truncate">
              Hamilton can prepare drafts within this authorization. You handle login, 2FA, attestations, signatures, and final portal submission.
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={clear} title="Clear selection">
            <X className="w-4 h-4" />
          </Button>
          {canDeleteUnselected && (
            <Button
              variant="outline"
              onClick={() => setConfirmDeleteOpen(true)}
              className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
              title="Delete the pipeline cards you did NOT select"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete {unselectedIds.length} unselected
            </Button>
          )}
          <Button onClick={openAuthorize} className="bg-indigo-600 hover:bg-indigo-700 text-white">
            <Sparkles className="w-4 h-4 mr-2" />
            Prepare with Hamilton
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={(o) => { if (!isDeleting) setConfirmDeleteOpen(o) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete unselected sources?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the <strong>{unselectedIds.length}</strong> pipeline
              {unselectedIds.length === 1 ? ' card' : ' cards'} you did not select. Your{' '}
              <strong>{count}</strong> Hamilton pick{count === 1 ? '' : 's'} will stay. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDeleteUnselected() }}
              className="bg-red-600 hover:bg-red-700"
              disabled={isDeleting}
            >
              {isDeleting ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deleting…</>
              ) : (
                `Delete ${unselectedIds.length} unselected`
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
