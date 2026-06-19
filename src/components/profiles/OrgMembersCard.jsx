import React, { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Users, Plus, Trash2, AlertTriangle } from "lucide-react"
import { apiFetch } from "@/api/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"

/**
 * OrgMembersCard
 *
 * Manage the email logins ("seats") on an organization profile. The billing
 * tier is derived from the seat count (small=1, mid=2-5, large=6+); when adding
 * a login would bump the org into a higher tier the backend returns 409 and we
 * show a confirm dialog before proceeding.
 */
export default function OrgMembersCard({ profileId }) {
  const { toast } = useToast()
  const qc = useQueryClient()
  const [email, setEmail] = useState("")
  const [confirm, setConfirm] = useState(null) // { warning, tier_change }

  const { data, isLoading } = useQuery({
    queryKey: ["profile-emails", profileId],
    queryFn: () => apiFetch(`/api/profiles/${profileId}/emails`),
    enabled: Boolean(profileId),
  })
  const emails = Array.isArray(data?.emails) ? data.emails : []
  const tier = data?.seat_tier

  const invalidate = () => qc.invalidateQueries({ queryKey: ["profile-emails", profileId] })

  const add = useMutation({
    mutationFn: ({ value, doConfirm }) =>
      apiFetch(`/api/profiles/${profileId}/emails`, {
        method: "POST",
        body: JSON.stringify({ email: value, confirm: doConfirm === true }),
      }),
    onSuccess: (res) => {
      setEmail(""); setConfirm(null)
      toast({
        title: "Login added",
        description: res?.tier_changed
          ? `Organization is now ${res?.seat_tier?.label} (${res?.seat_tier?.seats} seats).`
          : undefined,
      })
      invalidate()
    },
    onError: (err) => {
      // Backend asks for confirmation when the add crosses a billing tier (409).
      const body = err?.details
      if (err?.status === 409 || body?.requires_confirmation) {
        setConfirm({ warning: body?.warning || "This change moves the organization to a higher billing tier.", tier_change: body?.tier_change })
        return
      }
      toast({ title: "Could not add login", description: err?.message, variant: "destructive" })
    },
  })

  const remove = useMutation({
    mutationFn: (emailId) => apiFetch(`/api/profiles/${profileId}/emails/${emailId}`, { method: "DELETE" }),
    onSuccess: () => { toast({ title: "Login removed" }); invalidate() },
    onError: (err) => toast({ title: "Could not remove", description: err?.message, variant: "destructive" }),
  })

  const submit = () => {
    const v = email.trim()
    if (!v) return
    add.mutate({ value: v, doConfirm: false })
  }

  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Users className="h-5 w-5 text-emerald-600" /> Team logins &amp; billing tier</span>
          {tier ? (
            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
              {tier.label} · {tier.seats} seat{tier.seats === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-600">
          Add the people who should have access to this organization’s profile by email. Your billing tier follows the
          number of logins: <strong>1 = small</strong>, <strong>2–5 = mid-sized</strong>, <strong>6+ = large</strong>.
          {tier?.seats_until_next_tier
            ? ` ${tier.seats_until_next_tier} more login${tier.seats_until_next_tier === 1 ? "" : "s"} would move you to ${tier.next_tier_label}.`
            : ""}
        </p>

        <div className="flex gap-2">
          <Input
            type="email"
            placeholder="name@organization.org"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit() }}
          />
          <Button onClick={submit} disabled={add.isPending || !email.trim()}>
            <Plus className="mr-1 h-4 w-4" /> Add
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : emails.length === 0 ? (
          <p className="text-sm text-slate-500">No additional logins yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {emails.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="truncate text-sm text-slate-800">{e.email}</span>
                <Button
                  size="sm" variant="ghost" className="h-7 px-2 text-rose-600 hover:text-rose-700"
                  onClick={() => remove.mutate(e.id)} disabled={remove.isPending} aria-label={`Remove ${e.email}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Tier-change confirmation */}
      <Dialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" /> This changes your billing tier
            </DialogTitle>
            <DialogDescription>{confirm?.warning}</DialogDescription>
          </DialogHeader>
          {confirm?.tier_change ? (
            <Alert>
              <AlertDescription className="text-sm">
                {confirm.tier_change.from_tier_label} ({confirm.tier_change.from_seats} seats) →{" "}
                <strong>{confirm.tier_change.to_tier_label}</strong> ({confirm.tier_change.to_seats} seats)
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={add.isPending}>Cancel</Button>
            <Button onClick={() => add.mutate({ value: email.trim(), doConfirm: true })} disabled={add.isPending}>
              {add.isPending ? "Adding…" : "Add login & upgrade tier"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
