import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { apiFetch } from '@/api/client'
import { Bell, RefreshCw } from 'lucide-react'

// Privacy-conscious default for the admin audit log: show enough of the IP to
// spot a suspicious network/pattern, but mask the host portion so we're not
// displaying full plaintext addresses of users (and so a shared screenshot
// doesn't leak them). IPv4 → last octet hidden; IPv6 → last segment hidden.
function maskIp(ip) {
  const s = String(ip || '').trim()
  if (!s) return '—'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return s.replace(/\.\d{1,3}$/, '.•')
  }
  if (s.includes(':')) {
    const parts = s.split(':')
    if (parts.length > 1) {
      // IPv6 hosts are identified by the trailing 64-bit interface
      // identifier (last 4 hextets); hide those so a screenshot can't
      // leak the full address.
      const maskCount = Math.min(4, parts.length - 1)
      for (let i = parts.length - 1; i >= parts.length - maskCount; i--) {
        parts[i] = '•'
      }
      return parts.join(':')
    }
  }
  return s
}

function formatWhen(iso) {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return String(iso || '')
  }
}

function eventTimeMs(row) {
  const ms = Date.parse(String(row?.at || ''))
  return Number.isFinite(ms) ? ms : 0
}

function mergeNewestById(incoming, previous, limit) {
  const byId = new Map()
  const combined = [
    ...(Array.isArray(incoming) ? incoming : []),
    ...(Array.isArray(previous) ? previous : []),
  ]
  combined.forEach((event) => {
    if (event?.id && !byId.has(event.id)) byId.set(event.id, event)
  })
  return Array.from(byId.values())
    .sort((a, b) => eventTimeMs(b) - eventTimeMs(a))
    .slice(0, limit)
}

