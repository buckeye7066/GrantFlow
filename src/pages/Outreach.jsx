import React, { useState } from "react"
import { Megaphone, Users, Mail, Phone, Calendar, TrendingUp, FileText, Plus, Search } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default function Outreach() {
  const [searchQuery, setSearchQuery] = useState("")

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
              <Megaphone className="w-8 h-8" />
              Outreach Hub
            </h1>
            <p className="text-slate-600 mt-2">
              Manage funder relationships, track touchpoints, and coordinate outreach campaigns
            </p>
          </div>
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            New Campaign
          </Button>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">Active Campaigns</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">Funder Contacts</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">Recent Touchpoints</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">Follow-ups Due</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
            </CardContent>
          </Card>
        </div>

        {/* Main Content Tabs */}
        <Tabs defaultValue="campaigns" className="space-y-4">
          <TabsList>
            <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
            <TabsTrigger value="contacts">Contacts</TabsTrigger>
            <TabsTrigger value="touchpoints">Touchpoints</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
          </TabsList>

          <TabsContent value="campaigns" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Campaign Dashboard</CardTitle>
                <CardDescription>
                  Track outreach campaigns across grants, sponsorships, and donor pipelines
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-center py-12">
                  <TrendingUp className="w-12 h-12 mx-auto text-slate-300 mb-4" />
                  <h3 className="text-lg font-semibold text-slate-900 mb-2">No campaigns yet</h3>
                  <p className="text-slate-600 mb-4">Create your first outreach campaign to get started</p>
                  <Button>
                    <Plus className="w-4 h-4 mr-2" />
                    Create Campaign
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="contacts" className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex justify-between items-center">
                  <div>
                    <CardTitle>Funder Contact List</CardTitle>
                    <CardDescription>
                      Manage relationships with grant funders and program officers
                    </CardDescription>
                  </div>
                  <Button variant="outline" className="gap-2">
                    <Plus className="w-4 h-4" />
                    Add Contact
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      placeholder="Search contacts..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                  <div className="text-center py-12">
                    <Users className="w-12 h-12 mx-auto text-slate-300 mb-4" />
                    <p className="text-slate-600">No contacts found</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="touchpoints" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Communication Log</CardTitle>
                <CardDescription>
                  Track calls, emails, and meetings with funders
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-center py-12">
                  <Calendar className="w-12 h-12 mx-auto text-slate-300 mb-4" />
                  <h3 className="text-lg font-semibold text-slate-900 mb-2">No touchpoints logged</h3>
                  <p className="text-slate-600 mb-4">Start tracking your funder communications</p>
                  <div className="flex gap-2 justify-center">
                    <Button variant="outline" size="sm">
                      <Mail className="w-4 h-4 mr-2" />
                      Log Email
                    </Button>
                    <Button variant="outline" size="sm">
                      <Phone className="w-4 h-4 mr-2" />
                      Log Call
                    </Button>
                    <Button variant="outline" size="sm">
                      <Calendar className="w-4 h-4 mr-2" />
                      Log Meeting
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="templates" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Email Templates</CardTitle>
                <CardDescription>
                  Pre-written templates for funder communications
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <Card className="border-2 border-dashed">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-semibold text-sm">Initial Inquiry</h4>
                          <p className="text-xs text-slate-600">First contact with potential funder</p>
                        </div>
                        <Badge variant="secondary">Template</Badge>
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="border-2 border-dashed">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-semibold text-sm">Follow-up</h4>
                          <p className="text-xs text-slate-600">Following up on submitted application</p>
                        </div>
                        <Badge variant="secondary">Template</Badge>
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="border-2 border-dashed">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-semibold text-sm">Thank You</h4>
                          <p className="text-xs text-slate-600">Gratitude for awarded grant</p>
                        </div>
                        <Badge variant="secondary">Template</Badge>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
