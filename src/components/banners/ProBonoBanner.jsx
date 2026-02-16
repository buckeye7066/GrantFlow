import React from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, X, FileDown } from "lucide-react"
import { useAuthStore } from "@/stores/authStore"
import { apiFetch } from "@/api/client"

const DISMISS_KEY = "grantflow:pro-bono-banner-dismissed"
const PDF_URL = `${import.meta.env.BASE_URL}docs/Payment_sheet_Grantflow.pdf`

/**
 * ProBonoBanner
 * Shown to users whose active profile/organization is marked as pro bono.
 * Warns that pro bono status ends in 30 days and charges will begin based on
 * their tier and add-ons. Includes a download link for the payment sheet.
 * Dismissible per-session (stored in localStorage).
 */
export default function ProBonoBanner() {
  const [dismissed, setDismissed] = React.useState(() => {
    if (typeof window === "undefined") return false
    return localStorage.getItem(DISMISS_KEY) === "true"
  })

  const activeProfileId = useAuthStore((s) => s.activeProfileId)
  const user = useAuthStore((s) => s.user)

  // Fetch the active profile to check billing.is_pro_bono
  const { data: profile } = useQuery({
    queryKey: ["profile", activeProfileId],
    queryFn: () => apiFetch(`/api/profiles/${activeProfileId}`),
    enabled: Boolean(activeProfileId) && activeProfileId !== "__admin__",
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  const isProBono = Boolean(profile?.billing?.is_pro_bono)

  // Don't show for admins viewing in admin mode, dismissed users, or non-pro-bono
  if (dismissed || !isProBono || activeProfileId === "__admin__") return null

  const tierName = profile?.billing?.tier?.name || profile?.billing?.tier_id || "your current tier"

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, "true")
    setDismissed(true)
  }

  return (
    <div className="relative bg-amber-50 border-b border-amber-200">
      <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-900">
              <p className="font-semibold">Important: Pro Bono Status Ending Soon</p>
              <p className="mt-1">
                Your pro bono arrangement will end in <strong>30 days</strong>. After that,
                charges will begin based on <strong>{tierName}</strong> and any active add-ons.
                Please review the payment sheet below for full pricing details.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={PDF_URL}
              download="Payment_sheet_Grantflow.pdf"
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-amber-700 transition-colors"
            >
              <FileDown className="h-4 w-4" />
              Payment Sheet
            </a>
            <button
              onClick={handleDismiss}
              className="rounded-md p-1 text-amber-600 hover:bg-amber-100 hover:text-amber-800 transition-colors"
              aria-label="Dismiss banner"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
