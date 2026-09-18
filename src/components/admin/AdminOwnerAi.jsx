import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/api/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function AdminOwnerAi() {
  const { data } = useQuery({ queryKey: ['owner-ai-status'], queryFn: () => apiFetch('/api/admin/owner-ai/status'), retry: false, refetchInterval: 15000 })
  // The exact canonical-owner predicate is evaluated by the server, not browser claims.
  if (!data) return null
  return <Card>
    <CardHeader><CardTitle>Owner subscription bridge</CardTitle></CardHeader>
    <CardContent>
      <p>{!data.enabled ? 'Disabled' : !data.online ? 'Home unavailable' : data.busy ? 'Busy' : 'Home connected'}</p>
      <p>Order: {data.order.join(' → ')}</p>
      {Object.entries(data.providers).map(([name, state]) => <p key={name}>{name}: {state === 'auth_required' ? 'Sign-in required' : state}</p>)}
      <p>Owner requests only. Subscription limits apply. Paid API fallback is separate.</p>
    </CardContent>
  </Card>
}
