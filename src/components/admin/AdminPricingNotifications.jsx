import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, MailWarning } from 'lucide-react'
import { pricingApi } from '@/api/pricing'

/**
 * Page-level list of pricing toast notifications. Admin-only — rendered
 * on the existing admin dashboard so the admin can review queued + past
 * notifications without relying on the live toast popups.
 */
export function AdminPricingNotifications({ initialStatus = null }) {
  const navigate = useNavigate()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState(initialStatus)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await pricingApi.listAdminNotifications({ status: status || undefined, limit: 50 })
      if (r?.ok) setItems(r.items || [])
      else setItems([])
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => { refresh() }, [refresh])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MailWarning className="h-5 w-5" /> Pricing notifications
        </CardTitle>
        <CardDescription>
          Each notification corresponds to a new client whose pricing was just generated.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {[null, 'queued', 'delivered_live', 'delivered_on_login', 'dismissed'].map((s) => (
            <Button
              key={String(s)}
              variant={status === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatus(s)}
            >
              {s ? s.replace(/_/g, ' ') : 'all'}
            </Button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="text-sm text-muted-foreground">No notifications.</div>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((n) => (
              <li key={n.id} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col">
                  <span className="font-medium">{n.title}</span>
                  <span className="text-sm text-muted-foreground">{n.body}</span>
                  <span className="mt-1 flex flex-wrap gap-2 text-xs">
                    <Badge variant="outline">{n.status}</Badge>
                    <Badge variant="secondary">{n.notification_type}</Badge>
                    {n.created_at ? <span className="text-muted-foreground">{n.created_at}</span> : null}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {n.quote_id ? (
                    <Button
                      size="sm"
                      onClick={() => navigate(`/Admin/Pricing?quote_id=${encodeURIComponent(n.quote_id)}`)}
                    >
                      View quote
                    </Button>
                  ) : null}
                  {n.status !== 'dismissed' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await pricingApi.dismissAdminNotification(n.id)
                        refresh()
                      }}
                    >
                      Dismiss
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export default AdminPricingNotifications
