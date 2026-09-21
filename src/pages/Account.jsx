import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Check, CreditCard, ShieldCheck, Sparkles } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { getBillingOverview, getBillingInvoices, getTierCatalog, requestPlanChange } from '@/api/billing'
import { listProfiles } from '@/api/profiles'
import { fetchServiceCatalog } from '@/api/services'
import { startPasswordReset } from '@/api/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import LogoutButton from '@/components/auth/LogoutButton'
import { isNativeApp } from '@/lib/platform'
import { serviceStartingPrice } from '@/lib/accountBilling'

const money = (cents, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(cents) / 100)
const openInvoice = invoice => ['sent', 'second_notice', 'suspended'].includes(invoice.status) && !invoice.paid_at && Number(invoice.amount_cents) > 0
function paymentUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && ['checkout.stripe.com', 'buy.stripe.com', 'invoice.stripe.com'].includes(url.hostname) ? url.href : null } catch { return null }
}

function AccountBilling({ profileId, userId, native }) {
  const qc = useQueryClient()
  const overview = useQuery({ queryKey: ['account-billing', userId, profileId], queryFn: () => getBillingOverview(profileId), enabled: !!profileId })
  const invoices = useQuery({ queryKey: ['account-invoices', userId, profileId], queryFn: () => getBillingInvoices(profileId), enabled: !!profileId })
  const catalog = useQuery({ queryKey: ['tier-catalog'], queryFn: getTierCatalog })
  const services = useQuery({ queryKey: ['services', 'catalog'], queryFn: () => fetchServiceCatalog(), enabled: !native })
  const request = useMutation({
    mutationFn: tierId => requestPlanChange(profileId, tierId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account-billing', userId, profileId] }),
  })
  const account = overview.data?.account
  const tier = account?.tier
  const balances = invoices.data?.balances
  const pending = account?.plan_request?.status === 'pending_review' && account.plan_request.tier_id !== tier?.id ? account.plan_request : null
  const open = (invoices.data?.open_invoices || []).filter(openInvoice)

  return <div className="space-y-8">
    <div className="grid gap-5 md:grid-cols-2">
      <Card className="border-emerald-200 dark:border-emerald-900"><CardHeader><CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5" />Your plan</CardTitle></CardHeader><CardContent className="space-y-3">
        {!profileId ? <p>Choose a workspace to see its plan.</p> : overview.isPending ? <p>Loading your plan…</p> : overview.isError ? <p role="alert">Your plan could not be loaded. <button className="underline" onClick={() => overview.refetch()}>Try again</button></p> : <>
          <p className="text-3xl font-semibold">{tier?.name || 'Plan not assigned'}</p>
          {account?.is_pro_bono ? <p className="font-medium text-emerald-700 dark:text-emerald-300">Pro bono service</p> : !native && overview.data?.billing?.net_monthly_cents !== null && overview.data?.billing?.net_monthly_cents !== undefined ? <p>{money(overview.data.billing.net_monthly_cents)} / month</p> : null}
          {pending && <p role="status">Your request for {pending.tier_name} is awaiting review. Your current plan remains active.</p>}
          {!native && <Button asChild variant="outline"><a href="#account-plans">Explore upgrades <ArrowUpRight className="ml-2 h-4 w-4" /></a></Button>}
        </>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><CreditCard className="h-5 w-5" />Balance owed</CardTitle></CardHeader><CardContent className="space-y-3">
        {native ? <p>Billing and payment are not available in this app.</p> : !profileId ? <p>No billing workspace selected.</p> : invoices.isPending ? <p>Loading your balance…</p> : invoices.isError || !Array.isArray(balances) ? <p role="alert">Your balance could not be verified. <button className="underline" onClick={() => invoices.refetch()}>Try again</button></p> : <>
          {balances.length ? balances.map(balance => <p key={balance.currency} className="text-3xl font-semibold">{money(balance.amount_cents, balance.currency || 'USD')}</p>) : <p className="text-3xl font-semibold">{money(0)}</p>}
          <p className="text-sm text-muted-foreground">{balances.length ? 'Outstanding invoices for this workspace.' : 'You have no outstanding invoices.'}</p>
          {open.length > 0 && <Button asChild><a href="#account-invoices">Pay your bill</a></Button>}
        </>}
      </CardContent></Card>
    </div>
    {!native && profileId && <section id="account-invoices" className="space-y-3 scroll-mt-40"><h2 className="text-xl font-semibold">Invoices & payments</h2>
      {invoices.isSuccess && !open.length && <p className="text-sm text-muted-foreground">No unpaid invoices to pay.</p>}
      {open.map(invoice => <Card key={invoice.id}><CardContent className="flex flex-wrap items-center justify-between gap-4 p-5"><div><p className="font-medium">{invoice.period_key || 'Service invoice'}</p><p>{money(invoice.amount_cents, invoice.currency || 'USD')}</p>{invoice.due_at && <p className="text-sm text-muted-foreground">Due {String(invoice.due_at).slice(0, 10)}</p>}</div>
        {paymentUrl(invoice.stripe_payment_link) ? <Button asChild><a href={paymentUrl(invoice.stripe_payment_link)} target="_blank" rel="noopener noreferrer">Pay invoice <ArrowUpRight className="ml-2 h-4 w-4" /></a></Button> : <p className="text-sm text-muted-foreground">A payment link is not available yet. Contact billing through Help.</p>}
      </CardContent></Card>)}
    </section>}
    {!native && <section id="account-plans" className="space-y-5 scroll-mt-40"><div><p className="text-sm font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">Your next step</p><h2 className="mt-2 text-3xl font-semibold">Choose the support that fits your goals</h2><p className="mt-2 text-muted-foreground">Compare plans and request a change. We review your needs and confirm the price before changing your plan or charging you.</p></div>
      {catalog.isPending ? <p>Loading plans…</p> : catalog.isError ? <p role="alert">Plan pricing is unavailable. <button className="underline" onClick={() => catalog.refetch()}>Try again</button></p> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{(catalog.data?.tiers || []).map(plan => <Card key={plan.id} className={plan.id === tier?.id ? 'border-2 border-emerald-600' : ''}><CardHeader><CardTitle>{plan.name}</CardTitle><p className="text-sm text-muted-foreground">{plan.audience}</p></CardHeader><CardContent className="space-y-4"><p className="text-3xl font-semibold">{(plan.monthly_usd === null || plan.monthly_usd === undefined) ? 'Custom pricing' : money(plan.monthly_usd * 100)}<span className="text-sm font-normal text-muted-foreground"> / month</span></p><p className="text-sm">{plan.summary}</p><ul className="space-y-2 text-sm">{(plan.includes || []).map(feature => <li key={feature} className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-emerald-600" />{feature}</li>)}</ul><Button className="w-full" variant={plan.id === tier?.id ? 'outline' : 'default'} disabled={!profileId || !account || request.isPending || plan.id === tier?.id || plan.id === pending?.tier_id} onClick={() => request.mutate(plan.id)}>{plan.id === tier?.id ? 'Current plan' : plan.id === pending?.tier_id ? 'Request pending' : `Request ${plan.name}`}</Button></CardContent></Card>)}</div>}
      {request.isError && <p role="alert">{request.error?.message || 'Your request could not be saved. Please try again.'}</p>}
      {request.isSuccess && <p role="status">Plan request saved. No charge has been made.</p>}
    </section>}
    {!native && <section className="space-y-5"><div><h2 className="text-2xl font-semibold">Add the expertise you need</h2><p className="mt-2 text-muted-foreground">Focused services for your next application. Review the full scope, price and terms before checkout.</p></div>
      {services.isPending ? <p>Loading add-ons…</p> : services.isError || services.data?.degraded ? <p role="alert">Add-on pricing is unavailable. <button className="underline" onClick={() => services.refetch()}>Try again</button></p> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{(services.data?.catalog || []).map(service => { const price = serviceStartingPrice(service); return <Card key={service.slug}><CardHeader><CardTitle className="text-lg">{service.name}</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-sm text-muted-foreground">{service.description}</p><p className="text-xl font-semibold">{price === null ? 'Price available on request' : `From ${money(price)}`}{service.pricing_model === 'hourly' && <span className="text-sm font-normal"> / 6-minute unit</span>}</p>{service.pricing_model === 'milestone' && <p className="text-xs text-muted-foreground">Total project price, paid in milestones.</p>}<Button asChild variant="outline"><Link to={`/Services?service=${encodeURIComponent(service.slug)}${profileId ? `&profile_id=${encodeURIComponent(profileId)}` : ''}`}>View service & pricing <ArrowUpRight className="ml-2 h-4 w-4" /></Link></Button></CardContent></Card>})}</div>}
    </section>}
  </div>
}

export default function Account() {
  const user = useAuthStore(state => state.user)
  const userId = user?.id || user?.userId
  const email = user?.primary_email || user?.email || ''
  const [selected, setSelected] = useState('')
  const profiles = useQuery({ queryKey: ['account-workspaces', userId], queryFn: () => listProfiles({ scope: 'mine', limit: 1000 }), enabled: !!userId })
  const workspaces = (Array.isArray(profiles.data) ? profiles.data : []).filter(p => p.status !== 'deleted')
  const profileId = workspaces.some(p => p.id === selected) ? selected : workspaces[0]?.id || null
  const reset = useMutation({ mutationFn: () => startPasswordReset(email) })
  return <div className="mx-auto max-w-7xl space-y-8 p-4 md:p-8">
    <header className="rounded-2xl bg-gradient-to-br from-emerald-950 via-emerald-900 to-teal-800 p-6 text-white md:p-10"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-200">Your GrantFlow account</p><h1 className="mt-3 text-3xl font-semibold md:text-4xl">Your goals. Your plan.</h1><p className="mt-3 max-w-2xl text-emerald-100">Manage your membership, payments and account security in one place.</p></header>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" />Account & security</CardTitle></CardHeader><CardContent className="flex flex-wrap items-start justify-between gap-6"><div className="space-y-1"><p className="font-medium">{user?.full_name || user?.display_name || 'Your account'}</p><p className="text-sm text-muted-foreground">Login email</p><p className="break-all">{email || 'No login email is available.'}</p><p className="pt-2 text-sm text-muted-foreground">Use a secure email link to change or set your password.</p>{reset.isSuccess && <p role="status">{reset.data?.notice || (reset.data?.email_sent === false ? 'Email delivery is delayed. Please try again shortly.' : 'Check your login email for the password-change link.')}</p>}{reset.isError && <p role="alert">{reset.error?.message || 'The password-change email could not be sent.'}</p>}</div><div className="flex flex-wrap gap-3"><Button variant="outline" disabled={!email || reset.isPending} onClick={() => reset.mutate()}>{reset.isPending ? 'Sending…' : 'Change password'}</Button><LogoutButton /></div></CardContent></Card>
    {profiles.isError ? <p role="alert">Your billing workspaces could not be loaded. <button className="underline" onClick={() => profiles.refetch()}>Try again</button></p> : profiles.isPending ? <p>Loading your account…</p> : <>
      {workspaces.length > 1 && <div className="max-w-md space-y-2"><label htmlFor="account-workspace" className="text-sm font-medium">Billing workspace</label><select id="account-workspace" className="w-full rounded-md border border-input bg-background p-3" value={profileId || ''} onChange={event => setSelected(event.target.value)}>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.display_name}</option>)}</select></div>}
      {!workspaces.length && <p>No billing workspace is linked to your account yet.</p>}
      <AccountBilling key={`${userId}:${profileId}`} profileId={profileId} userId={userId} native={isNativeApp()} />
    </>}
  </div>
}
