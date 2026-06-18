import React, { useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Search, Building2, DollarSign, ExternalLink, Plus, Check, Sparkles, Landmark } from 'lucide-react'
import { traceFunding, addTracedSource } from '@/api/fundingTrace'
import { useToast } from '@/components/ui/use-toast'

const ENTITY_TYPES = [
  { value: 'company', label: 'Company / Corporation' },
  { value: 'public_entity', label: 'Public Entity' },
  { value: 'individual', label: 'Individual' },
]

const ORIGIN_META = {
  usaspending: { label: 'Federal awards', icon: Landmark, className: 'bg-blue-50 text-blue-700 border-blue-300' },
  ai_synthesis: { label: 'AI-identified', icon: Sparkles, className: 'bg-purple-50 text-purple-700 border-purple-300' },
}

function formatAmount(amt) {
  if (!amt) return null
  if (amt >= 1_000_000) return `$${(amt / 1_000_000).toFixed(1)}M`
  if (amt >= 1_000) return `$${(amt / 1_000).toFixed(0)}K`
  return `$${Number(amt).toLocaleString()}`
}

export default function AdminFundingTrace() {
  const [entity, setEntity] = useState('')
  const [entityType, setEntityType] = useState('company')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [adding, setAdding] = useState({}) // key -> 'pending' | 'added'
  const { toast } = useToast()

  const runTrace = useCallback(async () => {
    const q = entity.trim()
    if (!q) return
    setLoading(true)
    setResult(null)
    try {
      const data = await traceFunding(q, { entityType })
      setResult(data)
      if ((data.sources?.length ?? 0) === 0) {
        toast({ title: 'No funding sources found', description: 'Try a more complete or official entity name.' })
      }
    } catch (err) {
      toast({ title: 'Trace failed', description: err.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [entity, entityType, toast])

  const handleAdd = useCallback(async (source) => {
    setAdding((prev) => ({ ...prev, [source.key]: 'pending' }))
    try {
      await addTracedSource(source, result?.entity)
      setAdding((prev) => ({ ...prev, [source.key]: 'added' }))
      toast({ title: 'Added to GrantFlow', description: `${source.name} is now in the funding catalog.` })
    } catch (err) {
      setAdding((prev) => ({ ...prev, [source.key]: undefined }))
      toast({ title: 'Could not add source', description: err.message, variant: 'destructive' })
    }
  }, [result, toast])

  const sources = result?.sources ?? []

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="w-5 h-5 text-blue-600" />
            Funding Trace
          </CardTitle>
          <CardDescription>
            Enter a company, public entity, or individual to see where they get their funding — sourced from
            federal award data (USASpending.gov), IRS 990 filings, and AI analysis. Add any source to the GrantFlow catalog.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              placeholder="e.g. Lockheed Martin, City of Columbus, Jane Smith"
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runTrace() }}
              className="flex-1"
            />
            <Select value={entityType} onValueChange={setEntityType}>
              <SelectTrigger className="sm:w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ENTITY_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button onClick={runTrace} disabled={loading || !entity.trim()} className="bg-blue-600 hover:bg-blue-700">
              {loading
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Tracing…</>
                : <><Search className="w-4 h-4 mr-2" />Trace Funding</>}
            </Button>
          </div>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Funding sources for “{result.entity}”
            </CardTitle>
            <CardDescription>
              {sources.length > 0
                ? `${sources.length} source(s) found · ${result.counts?.federal_grant_awards ?? 0} grant + ${result.counts?.federal_contract_awards ?? 0} contract awards traced`
                : 'No funding sources found.'}
              {result.nonprofit_match && (
                <span className="block mt-1 text-xs text-slate-500">
                  Matched IRS 990 nonprofit: {result.nonprofit_match.name} ({result.nonprofit_match.state || 'n/a'})
                </span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {sources.map((source) => {
              const origin = ORIGIN_META[source.origin] || ORIGIN_META.usaspending
              const OriginIcon = origin.icon
              const state = adding[source.key]
              const inCatalog = source.already_in_catalog || state === 'added'
              return (
                <div
                  key={source.key}
                  className="flex items-start justify-between gap-3 p-3 rounded-lg border border-slate-200 bg-white hover:border-blue-300 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-slate-500 flex-shrink-0" />
                      <p className="text-sm font-medium text-slate-900 truncate">{source.name}</p>
                      <Badge variant="outline" className={`text-xs ${origin.className}`}>
                        <OriginIcon className="w-3 h-3 mr-1" />{origin.label}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1.5">
                      {source.total_amount ? (
                        <span className="inline-flex items-center gap-0.5 text-xs text-green-700">
                          <DollarSign className="w-3 h-3" />{formatAmount(source.total_amount)}
                          {source.award_count ? ` · ${source.award_count} awards` : ''}
                        </span>
                      ) : null}
                      {source.latest_year && <Badge variant="outline" className="text-xs">Latest {source.latest_year}</Badge>}
                      {source.sub_agency && <span className="text-xs text-slate-500 truncate">{source.sub_agency}</span>}
                      {source.rationale && <span className="text-xs text-slate-500 italic truncate max-w-md">{source.rationale}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {source.sample_url && (
                      <a href={source.sample_url} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-blue-600">
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
                    {inCatalog ? (
                      <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-300">
                        <Check className="w-3 h-3 mr-1" />In catalog
                      </Badge>
                    ) : source.addable !== false ? (
                      <Button size="sm" variant="outline" onClick={() => handleAdd(source)} disabled={state === 'pending'}>
                        {state === 'pending'
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <><Plus className="w-3.5 h-3.5 mr-1" />Add</>}
                      </Button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
