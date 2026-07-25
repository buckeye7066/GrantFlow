import { Wrench } from 'lucide-react'
import { LOGIN_MAINTENANCE } from '@/config/maintenance'

// Shared banner shown on every session-creating auth surface (Login,
// SessionExpiredDialog, SetPassword, AuthCallback) while login maintenance is
// active, so the messaging never diverges between them.
export default function LoginMaintenanceNotice() {
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
    >
      <div className="flex items-start gap-3">
        <Wrench className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
        <div>
          <p className="font-semibold">{LOGIN_MAINTENANCE.title}</p>
          <p className="mt-1">{LOGIN_MAINTENANCE.message}</p>
          <p className="mt-2 font-medium">{LOGIN_MAINTENANCE.etaText}</p>
          <p className="mt-2 text-amber-800">
            Sign-in is disabled until the upgrade completes. No action is needed on your part.
          </p>
        </div>
      </div>
    </div>
  )
}
