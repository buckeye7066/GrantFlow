import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, X, RefreshCw, Laptop, FileText, Building2, Coins, UserCog } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/components/ui/use-toast'
import { laptopConnectorApi } from '@/api/laptopConnector'

const TYPE_META = {
  lead: { label: 'Leads (Yana)', icon: Building2, blurb: 'Potential GrantFlow clients found in your files' },
  funding: { label: 'Funding sources (Robert)', icon: Coins, blurb: 'Grant programs / funders to add to Robert' },
  profile_field: { label: 'Profile fields (Anya)', icon: UserCog, blurb: 'Values to fill missing fields on existing profiles' },
}

function Confidence({ value }) {
  const pct = Math.round((Number(value) || 0) * 100)
  const tone = pct >= 75 ? 'text-green-600' : pct >= 50 ? 'text-amber-600' : 'text-muted-foreground'
  return <span className={`text-xs font-medium ${tone}`}>{pct}% confidence</span>
}

export default function AdminLaptopInbox() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [grouped, setGrouped] = useState({ lead: [], funding: [], profile_field: [] })
  const [counts, setCounts] = useState({})
  const [runs, setRuns] = useState([])
  const [selected, setSelected] = useState(() => new Set())
  const [busyIds, setBusyIds] = useState(() => new Set())

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const [review, runsRes] = await Promise.all([
        laptopConnectorApi.listReview(),
        laptopConnectorApi.listRuns().catch(() => ({ runs: [] })),
      ])
      setGrouped(review?.grouped || { lead: [], funding: [], profile_field: [] })
      setCounts(review?.counts || {})
      setRuns(runsRes?.runs || [])
      setSelected(new Set())
    } catch (err) {
      toast({ title: 'Failed to load inbox', description: err.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const allItems = useMemo(
    () => [...(grouped.lead || []), ...(grouped.funding || []), ...(grouped.profile_field || [])],
    [grouped],
  )

  const setBusy = (id, on) =>
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const removeFromView = (id) =>
    setGrouped((prev) => {
      const next = { lead: [], funding: [], profile_field: [] }
      for (const key of Object.keys(next)) next[key] = (prev[key] || []).filter((it) => it.id !== id)
      return next
    })

  const accept = useCallback(
    async (item) => {
      setBusy(item.id, true)
      try {
        const res = await laptopConnectorApi.accept(item.id)
        removeFromView(item.id)
        toast({ title: 'Added', description: `${item.title} → ${res?.routed_to || 'pipeline'}` })
      } catch (err) {
        toast({ title: 'Accept failed', description: err.message, variant: 'destructive' })
      } finally {
        setBusy(item.id, false)
      }
    },
    [toast],
  )

  const dismiss = useCallback(
    async (item) => {
      setBusy(item.id, true)
      try {
        await laptopConnectorApi.dismiss(item.id, 'user_dismissed')
        removeFromView(item.id)
      } catch (err) {
        toast({ title: 'Dismiss failed', description: err.message, variant: 'destructive' })
      } finally {
        setBusy(item.id, false)
      }
    },
    [toast],
  )

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const acceptSelected = useCallback(async () => {
    const ids = [...selected]
    if (!ids.length) return
    let ok = 0
    let fail = 0
    for (const id of ids) {
      const item = allItems.find((it) => it.id === id)
      if (!item) continue
      try {
        await laptopConnectorApi.accept(id)
        removeFromView(id)
        ok += 1
      } catch {
        fail += 1
      }
    }
    setSelected(new Set())
    toast({ title: 'Bulk accept complete', description: `${ok} added${fail ? `, ${fail} failed` : ''}` })
  }, [selected, allItems, toast])

  const renderItem = (item) => {
    const busy = busyIds.has(item.id)
    return (
      <div key={item.id} className="flex items-start gap-3 rounded-md border p-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={selected.has(item.id)}
          onChange={() => toggle(item.id)}
          aria-label={`Select ${item.title}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate font-medium">{item.title}</p>
            <Confidence value={item.confidence} />
          </div>
          {item.summary && <p className="mt-0.5 text-sm text-muted-foreground">{item.summary}</p>}
          {item.provenance?.file_path && (
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate">{item.provenance.file_path}</span>
            </p>
          )}
          {item.provenance?.snippet && (
            <blockquote className="mt-1 border-l-2 pl-2 text-xs italic text-muted-foreground">
              “{item.provenance.snippet}”
            </blockquote>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => accept(item)}>
            <Check className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => dismiss(item)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    )
  }

  const renderGroup = (type) => {
    const meta = TYPE_META[type]
    const items = grouped[type] || []
    const Icon = meta.icon
    return (
      <Card key={type}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Icon className="h-5 w-5 text-primary" />
            {meta.label}
            <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs">{items.length}</span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{meta.blurb}</p>
        </CardHeader>
        <CardContent className="space-y-2">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing pending.</p>
          ) : (
            items.map(renderItem)
          )}
        </CardContent>
      </Card>
    )
  }

  const total = counts.total ?? allItems.length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <Laptop className="h-6 w-6 text-primary" />
            Laptop Inbox
          </h2>
          <p className="text-sm text-muted-foreground">
            Candidates parsed from your laptop by the connector. Nothing is added until you accept it.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={acceptSelected} disabled={selected.size === 0}>
            Accept selected ({selected.size})
          </Button>
          <Button variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <Alert>
        <AlertDescription>
          {total === 0
            ? 'No pending candidates. Run the connector locally (tools/laptop-connector) to populate this inbox.'
            : `${total} candidate(s) awaiting review. Regulated folders (PHI, legal evidence, vault) are excluded by the connector's denylist.`}
        </AlertDescription>
      </Alert>

      {runs.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Last run: {runs[0]?.status} — {runs[0]?.files_ingested ?? 0} files ingested,{' '}
          {runs[0]?.candidates_created ?? 0} candidates created.
        </p>
      )}

      <div className="grid gap-4">{['profile_field', 'lead', 'funding'].map(renderGroup)}</div>
    </div>
  )
}
