import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2 } from 'lucide-react'
import { adminFetchServiceCatalog, adminMapStripePrice, adminToggleServiceActive } from '@/api/services'
import { useToast } from '@/components/ui/use-toast'

function formatUsdFromCents(cents) {
  const n = Number(cents)
  if (!Number.isFinite(n)) return '$—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100)
}

export default function AdminServiceCatalog() {
  const { toast } = useToast()
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ['admin', 'serviceCatalog'],
    queryFn: adminFetchServiceCatalog,
  })

  const toggleMutation = useMutation({
    mutationFn: ({ slug, isActive }) => adminToggleServiceActive(slug, isActive),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin', 'serviceCatalog'] })
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: 'Update failed', description: err?.message || String(err) })
    },
  })

  const mapMutation = useMutation({
    mutationFn: ({ priceId, stripePriceId }) => adminMapStripePrice(priceId, stripePriceId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin', 'serviceCatalog'] })
      toast({ title: 'Stripe mapping saved' })
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: 'Mapping failed', description: err?.message || String(err) })
    },
  })

  const catalog = q.data?.catalog || []

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-600">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading service catalog…
      </div>
    )
  }

  if (q.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-col gap-2">
          <span>Failed to load service catalog.</span>
          {q.error?.message ? (
            <span className="text-xs opacity-80 break-words">{String(q.error.message)}</span>
          ) : null}
          <Button size="sm" variant="outline" className="w-fit" onClick={() => q.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  // Server-side graceful degradation: the catalog endpoint returns
  // { degraded: true, catalog: [] } (HTTP 200) when seeding/listing failed, so
  // the tab still renders instead of hard-crashing. Surface a soft notice + retry.
  if (q.data?.degraded) {
    return (
      <Alert>
        <AlertDescription className="flex flex-col gap-2">
          <span>Service catalog is temporarily unavailable. The team has been notified.</span>
          <Button size="sm" variant="outline" className="w-fit" onClick={() => q.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Service catalog (Payment Sheet)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-slate-700">
            Map each price row to a Stripe <code>price_*</code> ID. Checkout will refuse to run until mapped.
          </div>
        </CardContent>
      </Card>

      {catalog.map((svc) => (
        <Card key={svc.slug}>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">{svc.name}</CardTitle>
              <div className="text-xs text-slate-600 mt-1">
                {svc.category} • {svc.pricing_model}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-600">Active</span>
              <Switch
                checked={Boolean(svc.is_active)}
                onCheckedChange={(v) => toggleMutation.mutate({ slug: svc.slug, isActive: Boolean(v) })}
                disabled={toggleMutation.isPending}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm text-slate-700">{svc.description}</div>

            <div className="space-y-2">
              {(svc.prices || []).map((p) => {
                const label = `${p.client_category}${p.milestone_phase ? ` • ${p.milestone_phase}` : ''}`
                const needsMapping = !p.stripe_price_id
                return (
                  <div key={p.id} data-price-row className="grid grid-cols-1 md:grid-cols-4 gap-2 items-center border rounded-md p-3">
                    <div className="text-sm font-medium text-slate-900">{label}</div>
                    <div className="text-sm text-slate-700">{formatUsdFromCents(p.amount_cents)}</div>
                    <Input
                      key={p.stripe_price_id ?? `unmapped-${p.id}`}
                      defaultValue={p.stripe_price_id || ''}
                      data-price-input
                      placeholder="price_..."
                      className={needsMapping ? 'border-amber-300' : ''}
                      onBlur={(e) => {
                        const next = String(e.target.value || '').trim() || null
                        if (next === (p.stripe_price_id || null)) return
                        mapMutation.mutate({ priceId: p.id, stripePriceId: next })
                      }}
                    />
                    <div className="flex justify-end">
                      <Button
                        variant={needsMapping ? 'default' : 'outline'}
                        size="sm"
                        disabled={mapMutation.isPending}
                        onClick={() => mapMutation.mutate({ priceId: p.id, stripePriceId: p.stripe_price_id || null })}
                      >
                        {needsMapping ? 'Needs mapping' : 'Mapped'}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

