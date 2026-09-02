import React, { useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Loader2, Search, Building2, DollarSign, ExternalLink, Plus, Check, Sparkles, Landmark } from 'lucide-react'
import { traceFunding, addTracedSource } from '@/api/fundingTrace'
import { useToast } from '@/components/ui/use-toast'

const ENTITY_TYPES = [
  { value: 'company', label: 'Company / Business' },
  { value: 'nonprofit', label: 'Nonprofit' },
  { value: 'foundation', label: 'Foundation / Grantmaker' },
  { value: 'public_entity', label: 'Public Entity' },
  { value: 'individual', label: 'Individual' },
]

const ORIGIN_META = {
  usaspending: { label: 'Verified federal award evidence', icon: Landmark, className: 'bg-blue-50 text-blue-700 border-blue-300' },
  ai_synthesis: { label: 'Unverified research hypothesis', icon: Sparkles, className: 'bg-purple-50 text-purple-700 border-purple-300' },
}

function formatAmount(amt) {
  if (!amt) return null
  const num = typeof amt === 'string' ? Number(amt.replace(/[,]/g, '')) : Number(amt)
  if (Number.isNaN(num)) return null
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1_000) return `$${(num / 1_000).toFixed(0)}K`
  return `$${num.toLocaleString()}`
}

export default function AdminFundingTrace() {
  const [entity, setEntity] = useState('')
  const [entityType, setEntityType] = useState('company')
  const [loading, setLoading] = useState(false)
  const [includeHypotheses, setIncludeHypotheses] = useState(false)
  const [result, setResult] = useState(null)
  const [adding, setAdding] = useState({}) // key -> 'pending' | 'added'
  const { toast } = useToast()

  const runTrace = useCallback(async () => {
    if (loading) return
    const q = entity.trim()
    if (!q) return
    setLoading(true)
    setResult(null)
    try {
      const data = await traceFunding(q, { entityType, useAi: includeHypotheses })
      setResult(data)
      if ((data.sources?.length ?? 0) === 0) {
        const status = data.data_sources?.usaspending?.status
        toast(status === 'unavailable' || status === 'partial'
          ? {
              title: status === 'unavailable' ? 'Official award evidence unavailable' : 'Official award evidence incomplete',
              description: 'GrantFlow did not convert an unavailable data source into a zero. Retry when USASpending is healthy.',
              variant: 'destructive',
            }
          : { title: 'No verified funding sources found', description: 'Try the exact official recipient name shown in public award records.' })
      }
    } catch (err) {
      toast({ title: 'Trace failed', description: err.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [entity, entityType, includeHypotheses, loading, toast])

  const handleAdd = useCallback(async (source) => {
    setAdding((prev) => ({ ...prev, [source.key]: 'pending' }))
    try {
      await addTracedSource(source, result?.entity, result?.entity_type)
      setAdding((prev) => ({ ...prev, [source.key]: 'added' }))
      toast({ title: 'Added to GrantFlow', description: `${source.name} is now in the funding catalog.` })
    } catch (err) {
      setAdding((prev) => ({ ...prev, [source.key]: undefined }))
      toast({ title: 'Could not add source', description: err.message, variant: 'destructive' })
    }
  }, [result, toast])

  const sources = result?.sources ?? []
  const hypotheses = result?.research_hypotheses ?? []
  const resolution = result?.recipient_resolution ?? null
  const usaSpendingStatus = result?.data_sources?.usaspending?.status ?? 'unknown'

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="w-5 h-5 text-blue-600" />
            Funding Trace
          </CardTitle>
          <CardDescription>
            Enter a company, nonprofit, foundation, public entity, or individual to trace public funding evidence:
            federal awards received, IRS 990 context, and clearly labeled AI synthesis when enabled. Add verified sources
            to the GrantFlow catalog.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              placeholder="e.g. Ford Foundation, City of Columbus, Lockheed Martin"
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
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-600">
            <Switch
              id="funding-trace-hypotheses"
              checked={includeHypotheses}
              onCheckedChange={(checked) => setIncludeHypotheses(Boolean(checked))}
            />
            <label htmlFor="funding-trace-hypotheses">
              Include separate AI research hypotheses (never addable and never counted as verified sources)
            </label>
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
                ? `${sources.length} verified source(s) found from ${result.counts?.matched_recipient_awards ?? 0} award record(s) tied to the resolved recipient`
                : 'No verified funding sources found.'}
              {result.nonprofit_match && (
                <span className="block mt-1 text-xs text-slate-500">
                  Matched IRS 990 nonprofit: {result.nonprofit_match.name} ({result.nonprofit_match.state || 'n/a'})
                </span>
              )}
            </CardDescription>
          </CardHeader>
          <div className="mx-6 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            Direct source results below require an exact recipient identity and an official USASpending award record.
            Broad name hits and AI ideas never receive the Add action; they remain separate research candidates.
          </div>
          {usaSpendingStatus !== 'complete' ? (
            <div className="mx-6 mb-3 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs leading-relaxed text-orange-900">
              Official federal-award evidence is {usaSpendingStatus}. Results may be incomplete, and Add will revalidate the source before changing the catalog.
            </div>
          ) : null}
          {resolution?.status && resolution.status !== 'resolved' ? (
            <div className="mx-6 mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-900">
              GrantFlow did not resolve this text to one recipient ({resolution.status.replaceAll('_', ' ')}), so it returned no direct funding sources.
              {resolution.candidates?.length ? (
                <span className="block mt-1">
                  Candidate recipient names: {resolution.candidates.map((candidate) => candidate.recipient_name).join('; ')}. Search the exact official name to continue.
                </span>
              ) : null}
            </div>
          ) : null}
          {resolution?.status === 'resolved' ? (
            <div className="mx-6 mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-900">
              Resolved recipient: <span className="font-semibold">{resolution.recipient_name}</span> ({resolution.score}% identity evidence).
            </div>
          ) : null}
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
                      {source.parent_agency && <span className="text-xs text-slate-500 truncate">part of {source.parent_agency}</span>}
                      {source.recipient_name && <span className="text-xs text-slate-500 truncate">recipient: {source.recipient_name}</span>}
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

      {hypotheses.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Research hypotheses — not verified funding sources</CardTitle>
            <CardDescription>
              These ideas came from optional AI synthesis. They cannot be added until a public award, official program page, or other source verifies them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {hypotheses.map((source) => (
              <div key={source.key} className="rounded-lg border border-purple-200 bg-purple-50/40 p-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-600" />
                  <p className="text-sm font-medium text-slate-900">{source.name}</p>
                  <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-300">
                    Unverified
                  </Badge>
                </div>
                {source.rationale ? <p className="mt-1 text-xs text-slate-600">{source.rationale}</p> : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
