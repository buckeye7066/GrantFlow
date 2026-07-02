import React, { useMemo, useState } from "react"
import { Megaphone, Users, Mail, Phone, Calendar, Plus, Search } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/api/client"
import { useToast } from "@/components/ui/use-toast"
import { useAuthStore } from "@/stores/authStore"

export default function Outreach() {
  const [searchQuery, setSearchQuery] = useState("")
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const activeProfileId = useAuthStore((state) => state.activeProfileId)

  const [logDialogOpen, setLogDialogOpen] = useState(false)
  const [logMethod, setLogMethod] = useState("email")
  const [logFunder, setLogFunder] = useState("")
  const [logOccurredAt, setLogOccurredAt] = useState(() => new Date().toISOString().slice(0, 10))
  const [logSubject, setLogSubject] = useState("")
  const [logNotes, setLogNotes] = useState("")

  // Fetch grants to show funder contacts
  const { data: grants = [] } = useQuery({
    queryKey: ['grants', activeProfileId],
    enabled: Boolean(activeProfileId),
    queryFn: () =>
      apiFetch('/api/grants', {
        headers: { 'X-Profile-Id': activeProfileId },
      }),
    staleTime: 60_000,
  })

  // Extract unique funders from grants
  const funders = useMemo(() => {
    const funderMap = new Map()
    grants.forEach(grant => {
      if (grant.funder) {
        if (!funderMap.has(grant.funder)) {
          funderMap.set(grant.funder, {
            name: grant.funder,
            email: grant.contact_email || null,
            phone: grant.contact_phone || null,
            grants: []
          })
        }
        funderMap.get(grant.funder).grants.push(grant)
      }
    })
    return Array.from(funderMap.values())
  }, [grants])

  const outreachLogsQuery = useQuery({
    queryKey: ['outreachLogs', activeProfileId],
    enabled: Boolean(activeProfileId),
    queryFn: () =>
  apiFetch('/api/outreach-logs', {
    headers: { 'X-Profile-Id': activeProfileId },
  }),
    staleTime: 15_000,
  })

  const createLogMutation = useMutation({
    mutationFn: async (payload) => {
      return apiFetch('/api/outreach-logs', {
        method: 'POST',
        headers: { 'X-Profile-Id': activeProfileId },
        body: JSON.stringify(payload),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['outreachLogs', activeProfileId] })
    },
  })

  const filteredFunders = funders.filter(funder => 
    !searchQuery || funder.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const logs = outreachLogsQuery.data?.items ?? []

  const openLogDialog = (method) => {
    if (!activeProfileId) {
      toast({
        title: 'Select a profile first',
        description: 'Please select a profile to log outreach.',
        variant: 'destructive',
      })
      return
    }
    setLogMethod(method)
    setLogFunder(funders.length === 1 ? funders[0].name : "")
    setLogDialogOpen(true)
  }

  const submitLog = async () => {
    if (!activeProfileId) return
    const funder = String(logFunder || '').trim()
    if (!funder) {
      toast({ title: 'Funder required', description: 'Please select a funder before saving.', variant: 'destructive' })
      return
    }

    try {
      await createLogMutation.mutateAsync({
        profile_id: activeProfileId,
        funder,
        method: logMethod,
        occurred_at: logOccurredAt ? new Date(logOccurredAt).toISOString() : null,
        subject: logSubject || null,
        notes: logNotes || null,
      })

      toast({ title: 'Saved', description: 'Your outreach log was added.' })
      setLogDialogOpen(false)
      setLogFunder("")
      setLogOccurredAt(new Date().toISOString().slice(0, 10))
      setLogSubject("")
      setLogNotes("")
    } catch (error) {
      toast({
        title: 'Failed to save',
        description: error?.message || 'Unable to save outreach log.',
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
              <Megaphone className="w-8 h-8" />
              Outreach Hub
            </h1>
            <p className="text-slate-600 mt-2">
              Manage funder relationships and track communications
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">Funder Contacts</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{funders.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">Active Grants</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {grants.filter(g => ['submitted', 'under_review', 'awarded'].includes(g.status)).length}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">Total Grants</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{grants.length}</div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="contacts" className="space-y-4">
          <TabsList>
            <TabsTrigger value="contacts">Funder Contacts</TabsTrigger>
            <TabsTrigger value="touchpoints">Communication Log</TabsTrigger>
          </TabsList>

          <TabsContent value="contacts" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Funder Contacts</CardTitle>
                <CardDescription>
                  Funders from your grant pipeline
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      placeholder="Search funders..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                  
                  {filteredFunders.length > 0 ? (
                    <div className="space-y-2">
                      {filteredFunders.map((funder, index) => (
                        <Card key={index} className="border">
                          <CardContent className="p-4">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                  <Users className="w-4 h-4 text-slate-500" />
                                  <h3 className="font-semibold text-slate-900">{funder.name}</h3>
                                </div>
                                <div className="space-y-1 text-sm text-slate-600">
                                  {funder.email && (
                                    <div className="flex items-center gap-2">
                                      <Mail className="w-3 h-3" />
                                      <a href={`mailto:${funder.email}`} className="hover:text-blue-600">
                                        {funder.email}
                                      </a>
                                    </div>
                                  )}
                                  {funder.phone && (
                                    <div className="flex items-center gap-2">
                                      <Phone className="w-3 h-3" />
                                      <a href={`tel:${funder.phone}`} className="hover:text-blue-600">
                                        {funder.phone}
                                      </a>
                                    </div>
                                  )}
                                  <div className="text-xs text-slate-500 mt-2">
                                    {funder.grants.length} grant{funder.grants.length !== 1 ? 's' : ''} in pipeline
                                  </div>
                                </div>
                              </div>
                              <Button variant="ghost" size="sm">
                                <Calendar className="w-4 h-4" />
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <Users className="w-12 h-12 mx-auto text-slate-300 mb-4" />
                      <p className="text-slate-600">
                        {searchQuery ? 'No funders match your search' : 'No funders found in your pipeline'}
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="touchpoints" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Communication Log</CardTitle>
                <CardDescription>
                  Track interactions with funders
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 justify-between">
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => openLogDialog("email")}>
                      <Mail className="w-4 h-4 mr-2" />
                      Log Email
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openLogDialog("call")}>
                      <Phone className="w-4 h-4 mr-2" />
                      Log Call
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openLogDialog("meeting")}>
                      <Calendar className="w-4 h-4 mr-2" />
                      Log Meeting
                    </Button>
                  </div>
                  <div className="text-sm text-slate-500">
                    {outreachLogsQuery.isLoading ? 'Loading…' : `${logs.length} logged interaction${logs.length === 1 ? '' : 's'}`}
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  {logs.length === 0 ? (
                    <div className="text-center py-10">
                      <Calendar className="w-12 h-12 mx-auto text-slate-300 mb-4" />
                      <p className="text-slate-600">No outreach logged yet.</p>
                      <p className="text-slate-500 text-sm mt-1">Use the buttons above to log emails, calls, and meetings.</p>
                    </div>
                  ) : (
                    logs.map((item) => (
                      <Card key={item.id} className="border">
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-slate-900 truncate">{item.funder}</span>
                                <span className="text-xs text-slate-500 uppercase tracking-wide">{item.method}</span>
                              </div>
                              {item.subject ? (
                                <div className="text-sm text-slate-700 mt-1">{item.subject}</div>
                              ) : null}
                              {item.notes ? (
                                <div className="text-sm text-slate-600 mt-1 whitespace-pre-wrap">{item.notes}</div>
                              ) : null}
                            </div>
                            <div className="text-xs text-slate-500 whitespace-nowrap">
                              {(() => {
                                const raw = item.occurred_at || item.created_at
                                const d = raw ? new Date(raw) : null
                                return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString() : ''
                              })()}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={logDialogOpen} onOpenChange={setLogDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Log {logMethod === 'call' ? 'Call' : logMethod === 'meeting' ? 'Meeting' : 'Email'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Funder</Label>
              <Select value={logFunder} onValueChange={setLogFunder}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a funder" />
                </SelectTrigger>
                <SelectContent>
                  {funders.map((funder) => (
                    <SelectItem key={funder.name} value={funder.name}>
                      {funder.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Date</Label>
              <Input
                type="date"
                value={logOccurredAt}
                onChange={(e) => setLogOccurredAt(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label>Subject (optional)</Label>
              <Input
                value={logSubject}
                onChange={(e) => setLogSubject(e.target.value)}
                placeholder="Brief summary"
              />
            </div>

            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea
                value={logNotes}
                onChange={(e) => setLogNotes(e.target.value)}
                placeholder="What happened? Next steps?"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setLogDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={submitLog} disabled={createLogMutation.isPending}>
                {createLogMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
