import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2, ArrowLeft, ExternalLink } from 'lucide-react'
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

export default function VNextFinishPacket() {
  const id = getQueryParam('id')

  const query = useQuery({
    queryKey: ['vnext-finish-packet', id],
    enabled: Boolean(id) && env.shouldersVnext,
    queryFn: () => apiFetch(`/api/vnext/applications/${id}/finish-packet`),
  })

  if (!env.shouldersVnext) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <Alert>
          <AlertTitle>vNext disabled</AlertTitle>
          <AlertDescription>
            Set <span className="font-mono">VITE_SHOULDERS_VNEXT=true</span> to enable the UI.
            {id ? <> Application id: <span className="font-mono">{id}</span></> : null}
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

  if (query.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    )
  }

  if (!query.data) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <Alert variant="destructive">
          <AlertTitle>Failed to load finish packet</AlertTitle>
          <AlertDescription>{String(query.error?.message || 'Unknown error')}</AlertDescription>
        </Alert>
      </div>
    )
  }

  const data = query.data
  const boundary = data.boundary || {}
  const missing = data.missing_requirements || {}
  const remainingTasks = Array.isArray(data.remaining_tasks) ? data.remaining_tasks : []
  const docs = Array.isArray(data.doc_bundle) ? data.doc_bundle : []
  const instructions = Array.isArray(data.submission_instructions) ? data.submission_instructions : []

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Finish Packet</h1>
          <p className="text-sm text-slate-600">Application: {data.application?.id}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/VNextApplication?id=${encodeURIComponent(id)}`}>
            <Button variant="outline">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
          </Link>
          {boundary?.url && /^https?:\/\//i.test(boundary.url) ? (
            <a href={boundary.url} target="_blank" rel="noreferrer">
              <Button>
                <ExternalLink className="w-4 h-4 mr-2" />
                Open submission link
              </Button>
            </a>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Boundary</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          <div>
            <span className="font-medium">Type:</span> {boundary?.type || 'none'}
          </div>
          <div className="break-all">
            <span className="font-medium">URL:</span> {boundary?.url || '—'}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Submission instructions</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {instructions.length === 0 ? (
            <p className="text-slate-600">No instructions available.</p>
          ) : (
            <ul className="list-disc ml-5 space-y-1">
              {instructions.map((line, idx) => (
                <li key={idx}>{line}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Remaining tasks</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {remainingTasks.length === 0 ? (
              <p className="text-slate-600">No remaining tasks.</p>
            ) : (
              <ul className="list-disc ml-5 space-y-1">
                {remainingTasks.slice(0, 20).map((t) => (
                  <li key={t.id}>
                    <span className="font-medium">{t.title}</span>{' '}
                    <span className="text-slate-600">({t.status})</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Missing requirements</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            <div>
              <span className="font-medium">Missing fields:</span>{' '}
              {Array.isArray(missing?.missing_fields) ? missing.missing_fields.length : '—'}
            </div>
            <div>
              <span className="font-medium">Missing docs:</span>{' '}
              {Array.isArray(missing?.missing_docs) ? missing.missing_docs.length : '—'}
            </div>
            {Array.isArray(missing?.missing_fields) && missing.missing_fields.length > 0 ? (
              <ul className="list-disc ml-5 space-y-1">
                {missing.missing_fields.slice(0, 10).map((f) => (
                  <li key={f.key}>
                    <span className="font-medium">{f.label || f.key}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Document bundle</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {docs.length === 0 ? (
            <p className="text-slate-600">No documents linked.</p>
          ) : (
            <ul className="list-disc ml-5 space-y-1">
              {docs.slice(0, 25).map((d) => (
                <li key={d.id}>
                  <span className="font-medium">{d.type || 'document'}</span>{' '}
                  <span className="text-slate-600">{d.storage_uri || d.file_url || d.file_path || ''}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

