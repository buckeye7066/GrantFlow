import React, { useState } from 'react'
import { Share2 } from 'lucide-react'

import { GRANTFLOW_SHARE } from '@/lib/shareGrantFlow.js'

export default function ShareGrantFlowButton() {
  const [status, setStatus] = useState('')
  const share = async () => {
    setStatus('')
    try {
      if (navigator.share) await navigator.share({ ...GRANTFLOW_SHARE })
      else { await navigator.clipboard.writeText(GRANTFLOW_SHARE.url); setStatus('App link copied.') }
    } catch (error) {
      if (error.name !== 'AbortError') setStatus('Share this app link: ' + GRANTFLOW_SHARE.url)
    }
  }
  return <div>
    <button type="button" onClick={share} className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm"><Share2 className="h-4 w-4" />Share GrantFlow</button>
    {status && <p role="status" className="mt-1 break-words text-xs">{status}</p>}
  </div>
}
