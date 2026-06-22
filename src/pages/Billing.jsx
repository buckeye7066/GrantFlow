import React, { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Loader2, PenSquare, ShieldCheck, Users, FileText, Gift, Clock } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { useAuthStore } from "@/stores/authStore"
import { listBillingTiers, listBillingAccounts, updateBillingAccount, getBillingAccount, getBillingOverview, grantFreePeriod, revokeFreePeriod } from "@/api/billing"
import TierMatrix from "@/components/billing/TierMatrix.jsx"
import ContactAndNotifications from "@/components/comms/ContactAndNotifications.jsx"
import { getProfile } from "@/api/profiles"
import { labelForProfileType } from "@/services/profileTypes"
import { Link } from "react-router-dom"
import { createPageUrl } from "@/utils"

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

function freePeriodLabel(free) {
  if (!free?.active) return null
  const until = free.until ? new Date(free.until).toLocaleDateString() : null
  const kind = free.kind === 'month' ? '1 month free' : free.kind === 'week' ? '1 week free' : 'Free period'
  return until ? `${kind} · ${free.days_remaining}d left (until ${until})` : kind
}

/** Per-account free-period (trial) controls: grant 1 week / 1 month, or end early. */
function FreePeriodControls({ account, onGrant, onRevoke, busy }) {
  const free = account.free_period
  const active = Boolean(free?.active)
  return (
    <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Gift className="w-4 h-4 text-amber-600" />
          <span className="text-sm font-medium text-slate-700">Free period</span>
          {active ? (
            <Badge className="bg-amber-500 text-white flex items-center gap-1">
              <Clock className="w-3 h-3" /> {freePeriodLabel(free)}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs text-slate-500">None active</Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={busy}
            onClick={() => onGrant(account.profile_id, 'week')}>
            Give 1 week free
          </Button>
          <Button variant="outline" size="sm" disabled={busy}
            onClick={() => onGrant(account.profile_id, 'month')}>
            Give 1 month free
          </Button>
          {active ? (
            <Button variant="ghost" size="sm" className="text-rose-600" disabled={busy}
              onClick={() => onRevoke(account.profile_id)}>
              End free period
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Granting starts the timer immediately and suppresses invoices until it ends. Re-granting extends an
        active period rather than shortening it. Billing resumes automatically when the timer runs out.
      </p>
    </div>
  )
}

/** Admin-wide free-period controls: grant/end a free period for EVERY profile. */
function GlobalFreePeriodPanel({ onGrantGlobal, onRevokeGlobal, busy }) {
  return (
    <Card className="border border-amber-200 bg-amber-50/40">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Gift className="w-4 h-4 text-amber-600" /> Promotions — free period for everyone
        </CardTitle>
        <CardDescription>
          Give every profile a free week or month at once (e.g. a launch promotion). The timer starts now for
          all accounts; invoices are suppressed until it ends.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onGrantGlobal('week')}>
          Give ALL 1 week free
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onGrantGlobal('month')}>
          Give ALL 1 month free
        </Button>
        <Button variant="ghost" size="sm" className="text-rose-600" disabled={busy} onClick={onRevokeGlobal}>
          End all free periods
        </Button>
      </CardContent>
    </Card>
  )
}

function generateInvoiceHTML(invoiceData) {
  const {
    invoiceNumber,
    invoiceDate,
    profileName,
    profileType,
    tierName,
    monthly,
    hourly,
    discountType,
    discountPercent,
    discountAmount,
    isProBono,
    proBonoReason,
    totalDue,
  } = invoiceData

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Invoice ${invoiceNumber}</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 40px auto;
            padding: 20px;
            color: #333;
          }
          .header {
            text-align: center;
            margin-bottom: 40px;
            border-bottom: 3px solid #2563eb;
            padding-bottom: 20px;
          }
          .header h1 {
            color: #2563eb;
            margin: 0;
            font-size: 32px;
          }
          .invoice-info {
            display: flex;
            justify-content: space-between;
            margin-bottom: 30px;
          }
          .invoice-info div {
            flex: 1;
          }
          .section {
            margin-bottom: 20px;
          }
          .section-title {
            font-weight: bold;
            color: #2563eb;
            margin-bottom: 5px;
            font-size: 14px;
            text-transform: uppercase;
          }
          .section-value {
            font-size: 16px;
            margin-bottom: 10px;
          }
          .details-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 30px;
          }
          .details-table th,
          .details-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #e5e7eb;
          }
          .details-table th {
            background-color: #f3f4f6;
            font-weight: bold;
            color: #1f2937;
          }
          .total-row {
            font-weight: bold;
            font-size: 18px;
            background-color: #f9fafb;
          }
          .pro-bono-badge {
            display: inline-block;
            background-color: #7c3aed;
            color: white;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
          }
          .footer {
            margin-top: 50px;
            padding-top: 20px;
            border-top: 1px solid #e5e7eb;
            text-align: center;
            color: #6b7280;
            font-size: 14px;
          }
          @media print {
            body {
              margin: 0;
            }
            .no-print {
              display: none;
            }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>GrantFlow Invoice</h1>
        </div>
        
        <div class="invoice-info">
          <div>
            <div class="section-title">Invoice Number</div>
            <div class="section-value">${invoiceNumber}</div>
            <div class="section-title">Invoice Date</div>
            <div class="section-value">${invoiceDate}</div>
          </div>
          <div>
            <div class="section-title">Client</div>
            <div class="section-value">${profileName}</div>
            <div class="section-title">Profile Type</div>
            <div class="section-value">${profileType}</div>
          </div>
        </div>

        <table class="details-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Details</th>
              <th style="text-align: right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Billing Tier</strong></td>
              <td>${tierName}</td>
              <td style="text-align: right;">${formatCurrencyFromCents(monthly)}</td>
            </tr>
            <tr>
              <td><strong>Hourly Rate</strong></td>
              <td>Standard hourly rate for services</td>
              <td style="text-align: right;">${formatCurrencyFromCents(hourly)}</td>
            </tr>
            ${discountType !== 'none' ? `
            <tr>
              <td><strong>Discount Applied</strong></td>
              <td>${discountType.charAt(0).toUpperCase() + discountType.slice(1)} (${discountPercent}%)</td>
              <td style="text-align: right;">-${formatCurrencyFromCents(discountAmount)}</td>
            </tr>
            ` : ''}
            ${isProBono ? `
            <tr>
              <td colspan="3">
                <span class="pro-bono-badge">PRO BONO SERVICE</span>
                ${proBonoReason ? `<div style="margin-top: 8px; color: #6b7280;">${proBonoReason}</div>` : ''}
              </td>
            </tr>
            ` : ''}
            <tr class="total-row">
              <td colspan="2"><strong>Total Amount Due</strong></td>
              <td style="text-align: right;"><strong>${formatCurrencyFromCents(totalDue)}</strong></td>
            </tr>
          </tbody>
        </table>

        <div class="footer">
          <p><strong>GrantFlow</strong> - Professional Grant Writing Services</p>
          <p>Ethical billing practices - No percentage-of-award fees</p>
          <button class="no-print" onclick="window.print()" style="
            margin-top: 20px;
            padding: 10px 20px;
            background-color: #2563eb;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            cursor: pointer;
          ">Print Invoice</button>
        </div>
      </body>
    </html>
  `
}

function BillingAccountCard({ account, tiers, onSave, saving, onGrantFree, onRevokeFree, freeBusy }) {
  const [form, setForm] = useState({
    tier_id: account.tier_id,
    discount_type: account.discount_type ?? "none",
    discount_percent: account.discount_percent ?? 0,
    is_pro_bono: account.is_pro_bono ?? false,
    pro_bono_reason: account.pro_bono_reason ?? "",
  })

  const handleGenerateInvoice = () => {
    const tier = tiers.find((t) => t.id === form.tier_id)
    const monthly = account.custom_monthly_cents ?? tier?.base_monthly_cents ?? 0
    const hourly = account.custom_hourly_cents ?? tier?.hourly_rate_cents ?? 0
    
    // Generate a more robust invoice number with timestamp and cryptographically secure random component
    const timestamp = Date.now()
    const randomBytes = new Uint8Array(4)
    crypto.getRandomValues(randomBytes)
    const randomPart = Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
    const invoiceNumber = `INV-${timestamp}-${randomPart}`
    
    const invoiceDate = new Date().toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    })

    // Calculate discount amount with null-safety for both monthly and discount_percent
    const discountAmount = (monthly && form.discount_percent) ? (monthly * (form.discount_percent / 100)) : 0
    const totalDue = form.is_pro_bono ? 0 : (monthly - discountAmount)

    const invoiceHTML = generateInvoiceHTML({
      invoiceNumber,
      invoiceDate,
      profileName: account.profile_name,
      profileType: account.profile_type_label || labelForProfileType(account.profile_type, 'N/A'),
      tierName: tier?.name ?? 'Not assigned',
      monthly,
      hourly,
      discountType: form.discount_type,
      discountPercent: form.discount_percent,
      discountAmount,
      isProBono: form.is_pro_bono,
      proBonoReason: form.pro_bono_reason,
      totalDue,
    })

    // No "noopener" — it makes window.open() return null, so document.write
    // below never runs and the invoice tab opens blank. Same-origin content we own.
    const invoiceWindow = window.open('', '_blank')
    if (invoiceWindow) {
      invoiceWindow.document.write(invoiceHTML)
      invoiceWindow.document.close()
    } else {
      alert('Please allow pop-ups to generate the invoice')
    }
  }

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
              {account.profile_type_label || labelForProfileType(account.profile_type, "Profile")}
            </Badge>
          </CardTitle>
          <CardDescription>
            Last updated {account.updated_at ? new Date(account.updated_at).toLocaleString() : "recently"}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {account.free_period?.active ? (
            <Badge className="bg-amber-500 text-white flex items-center gap-1">
              <Clock className="w-3 h-3" /> {account.free_period.kind === 'month' ? '1mo free' : '1wk free'} · {account.free_period.days_remaining}d
            </Badge>
          ) : null}
          <Badge className={account.is_pro_bono ? "bg-violet-600 text-white" : "bg-slate-900 text-white"}>
            {account.is_pro_bono ? "Pro Bono" : tier?.name ?? "Tier pending"}
          </Badge>
        </div>
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

        <FreePeriodControls account={account} onGrant={onGrantFree} onRevoke={onRevokeFree} busy={freeBusy} />

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={handleGenerateInvoice}
          >
            Generate Invoice
          </Button>
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
  // Prefer the effective (seat-driven, discount/pro-bono-adjusted) monthly from
  // the /me endpoint; fall back to the raw tier price for older shapes.
  const monthly = billing.billing?.net_monthly_cents
    ?? billing.account?.custom_monthly_cents ?? tier?.base_monthly_cents ?? null
  const hourly = billing.account?.custom_hourly_cents ?? tier?.hourly_rate_cents ?? null

  return (
    <Card className="border border-slate-200 bg-white/80 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg font-semibold">
          Billing details
          <Badge variant="outline" className="text-xs text-slate-500 border-slate-200">
            Profile ID {profileId ?? "unknown"}
          </Badge>
        </CardTitle>
        <CardDescription>
          Your plan reflects the onboarding application and any admin overrides. Reach out if circumstances change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {billing.free_period?.active ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 flex gap-3 items-start">
            <Gift className="w-5 h-5 text-amber-600 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-700">
                You're on a free {billing.free_period.kind === 'month' ? 'month' : 'week'}!
              </p>
              <p className="text-xs text-amber-700 mt-1">
                {billing.free_period.granted_at ? `Started ${new Date(billing.free_period.granted_at).toLocaleDateString()}. ` : ''}
                {billing.free_period.days_remaining} day{billing.free_period.days_remaining === 1 ? '' : 's'} remaining
                {billing.free_period.until ? ` (through ${new Date(billing.free_period.until).toLocaleDateString()})` : ''}. No invoices during this period.
              </p>
            </div>
          </div>
        ) : null}
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

  // Non-admin overview uses the read-only /me endpoint (the /accounts/:id route
  // is admin-only). It returns { account, billing (effective seat-driven amount) }.
  const activeAccountQuery = useQuery({
    queryKey: ["billing-account", activeProfileId],
    queryFn: () => getBillingOverview(activeProfileId),
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

  // Free-period (trial) mutations — individual + global. The backend starts the
  // timer at the moment of the grant and suppresses invoices while it's open.
  const freeMutation = useMutation({
    mutationFn: ({ kind, scope, profileId }) => grantFreePeriod({ kind, scope, profileId }),
    onSuccess: (res, vars) => {
      const what = vars.kind === 'month' ? '1 month free' : '1 week free'
      toast({
        title: vars.scope === 'global' ? `Granted ${what} to all profiles` : `Granted ${what}`,
        description: vars.scope === 'global' && res?.granted !== null && res?.granted !== undefined ? `${res.granted} accounts updated.` : 'The free period timer has started.',
      })
      queryClient.invalidateQueries({ queryKey: ["billing-accounts"] })
    },
    onError: (error) => toast({ variant: "destructive", title: "Unable to grant free period", description: error instanceof Error ? error.message : "Try again." }),
  })

  const revokeFreeMutation = useMutation({
    mutationFn: ({ scope, profileId }) => revokeFreePeriod({ scope, profileId }),
    onSuccess: () => {
      toast({ title: "Free period ended", description: "Normal billing resumes at the next cycle." })
      queryClient.invalidateQueries({ queryKey: ["billing-accounts"] })
    },
    onError: (error) => toast({ variant: "destructive", title: "Unable to end free period", description: error instanceof Error ? error.message : "Try again." }),
  })

  const freeBusy = freeMutation.isPending || revokeFreeMutation.isPending
  const handleGrantFree = (profileId, kind) => freeMutation.mutate({ kind, scope: 'profile', profileId })
  const handleRevokeFree = (profileId) => revokeFreeMutation.mutate({ scope: 'profile', profileId })
  const handleGrantFreeGlobal = (kind) => freeMutation.mutate({ kind, scope: 'global', profileId: null })
  const handleRevokeFreeGlobal = () => revokeFreeMutation.mutate({ scope: 'global', profileId: null })

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
          <div className="pt-2">
            <Link to={createPageUrl("BillingSheet")}>
              <Button variant="outline" size="sm">
                <FileText className="w-4 h-4 mr-2" />
                Payment Sheet (Master)
              </Button>
            </Link>
          </div>
        </header>

        <GlobalFreePeriodPanel
          onGrantGlobal={handleGrantFreeGlobal}
          onRevokeGlobal={handleRevokeFreeGlobal}
          busy={freeBusy}
        />

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
                onGrantFree={handleGrantFree}
                onRevokeFree={handleRevokeFree}
                freeBusy={freeBusy}
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
        <div className="pt-2">
          <Link to={createPageUrl("BillingSheet")}>
            <Button variant="outline" size="sm">
              <FileText className="w-4 h-4 mr-2" />
              Payment Sheet (Master)
            </Button>
          </Link>
        </div>
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
      <div className="mt-6">
        <TierMatrix currentTierId={activeAccountQuery.data?.account?.tier?.id || null} />
      </div>
      {activeProfileId && activeProfileId !== '__admin__' ? (
        <div className="mt-6">
          <ContactAndNotifications profileId={activeProfileId} />
        </div>
      ) : null}
    </div>
  )
}