export default function AdminLoginNotifications() {
  const { toast } = useToast()
  const [events, setEvents] = useState([])
  const [pageViews, setPageViews] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [degraded, setDegraded] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const lastSeenMsRef = useRef(0)
  const lastSeenViewsMsRef = useRef(0)
  const seenIdsRef = useRef(new Set())

  const fetchEvents = async ({ isManual, resetCursor } = {}) => {
    const sinceIso = !resetCursor && lastSeenMsRef.current ? new Date(lastSeenMsRef.current).toISOString() : null
    const qs = new URLSearchParams()
    if (sinceIso) qs.set('since', sinceIso)
    qs.set('limit', '50')

    const url = `/api/admin/login-events?${qs.toString()}`

    try {
      if (isManual) setRefreshing(true)
      setError(null)
      const data = await apiFetch(url)
      const incoming = Array.isArray(data?.events) ? data.events : []
      setDegraded(data?.degraded ? data?.source_status || { degraded: true } : null)

      if (incoming.length > 0 || resetCursor) {
        // Track max timestamp to advance the cursor.
        const maxMs = incoming.reduce((acc, e) => {
          const ms = Date.parse(e?.at || '')
          return Number.isFinite(ms) ? Math.max(acc, ms) : acc
        }, resetCursor ? 0 : (lastSeenMsRef.current || 0))
        lastSeenMsRef.current = maxMs

        // Toast only for unseen ids.
        const newOnes = resetCursor ? [] : incoming.filter((e) => e?.id && !seenIdsRef.current.has(e.id))
        newOnes.forEach((e) => {
          if (e?.id) seenIdsRef.current.add(e.id)
        })
        if (resetCursor) {
          seenIdsRef.current = new Set(incoming.map((e) => e?.id).filter(Boolean))
        }

        // Keep latest first, de-dupe by id.
        setEvents((prev) => {
          return mergeNewestById(incoming, resetCursor ? [] : prev, 50)
        })

        // Notify the admin (toast) for each new login.
        newOnes.slice(0, 5).forEach((e) => {
          const who = e?.identifier || 'Unknown user'
          const how = e?.method ? ` (${e.method})` : ''
          toast({
            title: 'Client signed in',
            description: `${who}${how}`,
          })
        })
      }
    } catch (err) {
      setError(err?.message || 'Failed to load login events')
      setDegraded(null)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const fetchPageViews = async ({ resetCursor } = {}) => {
    const sinceIso = !resetCursor && lastSeenViewsMsRef.current ? new Date(lastSeenViewsMsRef.current).toISOString() : null
    const qs = new URLSearchParams()
    if (sinceIso) qs.set('since', sinceIso)
    qs.set('limit', '100')

    const url = `/api/admin/page-views?${qs.toString()}`
    try {
      const data = await apiFetch(url)
      const incoming = Array.isArray(data?.page_views) ? data.page_views : []
      if (incoming.length === 0) {
        if (resetCursor) {
          lastSeenViewsMsRef.current = 0
          setPageViews([])
        }
        return
      }

      const maxMs = incoming.reduce((acc, e) => {
        const ms = Date.parse(e?.at || '')
        return Number.isFinite(ms) ? Math.max(acc, ms) : acc
      }, resetCursor ? 0 : (lastSeenViewsMsRef.current || 0))
      lastSeenViewsMsRef.current = maxMs

      setPageViews((prev) => {
        return mergeNewestById(incoming, resetCursor ? [] : prev, 200)
      })
    } catch (err) {
      // Do not block the login list if page views fail.
      console.warn('[admin/logins] page-views fetch failed', err?.message || err)
    }
  }

  useEffect(() => {
    fetchEvents().catch(() => {})
    fetchPageViews().catch(() => {})
    const id = setInterval(() => {
      fetchEvents().catch(() => {})
      fetchPageViews().catch(() => {})
    }, 15000)
    return () => clearInterval(id)
  }, [])

  const rows = useMemo(() => [...(Array.isArray(events) ? events : [])].sort((a, b) => eventTimeMs(b) - eventTimeMs(a)), [events])
  const viewRows = useMemo(() => [...(Array.isArray(pageViews) ? pageViews : [])].sort((a, b) => eventTimeMs(b) - eventTimeMs(a)), [pageViews])

  return (
    <div className="space-y-6">
      <Card className="border border-slate-200 bg-white/70 backdrop-blur">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-slate-900">
            <Bell className="h-5 w-5 text-blue-600" />
            Client login notifications
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchEvents({ isManual: true, resetCursor: true })}
            disabled={refreshing}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {degraded ? (
            <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Login audit data is degraded. Durable source status is not fully healthy.
            </div>
          ) : null}
          {loading ? (
            <div className="text-sm text-slate-600">Loading…</div>
          ) : error ? (
            <div className="text-sm text-red-700">{error}</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-slate-600">No client logins recorded yet.</div>
          ) : (
            <div className="overflow-auto rounded border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 border-b">
                  <tr>
                    <th className="text-left p-2">When</th>
                    <th className="text-left p-2">Client</th>
                    <th className="text-left p-2">Method</th>
                    <th className="text-left p-2">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id} className="border-b last:border-b-0">
                      <td className="p-2 text-slate-600">{formatWhen(e.at)}</td>
                      <td className="p-2">
                        <div className="font-medium text-slate-900">{e.identifier || 'Unknown'}</div>
                        {e.profile_id ? (
                          <div className="text-xs text-slate-500">profile: {String(e.profile_id)}</div>
                        ) : null}
                      </td>
                      <td className="p-2">
                        {e.method ? (
                          <Badge variant="secondary">{e.method}</Badge>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="p-2 text-slate-600" title="Host portion masked for privacy">{maskIp(e.ip)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border border-slate-200 bg-white/70 backdrop-blur">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-slate-900">
            Page views (recent)
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => fetchPageViews({ resetCursor: true })} disabled={refreshing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-sm text-slate-600">Loading…</div>
          ) : viewRows.length === 0 ? (
            <div className="text-sm text-slate-600">No page views recorded yet.</div>
          ) : (
            <div className="overflow-auto rounded border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 border-b">
                  <tr>
                    <th className="text-left p-2">When</th>
                    <th className="text-left p-2">Client</th>
                    <th className="text-left p-2">Page</th>
                    <th className="text-left p-2">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {viewRows.map((v) => (
                    <tr key={v.id} className="border-b last:border-b-0">
                      <td className="p-2 text-slate-600">{formatWhen(v.at)}</td>
                      <td className="p-2">
                        <div className="font-medium text-slate-900">{v.user_email || v.user_name || 'Unknown'}</div>
                        {v.profile_id ? (
                          <div className="text-xs text-slate-500">profile: {String(v.profile_id)}</div>
                        ) : null}
                      </td>
                      <td className="p-2">
                        <div className="font-medium text-slate-900">{v.path || '—'}</div>
                        {v.title ? <div className="text-xs text-slate-500">{v.title}</div> : null}
                      </td>
                      <td className="p-2 text-slate-600" title="Host portion masked for privacy">{maskIp(v.ip)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
