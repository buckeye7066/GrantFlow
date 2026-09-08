import React, { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSavedGrantsStore } from '@/stores/savedGrantsStore'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Star, Trash2, StickyNote, Check } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import FundingResultCard from '@/components/funding/FundingResultCard'
import { toCanonicalResult } from '@/components/funding/toCanonicalResult'

function NoteEditor({ grantId }) {
  const { getNote, updateNote, writing } = useSavedGrantsStore()
  const existing = getNote(grantId)
  const [value, setValue] = useState(existing)
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState(false)

  const [saveFailed, setSaveFailed] = useState(false)
  const handleSave = useCallback(async () => {
    setSaved(false)
    setSaveFailed(false)
    const success = await updateNote(grantId, value)
    setSaved(success)
    setSaveFailed(!success)
  }, [grantId, value, updateNote])

  if (!open) {
    return (
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-slate-500 hover:text-blue-600 transition-colors"
        onClick={() => setOpen(true)}
      >
        <StickyNote className="w-3.5 h-3.5" />
        {existing ? 'Edit note' : 'Add note'}
      </button>
    )
  }

  return (
    <div className="mt-2 space-y-1.5">
      <Textarea
        value={value}
        onChange={(e) => { setValue(e.target.value); setSaved(false) }}
        aria-label="Note for this saved opportunity"
        placeholder="Why did you save this? Any reminders..."
        className="text-xs min-h-[60px] resize-none"
        autoFocus
      />
      {saveFailed ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">Your note was not saved. Your text is still here. Try again.</p> : null}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={Boolean(writing[grantId])} onClick={handleSave}>
          {saved ? <Check className="w-3 h-3 mr-1 text-green-600" /> : null}
          {writing[grantId] ? 'Saving...' : saved ? 'Saved' : 'Save note'}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="text-xs h-7" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export default function SavedGrants() {
  const navigate = useNavigate()
  const { savedIds, removeGrant, sync, synced, syncing, syncError, opportunitiesMap } = useSavedGrantsStore()

  const activeProfileId = useAuthStore((state) => state.activeProfileId)
  // Always sync on mount: freshly-starred items (saved earlier this session,
  // before the last sync) still need their full opportunity payload pulled in.
  // sync() is idempotent and merges local + backend saves; `sync` is a stable
  // zustand action reference, so this effect runs once.
  React.useEffect(() => {
    sync()
  }, [sync, activeProfileId])

  const isLoading = syncing || (!synced && !syncError)

  // A saved id is a funding_opportunities id. The synced opportunitiesMap holds
  // the full JOINed row (title/sponsor/amount/deadline/url) for each, so we
  // render straight from it. (Previously this fetched /api/grants/{id} — a
  // different table and id space — so every lookup 404'd and nothing showed.)
  const missingIds = React.useMemo(
    () =>
      synced
        ? savedIds.filter((id) => {
            const opp = opportunitiesMap?.[id]
            return !opp || !(opp.title || opp.program_name || opp.name)
          })
        : [],
    [synced, savedIds, opportunitiesMap],
  )

  const removeAllUnavailable = React.useCallback(() => {
    missingIds.forEach((id) => removeGrant(id))
  }, [missingIds, removeGrant])

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-5xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
            <Star className="w-8 h-8 text-yellow-400 fill-yellow-400" />
            Saved Grants
          </h1>
          <p className="text-muted-foreground mt-2">
            Grants you have starred in Discovery. Click a card to view details.
          </p>
        </header>

        {syncError ? <div role="alert" className="mb-4 rounded-lg border p-4 text-foreground"><p>{syncError}</p><Button className="mt-3" variant="outline" onClick={sync}>Try again</Button></div> : null}
        {synced && !isLoading && savedIds.length === 0 && (
          <Card>
            <CardContent className="p-12 text-center space-y-4">
              <Star className="w-14 h-14 mx-auto text-slate-300" />
              <h3 className="text-xl font-semibold text-slate-700">No saved grants yet</h3>
              <p className="text-slate-500 max-w-md mx-auto">
                Star grants in Discovery to save them here for quick access later.
              </p>
              <Button onClick={() => navigate('/DiscoverGrants')}>Go to Discovery</Button>
            </CardContent>
          </Card>
        )}

        {isLoading && (
          <div role="status" className="flex min-h-[200px] items-center justify-center gap-2">Checking saved opportunities
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        )}

        {savedIds.length > 0 && !isLoading && missingIds.length > 0 && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-3">
            <p className="text-sm text-slate-600">
              {missingIds.length} saved grant{missingIds.length === 1 ? ' is' : 's are'} could not be resolved from the catalog.
            </p>
            <Button type="button" size="sm" variant="outline" onClick={removeAllUnavailable}>
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              Remove {missingIds.length} unavailable
            </Button>
          </div>
        )}

        {savedIds.length > 0 && !isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {savedIds.map((id) => {
              const opp = opportunitiesMap?.[id]
              const grant = opp && (opp.title || opp.program_name || opp.name) ? opp : null
              return (
                <div key={id} className="flex flex-col">
                  {grant ? (
                    <>
                      <FundingResultCard
                        result={toCanonicalResult(grant)}
                        onSecondaryAction={() => removeGrant(id)}
                      />
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <NoteEditor grantId={id} />
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50 shrink-0"
                          onClick={() => removeGrant(id)}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1" />
                          Remove
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Card className="border-dashed">
                      <CardContent className="p-4 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-700">
                            {missingIds.includes(id)
                              ? 'Source details are unavailable'
                              : "Couldn't load this grant"}
                          </p>
                          <p className="text-xs text-slate-400 mt-1">
                            {missingIds.includes(id)
                              ? 'The saved source details could not be found. This does not prove the funder removed the program. Keep your bookmark or remove it deliberately.'
                              : 'A temporary error occurred. It may reappear on refresh.'}
                          </p>
                          <p className="text-[10px] text-slate-300 mt-1 truncate">Ref: {id}</p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50 shrink-0"
                          onClick={() => removeGrant(id)}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1" />
                          Remove
                        </Button>
                      </CardContent>
                    </Card>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
