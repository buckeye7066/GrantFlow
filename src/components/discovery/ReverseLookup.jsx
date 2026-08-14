import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, Search, Building2, DollarSign, MapPin, ExternalLink } from 'lucide-react'
import { reverseLookup } from '@/api/foundations'
import { useToast } from '@/components/ui/use-toast'

export default function ReverseLookup({ profileId, profileName }) {
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const { toast } = useToast()
  const requestIdRef = useRef(0)

  const handleSearch = useCallback(async () => {
    if (!profileId) return
    const currentRequestId = ++requestIdRef.current
    setLoading(true)
    try {
      const data = await reverseLookup(profileId)
      if (currentRequestId !== requestIdRef.current) return
      setResults(data)
      setExpanded(true)
      if ((data.suggested_funders?.length ?? 0) === 0) {
        toast({ title: 'No funders found', description: 'Try completing more profile fields for better matches.' })
      }
    } catch (err) {
      if (currentRequestId !== requestIdRef.current) return
      toast({ title: 'Error', description: err.message, variant: 'destructive' })
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setLoading(false)
      }
    }
  }, [profileId, toast])

  useEffect(() => {
    setResults(null)
    setExpanded(false)
    if (profileId) {
      void handleSearch()
    }
  }, [profileId, handleSearch])

  const formatAmount = (amt) => {
    if (!amt) return null
    if (amt >= 1_000_000) return `$${(amt / 1_000_000).toFixed(1)}M`
    if (amt >= 1_000) return `$${(amt / 1_000).toFixed(0)}K`
    return `$${amt.toLocaleString()}`
  }

  if (!expanded && loading) {
    return (
      <Card className="border-purple-200 bg-purple-50/50">
        <CardContent className="pt-4 pb-4 flex items-center gap-2 text-sm text-purple-900">
          <Loader2 className="w-4 h-4 animate-spin" />
          Finding funders aligned with {profileName || 'this profile'}…
        </CardContent>
      </Card>
    )
  }

  if (!expanded) {
    return (
      <Card className="border-purple-200 bg-purple-50/50">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-purple-900">Find Funders Like You</p>
              <p className="text-xs text-purple-700 mt-0.5">
                Discover foundations that fund organizations similar to {profileName || 'yours'} using IRS 990 data.
              </p>
            </div>
            <Button
              size="sm"
              onClick={handleSearch}
              disabled={loading || !profileId}
              className="bg-purple-600 hover:bg-purple-700 text-white"
            >
              {loading ? (
                <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Searching...</>
              ) : (
                <><Search className="w-3.5 h-3.5 mr-1.5" />Find Funders</>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const funders = results?.suggested_funders ?? []

  return (
    <Card className="border-purple-200">
      <CardHeader className="pb-3">
        <CardTitle className="text-base text-purple-900">
          Funders Like You
        </CardTitle>
        <CardDescription>
          {funders.length > 0
            ? `Found ${funders.length} foundations that fund similar organizations`
            : loading
              ? 'Searching for aligned funders…'
              : 'No matching funders found. Try completing more profile fields.'}
          {results?.ntee_codes_used?.length > 0 && (
            <span className="block mt-1 text-xs text-slate-500">
              Searched: {results.ntee_codes_used.map(c => c.label).join(', ')}
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {funders.slice(0, 10).map((funder) => (
          <div
            key={funder.ein}
            className="flex items-start justify-between p-3 rounded-lg border border-slate-200 bg-white hover:border-purple-300 transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-purple-600 flex-shrink-0" />
                <p className="text-sm font-medium text-slate-900 truncate">{funder.name}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                {funder.city && funder.state && (
                  <span className="inline-flex items-center gap-0.5 text-xs text-slate-500">
                    <MapPin className="w-3 h-3" />
                    {funder.city}, {funder.state}
                  </span>
                )}
                {funder.grant_amount && (
                  <span className="inline-flex items-center gap-0.5 text-xs text-green-700">
                    <DollarSign className="w-3 h-3" />
                    {formatAmount(funder.grant_amount)} granted
                  </span>
                )}
                {funder.ntee_label && (
                  <Badge variant="outline" className="text-xs">{funder.ntee_label}</Badge>
                )}
                {funder.already_in_catalog && (
                  <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-300">In catalog</Badge>
                )}
              </div>
            </div>
            {funder.profile_url && (
              <a
                href={funder.profile_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0 ml-2 text-purple-600 hover:text-purple-800"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
          </div>
        ))}

        {funders.length > 10 && (
          <p className="text-xs text-slate-500 text-center pt-1">
            Showing top 10 of {funders.length} funders
          </p>
        )}

        <div className="flex gap-2 pt-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleSearch}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Refresh'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded(false)}
          >
            Collapse
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
