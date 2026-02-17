import React, { useState, useMemo } from "react"
import { HandCoins, Search, Mail, Phone, MapPin, Building2, DollarSign, Calendar, TrendingUp } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/api/client"
import { Link } from "react-router-dom"
import { createPageUrl, formatAddress } from "@/utils"

export default function Funder() {
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedType, setSelectedType] = useState("all")

  const normalizeList = (value) => {
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') {
      if (Array.isArray(value.data)) return value.data
      if (Array.isArray(value.items)) return value.items
      if (Array.isArray(value.opportunities)) return value.opportunities
      if (Array.isArray(value.grants)) return value.grants
    }
    return []
  }

  const { data: grants = [] } = useQuery({
    queryKey: ['grants'],
    queryFn: async () => normalizeList(await apiFetch('/api/grants')),
    staleTime: 60_000,
  })

  const { data: opportunities = [] } = useQuery({
    queryKey: ['opportunities'],
    queryFn: async () => normalizeList(await apiFetch('/api/opportunities')),
    staleTime: 60_000,
  })

  // Extract unique funders from grants and opportunities
  const funders = useMemo(() => {
    const funderMap = new Map()

    // Add funders from grants
    grants.forEach(grant => {
      if (grant.funder) {
        if (!funderMap.has(grant.funder)) {
          funderMap.set(grant.funder, {
            name: grant.funder,
            email: grant.funder_email || null,
            phone: grant.funder_phone || null,
            address: grant.funder_address || null,
            grants: [],
            opportunities: [],
            totalAwarded: 0,
            activeGrants: 0,
          })
        }
        const funder = funderMap.get(grant.funder)
        funder.grants.push(grant)
        if (grant.status === 'awarded' && grant.amount_awarded) {
          funder.totalAwarded += grant.amount_awarded
        }
        if (['submitted', 'under_review', 'awarded'].includes(grant.status)) {
          funder.activeGrants++
        }
      }
    })

    // Add funders from opportunities
    opportunities.forEach(opp => {
      if (opp.funder) {
        if (!funderMap.has(opp.funder)) {
          funderMap.set(opp.funder, {
            name: opp.funder,
            email: null,
            phone: null,
            address: null,
            grants: [],
            opportunities: [],
            totalAwarded: 0,
            activeGrants: 0,
          })
        }
        funderMap.get(opp.funder).opportunities.push(opp)
      }
    })

    return Array.from(funderMap.values()).sort((a, b) => 
      b.totalAwarded - a.totalAwarded || b.grants.length - a.grants.length
    )
  }, [grants, opportunities])

  const filteredFunders = useMemo(() => {
    let filtered = funders

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(f => 
        f.name.toLowerCase().includes(query) ||
        f.email?.toLowerCase().includes(query)
      )
    }

    if (selectedType === 'awarded') {
      filtered = filtered.filter(f => f.totalAwarded > 0)
    } else if (selectedType === 'active') {
      filtered = filtered.filter(f => f.activeGrants > 0)
    } else if (selectedType === 'opportunities') {
      filtered = filtered.filter(f => f.opportunities.length > 0)
    }

    return filtered
  }, [funders, searchQuery, selectedType])

  const stats = useMemo(() => ({
    total: funders.length,
    withAwards: funders.filter(f => f.totalAwarded > 0).length,
    withActiveGrants: funders.filter(f => f.activeGrants > 0).length,
    totalAwarded: funders.reduce((sum, f) => sum + f.totalAwarded, 0),
  }), [funders])

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <HandCoins className="w-8 h-8" />
            Funder Directory
          </h1>
          <p className="text-slate-600 mt-2">
            Track funder relationships, grant history, and funding opportunities
          </p>
        </div>

        <div className="grid md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">Total Funders</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">With Awards</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.withAwards}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">Active Relationships</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.withActiveGrants}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">Total Awarded</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">${stats.totalAwarded.toLocaleString()}</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Funder Search</CardTitle>
            <CardDescription>Find and manage funder relationships</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search funders by name or email..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Tabs value={selectedType} onValueChange={setSelectedType} className="w-auto">
                <TabsList>
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="awarded">Awarded</TabsTrigger>
                  <TabsTrigger value="active">Active</TabsTrigger>
                  <TabsTrigger value="opportunities">Opportunities</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardContent>
        </Card>

        {filteredFunders.length > 0 ? (
          <div className="space-y-3">
            {filteredFunders.map((funder, index) => (
              <Card key={index} className="hover:border-blue-200 transition-colors">
                <CardContent className="p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-3">
                        <Building2 className="w-5 h-5 text-slate-500" />
                        <h3 className="text-lg font-semibold text-slate-900">{funder.name}</h3>
                        {funder.totalAwarded > 0 && (
                          <Badge variant="default" className="bg-green-600">
                            ${funder.totalAwarded.toLocaleString()} awarded
                          </Badge>
                        )}
                      </div>

                      <div className="grid md:grid-cols-2 gap-4 mb-4">
                        {funder.email && (
                          <div className="flex items-center gap-2 text-sm">
                            <Mail className="w-4 h-4 text-slate-400" />
                            <a href={`mailto:${funder.email}`} className="text-blue-600 hover:underline">
                              {funder.email}
                            </a>
                          </div>
                        )}
                        {funder.phone && (
                          <div className="flex items-center gap-2 text-sm">
                            <Phone className="w-4 h-4 text-slate-400" />
                            <a href={`tel:${funder.phone}`} className="text-blue-600 hover:underline">
                              {funder.phone}
                            </a>
                          </div>
                        )}
                        {funder.address && (
                          <div className="flex items-center gap-2 text-sm col-span-2">
                            <MapPin className="w-4 h-4 text-slate-400" />
                            <span className="text-slate-600">
                              {formatAddress(funder.address)}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {funder.grants.length > 0 && (
                          <Badge variant="secondary">
                            {funder.grants.length} grant{funder.grants.length !== 1 ? 's' : ''}
                          </Badge>
                        )}
                        {funder.activeGrants > 0 && (
                          <Badge variant="secondary" className="bg-blue-50 text-blue-700">
                            {funder.activeGrants} active
                          </Badge>
                        )}
                        {funder.opportunities.length > 0 && (
                          <Badge variant="secondary" className="bg-purple-50 text-purple-700">
                            {funder.opportunities.length} opportunities
                          </Badge>
                        )}
                      </div>
                    </div>
                    
                    <Button variant="outline" size="sm" asChild>
                      <Link to={createPageUrl("Pipeline")}>
                        View Grants
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Funders Found</h3>
              <p className="text-slate-600">
                {searchQuery 
                  ? 'No funders match your search. Try different keywords.'
                  : 'Start adding grants to build your funder directory.'}
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
