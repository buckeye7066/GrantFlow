import React, { useMemo, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2 } from 'lucide-react'
import { apiFetch } from '@/api/apiClient'
import { env } from '@/config/env.js'

function getQueryParam(name) {
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get(name)
  } catch {
    return null
  }
}

const STATE_ORDER = [
  'DISCOVERED',
  'DEDUPED',
  'QUALIFIED',
  'SCHEMA_READY',
  'MAPPED',
  'MISSING_RESOLVED',
  'DRAFTING',
  'REVIEW_READY',
  'BOUNDARY_REACHED',
]

export default function VNextApplication() {
  const navigate = useNavigate()
  const id = getQueryParam('id')
  const [lastBlockers, setLastBlockers] = useState([])

  const appQuery = useQuery({
    queryKey: ['vnext-application', id],
    enabled: Boolean(id) && env.shouldersVnext,
    queryFn: () => apiFetch(`/api/vnext/applications/${id}`),
  })

  const transitionMutation = useMutation({
    mutationFn: async (targetState) => {
      if (!env.shouldersVnext) {
        throw new Error('vNext feature flag is disabled')
      }
      setLastBlockers([])
      return await apiFetch(`/api/vnext/applications/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetState }),
      })
    },
    onSuccess: () => {
      setLastBlockers([])
    },
    onError: (err) => {
      try {
        const data = err?.data ?? err?.response ?? null
        if (Array.isArray(data?.blockers) && data.blockers.length > 0) {
          setLastBlockers(data.blockers)
        } else {
          const msg = String(err?.message || err)
          setLastBlockers([{ code: 'REQUEST_FAILED', message: msg }])
        }
      } catch {
        setLastBlockers([{ code: 'REQUEST_FAILED', message: 'Request failed' }])
      }
    },
  })

  const app = appQuery.data
  const currentState = String(app?.state || 'DISCOVERED')

  const nextState = useMemo(() => {
    const idx = STATE_ORDER.indexOf(currentState)
    if (idx < 0) return null
    return STATE_ORDER[idx + 1] || null
  }, [currentState])

  if (!env.shouldersVnext) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <Alert>
          <AlertTitle>vNext disabled</AlertTitle>
          <AlertDescription>
            Set <span className="font-mono">VITE_SHOULDERS_VNEXT=true</span> to enable the UI.
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!id) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <Alert>
          <AlertTitle>Missing application id</AlertTitle>
          <AlertDescription>Pass <span className="font-mono">?id=...</span> in the URL.</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (appQuery.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    )
  }

  if (appQuery.error || !app) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <Alert variant="destructive">
          <AlertTitle>Failed to load vNext application</AlertTitle>
          <AlertDescription>{String(appQuery.error?.message || 'Unknown error')}</AlertDescription>
        </Alert>
      </div>
    )
  }

  const missing = (app?.missing_requirements && typeof app.missing_requirements === 'object')
    ? app.missing_requirements
    : null
  const missingFields = Array.isArray(missing?.missing_fields) ? missing.missing_fields.length : null
  const missingDocs = Array.isArray(missing?.missing_docs) ? missing.missing_docs.length : null
  const missingnessUnavailable = app !== null && missing === null

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">vNext Application</h1>
          <p className="text-sm text-slate-600">State: {currentState}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => navigate(`/VNextFinishPacket?id=${encodeURIComponent(id)}`)}
          >
            Finish Packet
          </Button>
          <Button
            disabled={!nextState || transitionMutation.isPending}
            onClick={() => transitionMutation.mutate(nextState)}
          >
            {transitionMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Advance{nextState ? ` → ${nextState}` : ''}
          </Button>
        </div>
      </div>

      {Array.isArray(lastBlockers) && lastBlockers.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>Blocked</AlertTitle>
          <AlertDescription>
            <ul className="list-disc ml-5 space-y-1">
              {lastBlockers.map((b, idx) => (
                <li key={`${b.code || 'blocker'}-${idx}`}>
                  <span className="font-mono">{b.code || 'BLOCKED'}</span> — {b.message || 'Blocked'}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Scoring</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>
              <span className="font-medium">Expected value:</span>{' '}
              {app.expected_value !== null ? Number(app.expected_value).toFixed(2) : '—'}
            </div>
            <div>
              <span className="font-medium">Risk score:</span>{' '}
              {app.risk_score !== null ? Number(app.risk_score).toFixed(2) : '—'}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Missingness</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>
              <span className="font-medium">Missing fields:</span> {missingFields ?? '—'}
            </div>
            <div>
              <span className="font-medium">Missing docs:</span> {missingDocs ?? '—'}
            </div>
            {Array.isArray(missing?.missing_fields) && missing.missing_fields.length > 0 ? (
              <div>
                <p className="font-medium mt-2">Required fields</p>
                <ul className="list-disc ml-5 space-y-1">
                  {missing.missing_fields.slice(0, 8).map((f) => (
                    <li key={f.key}>
                      <span className="font-medium">{f.label || f.key}</span>{' '}
                      <span className="text-slate-600">({f.reason})</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Manual transitions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {STATE_ORDER.map((s) => {
            const currentIdx = STATE_ORDER.indexOf(currentState)
            const targetIdx = STATE_ORDER.indexOf(s)
            // Only allow transitions to adjacent next state or back one step (for corrections);
            // never allow skipping more than one state forward to protect pipeline integrity.
            const isForwardSkip = targetIdx > currentIdx + 1
            const isBackwardSkip = targetIdx < currentIdx - 1
            const isDisabled = transitionMutation.isPending || isForwardSkip || isBackwardSkip
            const disabledTitle = isForwardSkip
              ? `Cannot skip forward from ${currentState} to ${s}`
              : isBackwardSkip
              ? `Cannot rewind more than one step from ${currentState} to ${s}`
              : undefined
            return (
              <Button
                key={s}
                variant={s === currentState ? 'default' : 'outline'}
                size="sm"
                disabled={isDisabled}
                title={disabledTitle}
                onClick={() => transitionMutation.mutate(s)}
              >
                {s}
              </Button>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}

