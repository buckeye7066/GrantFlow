import React, { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Send, Mail, MessageSquare, Megaphone, Phone, Plus } from 'lucide-react'
import {
  listBroadcastRecipients,
  sendBroadcast,
  addProfilePhone,
  setEmailProxy,
} from '@/api/comms'

/** Per-profile resolved channel under the "auto" policy. */
function autoChannelFor(r) {
  if (r.has_usable_email) return 'email'
  if (r.sms_phone) return 'sms'
  return 'none'
}

function RecipientRow({ r, selected, onToggle, channel, onAddPhone, onToggleProxy, busy }) {
  const [newPhone, setNewPhone] = useState('')
  const auto = autoChannelFor(r)
  const effective = channel === 'auto' ? auto : channel
  const reachable = effective === 'email'
    ? r.emails.some((e) => !e.is_proxy)
    : effective === 'sms'
      ? Boolean(r.sms_phone)
      : auto !== 'none'

  return (
    <tr className="border-b border-slate-100 align-top">
      <td className="p-2">
        <Checkbox checked={selected} onCheckedChange={() => onToggle(r.profile_id)} disabled={!reachable} />
      </td>
      <td className="p-2">
        <div className="font-medium text-slate-800">{r.display_name || r.profile_id}</div>
        <div className="text-[11px] text-slate-400">
          {effective === 'email' ? 'will email' : effective === 'sms' ? 'will text' : 'no reachable channel'}
        </div>
      </td>
      <td className="p-2">
        {r.emails.length === 0 ? <span className="text-xs text-slate-400">—</span> : (
          <div className="space-y-1">
            {r.emails.map((e) => (
              <div key={e.email} className="flex items-center gap-2 text-xs">
                <span className={e.is_proxy ? 'text-slate-400 line-through' : 'text-slate-700'}>{e.email}</span>
                {e.is_proxy ? <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300">proxy</Badge> : null}
                <button
                  type="button"
                  className="text-[10px] text-blue-600 hover:underline"
                  disabled={busy}
                  onClick={() => onToggleProxy(r.profile_id, e.email, !e.is_proxy)}
                >
                  {e.is_proxy ? 'unmark proxy' : "not user's own"}
                </button>
              </div>
            ))}
          </div>
        )}
      </td>
      <td className="p-2">
        {r.phones.length > 0 ? (
          <div className="space-y-1">
            {r.phones.map((p) => (
              <div key={p.phone} className="flex items-center gap-2 text-xs">
                <Phone className="w-3 h-3 text-slate-400" />
                <span className="text-slate-700">{p.phone}</span>
                {p.opt_in
                  ? <Badge className="bg-emerald-500 text-white text-[10px]">SMS opted-in</Badge>
                  : <Badge variant="outline" className="text-[10px] text-slate-400">not opted in</Badge>}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Input
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="Add cell #"
              className="h-7 w-28 text-xs"
            />
            <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy || !newPhone.trim()}
              onClick={() => { onAddPhone(r.profile_id, newPhone.trim()); setNewPhone('') }}>
              <Plus className="w-3 h-3" />
            </Button>
          </div>
        )}
      </td>
    </tr>
  )
}

export default function AdminBroadcast() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState(() => new Set())
  const [channel, setChannel] = useState('auto')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')

  const recipientsQuery = useQuery({
    queryKey: ['broadcast-recipients'],
    queryFn: listBroadcastRecipients,
  })
  const recipients = recipientsQuery.data?.recipients ?? []

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const reachableIds = useMemo(() => recipients.filter((r) => {
    if (channel === 'email') return r.emails.length > 0
    if (channel === 'sms') return Boolean(r.sms_phone)
    return autoChannelFor(r) !== 'none'
  }).map((r) => r.profile_id), [recipients, channel])

  const allSelected = reachableIds.length > 0 && reachableIds.every((id) => selected.has(id))
  const toggleAll = () => setSelected(() => allSelected ? new Set() : new Set(reachableIds))

  const mutate = useMutation({
    mutationFn: ({ fn, args }) => fn(args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['broadcast-recipients'] }),
  })
  const busy = mutate.isPending

  const handleAddPhone = (profileId, phone) =>
    mutate.mutate({ fn: addProfilePhone, args: { profileId, phone, optIn: true } }, {
      onSuccess: () => { toast({ title: 'Phone added (opted in)' }); queryClient.invalidateQueries({ queryKey: ['broadcast-recipients'] }) },
      onError: (e) => toast({ variant: 'destructive', title: 'Could not add phone', description: e?.message }),
    })
  const handleToggleProxy = (profileId, email, isProxy) =>
    mutate.mutate({ fn: setEmailProxy, args: { profileId, email, isProxy } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['broadcast-recipients'] }),
      onError: (e) => toast({ variant: 'destructive', title: 'Could not update email', description: e?.message }),
    })

  const sendMutation = useMutation({
    mutationFn: () => sendBroadcast({ profileIds: [...selected], channel, subject: subject || null, body }),
    onSuccess: (res) => {
      toast({
        title: 'Broadcast sent',
        description: `Email: ${res.sent_email} · SMS: ${res.sent_sms}${res.failed ? ` · ${res.failed} not reached` : ''}`,
      })
      setSelected(new Set())
    },
    onError: (e) => toast({ variant: 'destructive', title: 'Send failed', description: e instanceof Error ? e.message : 'Try again.' }),
  })

  const canSend = selected.size > 0 && body.trim() && (channel === 'sms' || subject.trim())

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Megaphone className="w-5 h-5 text-blue-600" /> Broadcast / Notifications
          </CardTitle>
          <CardDescription>
            Send promotions, product changes, or notices to your profiles. Email is sent from{' '}
            <span className="font-medium">Annie@axiombiolabs.org</span>. SMS goes only to numbers that
            have opted in. Pick a channel, choose recipients, and send.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[160px_1fr]">
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Channel</label>
              <Select value={channel} onValueChange={(v) => { setChannel(v); setSelected(new Set()) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto"><span className="flex items-center gap-2"><Send className="w-3.5 h-3.5" /> Auto (email, else SMS)</span></SelectItem>
                  <SelectItem value="email"><span className="flex items-center gap-2"><Mail className="w-3.5 h-3.5" /> Email only</span></SelectItem>
                  <SelectItem value="sms"><span className="flex items-center gap-2"><MessageSquare className="w-3.5 h-3.5" /> SMS only</span></SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Subject {channel === 'sms' ? '(ignored for SMS)' : ''}</label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. New feature: weekly funding digests" disabled={channel === 'sms'} />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Message</label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your announcement…" className="min-h-[140px]" />
            {channel === 'sms' ? <p className="text-[11px] text-slate-400">SMS is sent as plain text and truncated to ~600 characters.</p> : null}
          </div>
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500">{selected.size} recipient{selected.size === 1 ? '' : 's'} selected</p>
            <Button onClick={() => sendMutation.mutate()} disabled={!canSend || sendMutation.isPending} className="gap-2">
              {sendMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send broadcast
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recipients</CardTitle>
          <CardDescription>
            Tick the profiles to include. Rows with no reachable channel for the chosen mode are disabled.
            Mark an email as a proxy (belongs to someone else) to route that profile to SMS, and add a
            cell number with consent to enable texting.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recipientsQuery.isLoading ? (
            <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="p-2 w-10">
                      <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all" />
                    </th>
                    <th className="p-2">Profile</th>
                    <th className="p-2">Email</th>
                    <th className="p-2">Cell / SMS</th>
                  </tr>
                </thead>
                <tbody>
                  {recipients.map((r) => (
                    <RecipientRow
                      key={r.profile_id}
                      r={r}
                      selected={selected.has(r.profile_id)}
                      onToggle={toggle}
                      channel={channel}
                      onAddPhone={handleAddPhone}
                      onToggleProxy={handleToggleProxy}
                      busy={busy}
                    />
                  ))}
                  {recipients.length === 0 ? (
                    <tr><td colSpan={4} className="p-6 text-center text-slate-400">No profiles found.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
