/**
 * HamiltonPortalsPanel — student-portal records that Hamilton uses to route
 * funding opportunities. Renders a compact list with portal type, URL,
 * source, confidence, and credentials status. Mounts inside
 * StudentPortalsCard / UniversityApplicationsSection.
 */

import React, { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ExternalLink, Loader2, ShieldAlert, Sparkles } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { showErrorToast } from '@/components/shared/toastHelpers'
import * as hamiltonApi from '@/api/hamilton'

function credentialsBadgeClass(status) {
  switch (status) {
    case 'stored_reference': return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    case 'user_session_required': return 'bg-amber-50 text-amber-700 border-amber-200'
    case 'needed': return 'bg-amber-50 text-amber-800 border-amber-300'
    case 'unavailable': return 'bg-red-50 text-red-700 border-red-200'
    default: return 'bg-slate-50 text-slate-600 border-slate-200'
  }
}

export default function HamiltonPortalsPanel({ profileId }) {
  const { toast } = useToast()
  const [portals, setPortals] = useState([])
  const [links, setLinks] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!profileId) return undefined
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const [portalsResp, linksResp] = await Promise.all([
          hamiltonApi.listStudentPortals(profileId).catch(() => ({ portals: [] })),
          hamiltonApi.listFundingPortalLinks(profileId).catch(() => ({ links: [] })),
        ])
        if (cancelled) return
        setPortals(Array.isArray(portalsResp?.portals) ? portalsResp.portals : [])
        setLinks(Array.isArray(linksResp?.links) ? linksResp.links : [])
      } catch (err) {
        if (!cancelled) showErrorToast(toast, 'Hamilton portals failed to load', err?.message || 'See logs.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [profileId, toast])

  if (!profileId) return null
  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading Hamilton portal data…
        </CardContent>
      </Card>
    )
  }

  if (portals.length === 0 && links.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-600" />
            Hamilton portal connections
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-slate-500">
          Hamilton hasn't routed any funding opportunities yet. As soon as a discovered
          opportunity is added to the pipeline, Hamilton will connect it to the right
          school portal here.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-purple-600" />
          Hamilton portal connections
          <Badge variant="outline" className="text-[10px]">{portals.length} portals</Badge>
          <Badge variant="outline" className="text-[10px]">{links.length} linked</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {portals.map((p) => (
          <div key={p.id} className="border rounded p-3 space-y-1 bg-white">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-xs">{hamiltonApi.portalTypeLabel(p.portal_type)}</Badge>
              {p.school_display_name && (
                <span className="text-sm font-medium text-slate-800">{p.school_display_name}</span>
              )}
              <Badge variant="outline" className={`text-[10px] ${credentialsBadgeClass(p.credentials_status)}`}>
                {p.credentials_status === 'needed' && (<ShieldAlert className="w-3 h-3 mr-0.5" />)}
                {p.credentials_status?.replace(/_/g, ' ') || ''}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                source: {p.source}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                confidence: {Math.round((p.confidence || 0) * 100)}%
              </Badge>
            </div>
            {p.reason && (
              <p className="text-xs text-slate-500 italic">{p.reason}</p>
            )}
            {p.portal_url && (p.portal_url.startsWith('http://') || p.portal_url.startsWith('https://')) && (
              <a
                href={p.portal_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 inline-flex items-center gap-1"
              >
                <ExternalLink className="w-3 h-3" /> {p.portal_url}
              </a>
            )}
          </div>
        ))}
        {links.length > 0 && (
          <div>
            <h5 className="text-xs font-semibold text-slate-700 mt-2 mb-1">Linked funding opportunities</h5>
            <ul className="space-y-1 text-xs">
              {links.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-2 border-l-2 border-purple-200 pl-2">
                  <Badge variant="outline" className="text-[10px]">
                    {hamiltonApi.portalTypeLabel(l.portal_type)}
                  </Badge>
                  <span className="text-slate-700">conf {Math.round((l.confidence || 0) * 100)}%</span>
                  {l.requires_user_login && (
                    <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-800 border-amber-300">
                      login required
                    </Badge>
                  )}
                  {l.requires_admin_review && (
                    <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200">
                      admin review
                    </Badge>
                  )}
                  {l.application_url && (
                    <a href={l.application_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 inline-flex items-center gap-1">
                      <ExternalLink className="w-3 h-3" /> open
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
