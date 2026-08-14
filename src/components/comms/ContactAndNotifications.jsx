import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Send, MessageSquare, Phone } from 'lucide-react'
import { contactOwner, getProfileContacts, setMySmsOptIn } from '@/api/comms'

/**
 * User-facing "Email the GrantFlow team" form plus self-serve SMS opt-in,
 * scoped to the active profile. Email goes to the owner alias with reply-to set
 * to the user. SMS opt-in lets the user add a cell number and turn text
 * notifications on/off — texts are only ever sent to opted-in numbers.
 */
export default function ContactAndNotifications({ profileId }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [newPhone, setNewPhone] = useState('')

  const contactsQuery = useQuery({
    queryKey: ['profile-contacts', profileId],
    queryFn: () => getProfileContacts(profileId),
    enabled: Boolean(profileId) && profileId !== '__admin__',
  })
  const phones = contactsQuery.data?.phones ?? []

  const sendMutation = useMutation({
    mutationFn: () => contactOwner({ profileId, subject: subject || null, message }),
    onSuccess: () => {
      toast({ title: 'Message sent', description: 'The GrantFlow team will get back to you.' })
      setSubject(''); setMessage('')
    },
    onError: (e) => toast({ variant: 'destructive', title: 'Could not send', description: e instanceof Error ? e.message : 'Try again.' }),
  })

  const optMutation = useMutation({
    mutationFn: ({ phone, optIn }) => setMySmsOptIn(profileId, { phone, optIn }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile-contacts', profileId] })
      setNewPhone('')
    },
    onError: (e) => toast({ variant: 'destructive', title: 'Could not update SMS preference', description: e?.message }),
  })

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Send className="w-4 h-4 text-blue-600" /> Message the GrantFlow team</CardTitle>
          <CardDescription>Questions, requests, or anything else — this reaches us directly and we'll reply to your email.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject (optional)" />
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="How can we help?" className="min-h-[120px]" />
          <div className="flex justify-end">
            <Button onClick={() => sendMutation.mutate()} disabled={!profileId || !message.trim() || sendMutation.isPending} className="gap-2">
              {sendMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><MessageSquare className="w-4 h-4 text-emerald-600" /> Text message notifications</CardTitle>
          <CardDescription>Opt in to receive GrantFlow notifications by text. You can turn this off anytime.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {phones.length > 0 ? (
            phones.map((p) => (
              <div key={p.phone} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                <span className="flex items-center gap-2 text-sm text-slate-700"><Phone className="w-3.5 h-3.5 text-slate-400" /> {p.phone}</span>
                <div className="flex items-center gap-2">
                  {p.opt_in ? <Badge className="bg-emerald-500 text-white text-[10px]">On</Badge> : <Badge variant="outline" className="text-[10px] text-slate-400">Off</Badge>}
                  <Switch checked={Boolean(p.opt_in)} disabled={optMutation.isPending}
                    onCheckedChange={(checked) => optMutation.mutate({ phone: p.phone, optIn: checked })} />
                </div>
              </div>
            ))
          ) : (
            <p className="text-xs text-slate-400">No phone on file yet. Add a number to receive text notifications.</p>
          )}
          <div className="flex items-center gap-2">
            <Input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Add a cell number" className="h-9" />
            <Button variant="outline" disabled={!newPhone.trim() || optMutation.isPending}
              onClick={() => optMutation.mutate({ phone: newPhone.trim(), optIn: true })}>
              Opt in
            </Button>
          </div>
          <p className="text-[11px] text-slate-400">Message &amp; data rates may apply. Opting in means you agree to receive automated texts from GrantFlow; reply STOP to opt out at any time.</p>
        </CardContent>
      </Card>
    </div>
  )
}
