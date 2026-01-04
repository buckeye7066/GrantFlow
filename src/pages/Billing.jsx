import React, { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Loader2, PenSquare, ShieldCheck, Users } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { useAuthStore } from "@/stores/authStore"
import { listBillingTiers, listBillingAccounts, updateBillingAccount, getBillingAccount } from "@/api/billing"
import { getProfile } from "@/api/profiles"

const discountOptions = [
  { value: "none", label: "No discount" },
  { value: "student", label: "Student discount" },
  { value: "minister", label: "Minister discount" },
  { value: "hardship", label: "Hardship discount" },
  { value: "custom", label: "Custom discount" },
]

function formatCurrencyFromCents(cents) {
  if (cents === null || cents === undefined) return "Not set"
  if (cents === 0) return "$0"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
}

function BillingAccountCard({ account, tiers, onSave, saving }) {
  const [form, setForm] = useState({
    tier_id: account.tier_id,
    discount_type: account.discount_type ?? "none",
    discount_percent: account.discount_percent ?? 0,
    is_pro_bono: account.is_pro_bono ?? false,
    pro_bono_reason: account.pro_bono_reason ?? "",
  })

  useEffect(() => {
    setForm({
      tier_id: account.tier_id,
      discount_type: account.discount_type ?? "none",
      discount_percent: account.discount_percent ?? 0,
      is_pro_bono: account.is_pro_bono ?? false,
      pro_bono_reason: account.pro_bono_reason ?? "",
    })
  }, [account.id, account.tier_id, account.discount_type, account.discount_percent, account.is_pro_bono, account.pro_bono_reason])

  const tier = tiers.find((entry) => entry.id === form.tier_id)
  const monthly = account.custom_monthly_cents ?? tier?.base_monthly_cents ?? null
  const hourly = account.custom_hourly_cents ?? tier?.hourly_rate_cents ?? null

  return (
    <Card className="border border-slate-200 bg-white/80 backdrop-blur-md shadow-sm">
      <CardHeader className="pb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <CardTitle className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            {account.profile_name}
            <Badge variant="outline" className="capitalize text-xs text-slate-500 border-slate-200">
              {account.profile_type?.replace(/_/g, " ") || "profile"}
            </Badge>
          </CardTitle>
          <CardDescription>
            Last updated {account.updated_at ? new Date(account.updated_at).toLocaleString() : "recently"}
          </CardDescription>
        </div>
        <Badge className={account.is_pro_bono ? "bg-violet-600 text-white" : "bg-slate-900 text-white"}>
          {account.is_pro_bono ? "Pro Bono" : tier?.name ?? "Tier pending"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Billing tier</label>
            <Select value={form.tier_id} onValueChange={(value) => setForm((prev) => ({ ...prev, tier_id: value }))}>
              <SelectTrigger>
                <SelectValue placeholder="Select tier" />
              </SelectTrigger>
              <SelectContent>
                {tiers.map((tierOption) => (
                  <SelectItem key={tierOption.id} value={tierOption.id}>
                    <div className="flex flex-col items-start gap-1">
                      <span className="font-medium">{tierOption.name}</span>
                      <span className="text-xs text-slate-500">
                        {formatCurrencyFromCents(tierOption.base_monthly_cents)} / mo
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Discount</label>
            <div className="flex gap-3 items-center">
              <Select
                value={form.discount_type}
                onValueChange={(value) => setForm((prev) => ({ ...prev, discount_type: value }))}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="No discount" />
                </SelectTrigger>
                <SelectContent>
                  {discountOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="number"
                min={0}
                max={100}
                value={form.discount_percent}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    discount_percent: Number.parseFloat(event.target.value) || 0,
                  }))
                }
                className="w-24"
              />
              <span className="text-xs text-slate-500">%</span>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Monthly retainer</label>
            <p className="text-lg font-semibold text-slate-900">{formatCurrencyFromCents(monthly)}</p>
            <p className="text-xs text-slate-500">{tier?.description ?? "Tier description pending"}</p>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Hourly rate</label>
            <p className="text-lg font-semibold text-slate-900">{formatCurrencyFromCents(hourly)}</p>
            <p className="text-xs text-slate-500">Custom rates can be captured during invoice generation.</p>
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Switch
                id={`pro-bono-${account.id}`}
                checked={form.is_pro_bono}
                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, is_pro_bono: checked }))}
              />
              <label htmlFor={`pro-bono-${account.id}`} className="text-sm font-medium text-slate-700">
                Mark engagement as pro bono
              </label>
            </div>
            <Badge variant="outline" className="text-xs text-slate-500">
              Logged for tax reporting
            </Badge>
          </div>
          {form.is_pro_bono ? (
            <Textarea
              value={form.pro_bono_reason}
              onChange={(event) => setForm((prev) => ({ ...prev, pro_bono_reason: event.target.value }))}
              placeholder="Add internal notes about this pro bono arrangement."
              className="min-h-[80px]"
            />
          ) : null}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() =>
              setForm({
                tier_id: account.tier_id,
                discount_type: account.discount_type ?? "none",
                discount_percent: account.discount_percent ?? 0,
                is_pro_bono: account.is_pro_bono ?? false,
                pro_bono_reason: account.pro_bono_reason ?? "",
              })
            }
            disabled={saving}
          >
            Reset
          </Button>
          <Button className="gap-2" onClick={() => onSave(account.profile_id, form)} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <PenSquare className="w-4 h-4" />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function MemberBillingCard({ profileId, billing, isLoading, onRefresh }) {
  if (isLoading) {
    return (
      <div className="flex min-h-[220px] items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
      </div>
    )
  }

  if (!billing) {
    return (
      <Card className="border border-slate-200 bg-white/80">
        <CardHeader>
          <CardTitle>Billing details unavailable</CardTitle>
          <CardDescription>
            We could not load billing information for this profile. Refresh or contact the GrantFlow admin team.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={onRefresh}>
            Refresh
          </Button>
        </CardContent>
      </Card>
    )
  }

  const tier = billing.account?.tier
  const monthly = billing.account?.custom_monthly_cents ?? tier?.base_monthly_cents ?? null
  const hourly = billing.account?.custom_hourly_cents ?? tier?.hourly_rate_cents ?? null

  return (
    <Card className="border border-slate-200 bg-white/80 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg font-semibold">
          Billing details
          <Badge variant="outline" className="text-xs text-slate-500 border-slate-200">
            Profile ID {profileId ? `${profileId.slice(0, 8)}…` : "unknown"}
          </Badge>
        </CardTitle>
        <CardDescription>
          Your plan reflects the onboarding application and any admin overrides. Reach out if circumstances change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Tier</p>
            <p className="text-lg font-semibold text-slate-900 mt-1">
              {billing.account?.is_pro_bono ? "Pro Bono" : tier?.name ?? "Awaiting assignment"}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {tier?.description ?? "Once assigned, tier capabilities will appear here."}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Monthly Retainer</p>
            <p className="text-lg font-semibold text-slate-900 mt-1">{formatCurrencyFromCents(monthly)}</p>
            <p className="text-xs text-slate-500 mt-1">
              Hourly support billed at {formatCurrencyFromCents(hourly)}.
            </p>
          </div>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 flex gap-3 items-start">
          <ShieldCheck className="w-5 h-5 text-emerald-600 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-emerald-700">Ethical billing commitments</p>
            <p className="text-xs text-emerald-700 mt-1">
              No percentage-of-award fees. Only transparent hourly, milestone, or retainer billing aligned with funder rules.
              Discounts for students and ministers are automatically applied where approved.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function Billing() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { user, activeProfileId } = useAuthStore((state) => ({
    user: state.user,
    activeProfileId: state.activeProfileId,
  }))

  const isAdmin = Boolean(user?.is_admin || user?.id === "admin")

  const tiersQuery = useQuery({
    queryKey: ["billing-tiers"],
    queryFn: listBillingTiers,
  })

  const accountsQuery = useQuery({
    queryKey: ["billing-accounts"],
    queryFn: listBillingAccounts,
    enabled: isAdmin,
  })

  const activeAccountQuery = useQuery({
    queryKey: ["billing-account", activeProfileId],
    queryFn: () => getBillingAccount(activeProfileId),
    enabled: !isAdmin && Boolean(activeProfileId),
  })

  const profileQuery = useQuery({
    queryKey: ["profile", activeProfileId],
    queryFn: () => getProfile(activeProfileId),
    enabled: !isAdmin && Boolean(activeProfileId),
  })

  const updateMutation = useMutation({
    mutationFn: ({ profileId, payload }) => updateBillingAccount(profileId, payload),
    onSuccess: (response, variables) => {
      toast({
        title: "Billing updated",
        description: "The billing assignment was saved successfully.",
      })
      queryClient.invalidateQueries({ queryKey: ["billing-accounts"] })
      if (variables.profileId) {
        queryClient.invalidateQueries({ queryKey: ["billing-account", variables.profileId] })
        queryClient.invalidateQueries({ queryKey: ["profile", variables.profileId] })
      }
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Unable to update billing",
        description: error instanceof Error ? error.message : "Try again shortly.",
      })
    },
  })

  const handleSaveAccount = (profileId, payload) => {
    updateMutation.mutate({ profileId, payload })
  }

  if (isAdmin) {
    if (tiersQuery.isLoading || accountsQuery.isLoading) {
      return (
        <div className="flex min-h-[320px] items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      )
    }

    const tiers = tiersQuery.data ?? []
    const accounts = accountsQuery.data ?? []

    return (
      <div className="p-6 md:p-10 space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold text-slate-900">Billing Console</h1>
          <p className="text-sm text-slate-600 max-w-3xl">
            Assign tiers, apply student or minister discounts, and track pro bono agreements across every onboarding profile.
            Changes here flow through to invoices, time tracking, and reporting exports.
          </p>
        </header>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Users className="w-4 h-4" />
              Active accounts
            </h2>
            <Button variant="outline" size="sm" onClick={() => accountsQuery.refetch()}>
              Refresh
            </Button>
          </div>
          <div className="grid gap-6">
            {accounts.map((account) => (
              <BillingAccountCard
                key={account.id}
                account={account}
                tiers={tiers}
                onSave={handleSaveAccount}
                saving={updateMutation.isPending && updateMutation.variables?.profileId === account.profile_id}
              />
            ))}
            {accounts.length === 0 ? (
              <Card className="border border-slate-200 bg-white/80">
                <CardContent className="p-8 text-center text-sm text-slate-500">
                  No billing accounts have been created yet. Profiles will appear here once onboarding begins.
                </CardContent>
              </Card>
            ) : null}
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="p-6 md:p-10 space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold text-slate-900">Billing Overview</h1>
        <p className="text-sm text-slate-600">
          Review the tier and guardrails tied to your onboarding application. Contact the GrantFlow team if your situation
          changes or you need to request a different arrangement.
        </p>
      </header>
      <MemberBillingCard
        profileId={activeProfileId ?? "unknown"}
        billing={activeAccountQuery.data}
        isLoading={activeAccountQuery.isLoading || profileQuery.isLoading}
        onRefresh={() => {
          activeAccountQuery.refetch()
          profileQuery.refetch()
        }}
      />
    </div>
  )
}
