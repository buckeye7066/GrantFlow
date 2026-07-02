import React, { useState, useMemo } from "react"
import { HandCoins, Search, Mail, Phone, MapPin, Building2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/api/client"
import { Link } from "react-router-dom"
import { createPageUrl, formatAddress } from "@/utils"
import FunderDetailDialog from "@/components/funding/FunderDetailDialog"

export default function Funder() {
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedType, setSelectedType] = useState("all")
  const [selectedFunder, setSelectedFunder] = useState(null)

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
    queryFn: async () => {
  const raw = await apiFetch('/api/grants')
  const list = normalizeList(raw)
  if (!Array.isArray(raw) && list.length === 0) {
    console.warn('[Funder] /api/grants returned unexpected shape:', typeof raw, raw)
  }
  return list
},
    staleTime: 60_000,
  })

  const { data: opportunities = [] } = useQuery({
    queryKey: ['opportunities'],
    queryFn: async () => {
  const raw = await apiFetch('/api/opportunities')
  const list = normalizeList(raw)
  if (!Array.isArray(raw) && list.length === 0) {
    console.warn('[Funder] /api/opportunities returned unexpected shape:', typeof raw, raw)
  }
  return list
},
    staleTime: 60_000,
  })

  // Extract unique funders from grants and opportunities.
  // NOTE: the LIST endpoints (/api/grants, /api/opportunities) return the raw
  // DB columns — grant rows carry contact_email/contact_phone/funder_address/
  // application_url (NOT the funder_email/funder_phone aliases that only the
  // single-grant GET /:id adds), and opportunity rows carry sponsor/funder plus
  // amount_min/amount_max/deadline/application_url. We read both shapes so the
  // directory and detail view reflect the data that actually exists.
  const ACTIVE_STATUSES = [
    'submitted', 'under_review', 'pending_review', 'follow_up', 'awarded',
    'gathering_documents', 'drafting', 'ready_to_submit', 'application_prep',
    'app_prep', 'revision', 'portal', 'report',
  ]

  const funders = useMemo(() => {
    const funderMap = new Map()

    const ensureFunder = (name) => {
      if (!funderMap.has(name)) {
        funderMap.set(name, {
          name,
          email: null,
          phone: null,
          address: null,
          url: null,
          grants: [],
          opportunities: [],
          totalAwarded: 0,
          activeGrants: 0,
          fundingTypes: new Set(),
          amountMin: null,
          amountMax: null,
          amountDescription: null,
          nextDeadline: null,
          deadlineType: null,
        })
      }
      return funderMap.get(name)
    }

    // Merge a candidate amount range into the funder (widest observed range).
    const mergeAmount = (funder, min, max, desc) => {
      const lo = Number(min)
      const hi = Number(max)
      if (Number.isFinite(lo) && lo > 0) {
        funder.amountMin = funder.amountMin === null ? lo : Math.min(funder.amountMin, lo)
      }
      if (Number.isFinite(hi) && hi > 0) {
        funder.amountMax = funder.amountMax === null ? hi : Math.max(funder.amountMax, hi)
      }
      if (!funder.amountDescription && desc) funder.amountDescription = desc
    }

    // Track the soonest upcoming deadline (fixed dates only); preserve rolling/ongoing.
    const mergeDeadline = (funder, deadline, type) => {
      const t = type ? String(type).toLowerCase() : null
      if (t === 'rolling' || t === 'ongoing') {
        if (!funder.nextDeadline) funder.deadlineType = funder.deadlineType || t
        return
      }
      if (!deadline) return
      const d = new Date(deadline)
      if (Number.isNaN(d.getTime())) return
      const cur = funder.nextDeadline ? new Date(funder.nextDeadline) : null
      if (!cur || d < cur) {
        funder.nextDeadline = deadline
        funder.deadlineType = t || 'fixed'
      }
    }

    // Add funders from grants
    grants.forEach(grant => {
      if (!grant.funder) return
      const funder = ensureFunder(grant.funder)
      funder.grants.push(grant)
      // Correct column names from the list endpoint.
      if (!funder.email) funder.email = grant.contact_email || null
      if (!funder.phone) funder.phone = grant.contact_phone || null
      if (!funder.address) funder.address = grant.funder_address || null
      if (!funder.url) funder.url = grant.url || grant.application_url || grant.portal_url || null
      const gType = grant.opportunity_type || grant.funding_type
      if (gType) funder.fundingTypes.add(gType)
      mergeAmount(funder, grant.amount_min ?? grant.amount_requested, grant.amount_max ?? grant.amount_awarded)
      mergeDeadline(funder, grant.deadline, grant.deadline_type)
      if (grant.status === 'awarded' && grant.amount_awarded) {
        funder.totalAwarded += Number(grant.amount_awarded) || 0
      }
      if (ACTIVE_STATUSES.includes(grant.status)) {
        funder.activeGrants++
      }
    })

    // Add funders from opportunities (keyed by funder/sponsor)
    opportunities.forEach(opp => {
      const name = opp.funder || opp.sponsor
      if (!name) return
      const funder = ensureFunder(name)
      funder.opportunities.push(opp)
      // Opportunities may carry a JSON contact_info blob; fall back gracefully.
      const contact = opp.contact_info && typeof opp.contact_info === 'object' ? opp.contact_info : null
      if (!funder.email) funder.email = opp.contact_email || contact?.email || null
      if (!funder.phone) funder.phone = opp.contact_phone || contact?.phone || null
      if (!funder.address) funder.address = opp.funder_address || contact?.address || null
      if (!funder.url) funder.url = opp.application_url || opp.apply_url || opp.source_url || contact?.website || null
      const oType = opp.opportunity_type || opp.funding_type
      if (oType) funder.fundingTypes.add(oType)
      mergeAmount(funder, opp.amount_min, opp.amount_max, opp.amount_description)
      mergeDeadline(funder, opp.deadline, opp.deadline_type)
    })

    return Array.from(funderMap.values())
      .map((f) => ({ ...f, fundingTypes: Array.from(f.fundingTypes) }))
      .sort((a, b) =>
        b.totalAwarded - a.totalAwarded ||
        b.grants.length - a.grants.length ||
        b.opportunities.length - a.opportunities.length
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
              <Card
                key={`${funder.name}-${index}`}
                role="button"
                tabIndex={0}
                aria-label={`View details for ${funder.name}`}
                onClick={() => setSelectedFunder(funder)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelectedFunder(funder)
                  }
                }}
                className="cursor-pointer hover:border-blue-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
              >
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
                    
                    <div className="flex flex-col gap-2 shrink-0">
                      <Button
                        variant="default"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedFunder(funder)
                        }}
                      >
                        View Details
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        asChild
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Link to={`${createPageUrl("Pipeline")}?funder=${encodeURIComponent(funder.name)}`}>
                          View Grants
                        </Link>
                      </Button>
                    </div>
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

      <FunderDetailDialog
        funder={selectedFunder}
        open={Boolean(selectedFunder)}
        onClose={() => setSelectedFunder(null)}
      />
    </div>
  )
}
