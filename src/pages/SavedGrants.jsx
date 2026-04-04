import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '@/api/client'
import { useSavedGrantsStore } from '@/stores/savedGrantsStore'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Loader2, Star, Trash2 } from 'lucide-react'
import GrantCard from '@/components/pipeline/GrantCard'

export default function SavedGrants() {
  const navigate = useNavigate()
  const { savedIds, removeGrant, sync, synced } = useSavedGrantsStore()

  // Sync with backend on first mount
  React.useEffect(() => {
    if (!synced) sync()
  }, [synced, sync])

  const { data: grants = [], isLoading } = useQuery({
    queryKey: ['savedGrants', savedIds],
    queryFn: async () => {
      if (savedIds.length === 0) return []
      const results = await Promise.allSettled(
        savedIds.map((id) => apiFetch(`/api/grants/${id}`).catch(() => null))
      )
      return results
        .filter((r) => r.status === 'fulfilled' && r.value)
        .map((r) => r.value)
    },
    enabled: savedIds.length > 0,
    staleTime: 30_000,
  })

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

        {savedIds.length === 0 && (
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

        {savedIds.length > 0 && isLoading && (
          <div className="flex min-h-[200px] items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        )}

        {savedIds.length > 0 && !isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {savedIds.map((id) => {
              const grant = grants.find((g) => String(g?.id) === String(id))
              return (
                <div key={id} className="flex flex-col">
                  {grant ? (
                    <>
                      <GrantCard
                        grant={{ ...grant, starred: true }}
                        onStarToggle={() => removeGrant(id)}
                      />
                      <div className="mt-2 flex justify-end">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => removeGrant(id)}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1" />
                          Remove
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Card>
                      <CardContent className="p-4 flex items-center justify-between gap-3">
                        <p className="text-sm text-slate-500 truncate">Grant ID: {id}</p>
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
