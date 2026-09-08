import React from 'react'
import { useSavedGrantsStore } from '@/stores/savedGrantsStore'
import { Button } from '@/components/ui/button'

export default function SavedWorkNotice() {
  const { writing, pending, retryPending } = useSavedGrantsStore()
  const saving = Object.keys(writing).length
  const failed = Object.keys(pending).filter((id) => !writing[id]).length
  if (!saving && !failed) return null
  return <div role={failed ? 'alert' : 'status'} className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background p-3 text-sm text-foreground">
    <p>{failed ? 'Some bookmark or note changes have not been saved. Your last saved version is unchanged; retry your changes.' : 'Saving your changes. Keep this page open until saving finishes.'}</p>
    {failed ? <Button variant="outline" disabled={Boolean(saving)} onClick={retryPending}>Retry unsaved changes</Button> : null}
  </div>
}
