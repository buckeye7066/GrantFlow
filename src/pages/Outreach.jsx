import React, { useState } from "react"
import { Megaphone, Users, Mail, Phone, Calendar, Plus, Search } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/api/client"
import { useToast } from "@/components/ui/use-toast"

export default function Outreach() {
  const [searchQuery, setSearchQuery] = useState("")
  const { toast } = useToast()

  // Fetch grants to show funder contacts
  const { data: grants = [] } = useQuery({
    queryKey: ['grants'],
    queryFn: () => apiFetch('/api/grants'),
    staleTime: 60_000,
  })

  // Extract unique funders from grants
  const funders = React.useMemo(() => {
    const funderMap = new Map()
    grants.forEach(grant => {
      if (grant.funder) {
        if (!funderMap.has(grant.funder)) {
          funderMap.set(grant.funder, {
            name: grant.funder,
            email: grant.funder_email || null,
            phone: grant.funder_phone || null,
            grants: []
          })
        }
        funderMap.get(grant.funder).grants.push(grant)
      }
    })
    return Array.from(funderMap.values())
  }, [grants])

  const filteredFunders = funders.filter(funder => 
    !searchQuery || funder.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

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
                <div className="text-center py-12">
                  <Calendar className="w-12 h-12 mx-auto text-slate-300 mb-4" />
                  <p className="text-slate-600">Communication logging feature</p>
                  <div className="flex gap-2 justify-center mt-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        toast({
                          title: "Coming soon",
                          description: "Logging email interactions is under development.",
                        })
                      }
                    >
                      <Mail className="w-4 h-4 mr-2" />
                      Log Email
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        toast({
                          title: "Coming soon",
                          description: "Logging calls is under development.",
                        })
                      }
                    >
                      <Phone className="w-4 h-4 mr-2" />
                      Log Call
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        toast({
                          title: "Coming soon",
                          description: "Logging meetings is under development.",
                        })
                      }
                    >
                      <Calendar className="w-4 h-4 mr-2" />
                      Log Meeting
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
