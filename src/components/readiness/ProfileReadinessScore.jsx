import React, { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Sparkles, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import profileReadinessApi from '@/api/profileReadiness'
import ProfileReadinessChecklist from './ProfileReadinessChecklist'

const STATUS_STYLES = {
  excellent: 'bg-emerald-100 text-emerald-900 border-emerald-200',
  good: 'bg-blue-100 text-blue-900 border-blue-200',
  needs_work: 'bg-amber-100 text-amber-900 border-amber-200',
  poor: 'bg-red-100 text-red-900 border-red-200',
}

const STATUS_LABELS = {
  excellent: 'Excellent',
  good: 'Good',
  needs_work: 'Needs work',
  poor: 'Poor',
}

/**
 * ProfileReadinessScore — primary entry point.
 *
 * Renders a score gauge, a status badge, and the per-category checklist
 * powered by /api/profiles/:id/readiness/detailed. This is the surface
 * Anya uses to coach the user on what to add next, and the same data the
 * Robert agent uses to decide whether a profile has enough information
 * for high-quality matching.
 */
export default function ProfileReadinessScore({ profileId, compact = false, onRefresh }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (!profileId) return undefined
    setLoading(true)
    profileReadinessApi
      .detailed(profileId)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [profileId, onRefresh])

  if (!profileId) return null

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-4 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading profile readiness…
        </CardContent>
      </Card>
    )
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex items-start gap-2 p-4 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <span>Couldn't load readiness right now: {error || 'no data'}.</span>
        </CardContent>
      </Card>
    )
  }

  const score = Number(data.readiness_score || 0)
  const status = data.status || 'poor'

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-blue-600" />
            Profile readiness
          </CardTitle>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {data.impact_on_matching}
          </p>
        </div>
        <Badge variant="outline" className={`text-[10px] uppercase ${STATUS_STYLES[status] || ''}`}>
          {STATUS_LABELS[status] || status}
        </Badge>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex items-end gap-3">
          <div className="font-mono text-3xl font-bold leading-none">{score}</div>
          <div className="text-xs text-slate-500">/ 100</div>
          {score >= 85 ? (
            <CheckCircle2 className="ml-auto h-5 w-5 text-emerald-600" />
          ) : null}
        </div>
        <Progress value={score} className="h-2" />
        {!compact ? (
          <div className="mt-4">
            <ProfileReadinessChecklist data={data} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
