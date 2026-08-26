import React, { useState } from 'react'
import { BookOpenCheck, Loader2, Search } from 'lucide-react'

import { rankResearchOpportunities } from '@/api/researchRecommendations'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

function parsePublications(value) {
  if (!value.trim()) return []
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Publications must be valid JSON.')
  }
  if (!Array.isArray(parsed)) throw new Error('Publications must be a JSON array.')
  return parsed
}

export default function ResearchFundingRecommendations({ profileId }) {
  const [cvText, setCvText] = useState('')
  const [publications, setPublications] = useState('[]')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleRank() {
    setLoading(true)
    setError('')
    try {
      const ranked = await rankResearchOpportunities({
        profile_id: profileId,
        cv_text: cvText,
        publications: parsePublications(publications),
        limit: 100,
      })
      setResult(ranked)
    } catch (err) {
      setResult(null)
      setError(err?.message || 'Could not rank research opportunities.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BookOpenCheck className="h-5 w-5" /> CV and publication fit</CardTitle>
          <CardDescription>
            Compare this profile’s stored funding matches with CV topics, methods, career stage, funder history, and publication evidence.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription>
              Eligibility remains authoritative: the server reloads this profile’s stored match decision, and CV similarity can never revive a rejected opportunity.
            </AlertDescription>
          </Alert>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="research-cv">CV text</Label>
              <Textarea
                id="research-cv"
                value={cvText}
                onChange={(event) => setCvText(event.target.value)}
                placeholder="Paste CV text, research interests, methods, and funded work."
                className="min-h-64"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="research-publications">Publications JSON</Label>
              <Textarea
                id="research-publications"
                value={publications}
                onChange={(event) => setPublications(event.target.value)}
                placeholder='[{"title":"...","abstract":"...","year":2026,"doi":"10....","keywords":["..."]}]'
                className="min-h-64 font-mono text-xs"
              />
            </div>
          </div>
          <Button onClick={handleRank} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
            Rank stored matches
          </Button>
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>Research funding ranking</CardTitle>
            <CardDescription>
              {result.ranked?.length || 0} ranked · {result.excluded?.length || 0} excluded by canonical eligibility or missing stored match evidence
            </CardDescription>
          </CardHeader>
          <CardContent>
            {(result.ranked || []).length === 0 ? (
              <p className="text-sm text-slate-600">No eligible stored profile matches are available to rank.</p>
            ) : (
              <ol className="space-y-3">
                {result.ranked.map((opportunity) => (
                  <li key={opportunity.id} className="rounded-lg border bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-slate-900">{opportunity.rank}. {opportunity.title || opportunity.id}</p>
                        <p className="mt-1 text-xs text-slate-600">
                          Topic overlap: {opportunity.evidence?.topic_overlap?.join(', ') || 'none'} · Method overlap: {opportunity.evidence?.method_overlap?.join(', ') || 'none'}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">Score {opportunity.score}</Badge>
                        <Badge variant={opportunity.canonical_decision === 'ACCEPT' ? 'default' : 'secondary'}>
                          {opportunity.canonical_decision}
                        </Badge>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
