import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'
import {
  fetchServiceCatalog,
  fetchServiceTerms,
  createServicePurchase,
  listServicePurchases,
  createServiceCheckout,
  addHourlyTimeEntry,
  createHourlyCheckout,
} from '@/api/services'
import { useToast } from '@/components/ui/use-toast'

function formatUsdFromCents(cents) {
  const n = Number(cents)
  if (!Number.isFinite(n)) return '$—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100)
}

const CATEGORY_LABELS = {
  individual: 'Individual',
  small: 'Small Org (< $250k)',
  mid: 'Mid-Size ($250k–$2M)',
  large: 'Large Org (> $2M)',
}

export default function Services() {
  const { toast } = useToast()
  const qc = useQueryClient()

  const [selectedServiceSlug, setSelectedServiceSlug] = React.useState('')
  const [clientCategory, setClientCategory] = React.useState('individual')
  const [agreed, setAgreed] = React.useState(false)

  const [hourlyMinutes, setHourlyMinutes] = React.useState('')
  const [hourlyNote, setHourlyNote] = React.useState('')

  const catalogQuery = useQuery({
    queryKey: ['services', 'catalog'],
    queryFn: fetchServiceCatalog,
  })

  const termsQuery = useQuery({
    queryKey: ['services', 'terms'],
    queryFn: fetchServiceTerms,
  })

  const purchasesQuery = useQuery({
    queryKey: ['services', 'purchases'],
    queryFn: listServicePurchases,
  })

  const catalog = catalogQuery.data?.catalog || []
  const terms = termsQuery.data?.terms || null

  const selectedService = catalog.find((s) => s.slug === selectedServiceSlug) || null

  const getPriceRow = (svc, { phase = null } = {}) => {
    if (!svc) return null
    const rows = Array.isArray(svc.prices) ? svc.prices : []
    return rows.find((p) => p.client_category === clientCategory && (p.milestone_phase || null) === (phase || null)) || null
  }

  const purchaseMutation = useMutation({
    mutationFn: () =>
      createServicePurchase({
        service_slug: selectedServiceSlug,
        client_category: clientCategory,
      }),
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: ['services', 'purchases'] })
      toast({ title: 'Created service purchase', description: `Ready to checkout for ${selectedService?.name || 'service'}.` })
      return data
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: 'Could not create purchase', description: err?.message || String(err) })
    },
  })

  const checkoutMutation = useMutation({
    mutationFn: async ({ purchase_id, milestone_phase }) => {
      return createServiceCheckout({ purchase_id, milestone_phase, agree: true })
    },
    onSuccess: (data) => {
      if (data?.url) window.location.assign(data.url)
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: 'Checkout failed', description: err?.message || String(err) })
    },
  })

  const hourlyEntryMutation = useMutation({
    mutationFn: async ({ purchase_id }) => {
      return addHourlyTimeEntry({
        purchase_id,
        minutes: Number(hourlyMinutes),
        note: hourlyNote || undefined,
      })
    },
    onSuccess: async () => {
      setHourlyMinutes('')
      setHourlyNote('')
      await qc.invalidateQueries({ queryKey: ['services', 'purchases'] })
      toast({ title: 'Logged time', description: 'Time entry saved with 15-min minimum and 6-min rounding.' })
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: 'Could not log time', description: err?.message || String(err) })
    },
  })

  const hourlyCheckoutMutation = useMutation({
    mutationFn: async ({ purchase_id }) => createHourlyCheckout({ purchase_id, agree: true }),
    onSuccess: (data) => {
      if (data?.url) window.location.assign(data.url)
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: 'Hourly checkout failed', description: err?.message || String(err) })
    },
  })

  const handleStartCheckout = async () => {
    if (!selectedService) return
    if (!agreed) {
      toast({ variant: 'destructive', title: 'Agreement required', description: 'Please agree to the policy snippet before checkout.' })
      return
    }

    const created = await purchaseMutation.mutateAsync()
    const purchaseId = created?.purchase?.id
    if (!purchaseId) return

    if (selectedService.pricing_model === 'milestone') {
      // Start with kickoff
      checkoutMutation.mutate({ purchase_id: purchaseId, milestone_phase: 'kickoff' })
      return
    }

    checkoutMutation.mutate({ purchase_id: purchaseId })
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Services</h1>
          <p className="text-slate-600 mt-2">Select a service from the Payment Sheet and complete checkout.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Choose a service</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {catalogQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading catalog…
              </div>
            ) : null}

            {catalogQuery.error ? (
              <Alert variant="destructive">
                <AlertDescription className="flex flex-col gap-2">
                  <span>Failed to load service catalog.</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-fit"
                    onClick={() => catalogQuery.refetch()}
                  >
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : catalogQuery.data?.degraded ? (
              <Alert>
                <AlertDescription className="flex flex-col gap-2">
                  <span>Service catalog is temporarily unavailable. Please try again shortly.</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-fit"
                    onClick={() => catalogQuery.refetch()}
                  >
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Service</Label>
                <Select value={selectedServiceSlug} onValueChange={setSelectedServiceSlug}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a service" />
                  </SelectTrigger>
                  <SelectContent>
                    {catalog.map((s) => (
                      <SelectItem key={s.slug} value={s.slug}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Client category</Label>
                <Select value={clientCategory} onValueChange={setClientCategory}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(CATEGORY_LABELS).map((k) => (
                      <SelectItem key={k} value={k}>
                        {CATEGORY_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {selectedService ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
                <div className="text-sm font-semibold text-slate-900">{selectedService.name}</div>
                <div className="text-sm text-slate-700">{selectedService.description}</div>

                {selectedService.pricing_model === 'milestone' ? (
                  <div className="text-sm text-slate-700">
                    <div className="font-medium">Milestone payments (40/40/20)</div>
                    <div className="mt-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {['kickoff', 'draft', 'submission'].map((phase) => {
                        const pr = getPriceRow(selectedService, { phase })
                        return (
                          <div key={phase} className="rounded-md border bg-white p-3">
                            <div className="text-xs text-slate-500">{phase}</div>
                            <div className="text-sm font-semibold">{formatUsdFromCents(pr?.amount_cents)}</div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ) : selectedService.pricing_model === 'hourly' ? (
                  <div className="text-sm text-slate-700">
                    <div className="font-medium">Hourly billing</div>
                    <div className="mt-1">15-minute minimum; billed in 6-minute increments.</div>
                    <div className="mt-2">
                      Per 6-minute unit: <strong>{formatUsdFromCents(getPriceRow(selectedService)?.amount_cents)}</strong>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-slate-700">
                    Price: <strong>{formatUsdFromCents(getPriceRow(selectedService)?.amount_cents)}</strong>
                  </div>
                )}
              </div>
            ) : null}

            <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
              <div className="text-sm font-medium text-slate-900">Policy snippet (required)</div>
              <div className="text-sm text-slate-700">{terms?.policy_snippet || 'Loading…'}</div>
              <label className="flex items-center gap-2 text-sm text-slate-800">
                <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(Boolean(v))} />
                I agree
              </label>
            </div>

            <Button
              disabled={!selectedServiceSlug || purchaseMutation.isPending || checkoutMutation.isPending}
              onClick={handleStartCheckout}
              className="w-full"
            >
              {(purchaseMutation.isPending || checkoutMutation.isPending) ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating checkout…
                </>
              ) : (
                'Checkout'
              )}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Your purchases</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {purchasesQuery.isLoading ? <div className="text-sm text-slate-600">Loading purchases…</div> : null}
            {(purchasesQuery.data?.purchases || []).length === 0 ? (
              <div className="text-sm text-slate-600">No purchases yet.</div>
            ) : (
              <div className="space-y-3">
                {(purchasesQuery.data?.purchases || []).map((p) => (
                  <div key={p.id} className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium text-slate-900">{p.service_name}</div>
                      <div className="text-xs text-slate-600">{p.status}</div>
                    </div>
                    <div className="text-sm text-slate-700">
                      Category: {CATEGORY_LABELS[p.client_category] || p.client_category} • Model: {p.pricing_model}
                    </div>

                    {p.pricing_model === 'milestone' ? (
                      <div className="space-y-2">
                        <div className="text-sm font-medium text-slate-900">Milestones</div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          {p.milestones.map((m) => (
                            <div key={m.id} className="rounded-md border bg-slate-50 p-3">
                              <div className="text-xs text-slate-500">{m.phase}</div>
                              <div className="text-sm font-semibold">{formatUsdFromCents(m.amount_cents)}</div>
                              <div className="text-xs text-slate-600 mt-1">{m.status}</div>
                              <Button
                                size="sm"
                                className="mt-2 w-full"
                                disabled={!agreed || m.status === 'paid' || checkoutMutation.isPending}
                                onClick={() => checkoutMutation.mutate({ purchase_id: p.id, milestone_phase: m.phase })}
                              >
                                Pay {m.phase}
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {p.pricing_model === 'hourly' ? (
                      <div className="space-y-2">
                        <div className="text-sm font-medium text-slate-900">Hourly time</div>
                        <div className="text-sm text-slate-700">
                          Total rounded minutes: <strong>{p.hourly?.total_rounded_minutes || 0}</strong>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                          <div className="space-y-1">
                            <Label>Minutes</Label>
                            <Input value={hourlyMinutes} onChange={(e) => setHourlyMinutes(e.target.value)} placeholder="e.g. 20" />
                          </div>
                          <div className="space-y-1 md:col-span-2">
                            <Label>Note</Label>
                            <Input value={hourlyNote} onChange={(e) => setHourlyNote(e.target.value)} placeholder="Optional note" />
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            disabled={!hourlyMinutes || hourlyEntryMutation.isPending}
                            onClick={() => hourlyEntryMutation.mutate({ purchase_id: p.id })}
                          >
                            Log time
                          </Button>
                          <Button
                            disabled={hourlyCheckoutMutation.isPending || !agreed}
                            onClick={() => hourlyCheckoutMutation.mutate({ purchase_id: p.id })}
                          >
                            Checkout hours
                          </Button>
                        </div>
                        {p.hourly?.invoices?.length ? (
                          <div className="text-xs text-slate-600">
                            Latest invoice: {p.hourly.invoices[0].status} • {formatUsdFromCents(p.hourly.invoices[0].amount_cents)}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

