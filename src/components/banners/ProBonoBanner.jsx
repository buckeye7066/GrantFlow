import React, { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, X, FileDown } from "lucide-react"
import { useAuthStore } from "@/stores/authStore"
import { apiFetch } from "@/api/client"
import { isRealProfileId } from "@/api/profileIdGuards"

const DISMISS_KEY = "grantflow:pro-bono-banner-dismissed"
const PDF_URL = `${(import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "")}/docs/Payment_sheet_Grantflow.pdf`

/**
   * ProBonoBanner
   * Shown to users whose active profile/organization is marked as pro bono.
   * Computes a real countdown based on billing.pro_bono_started_at (or created_at
   * fallback).  When the end date has passed the banner switches to an "expired"
   * message.  Dismissible per-session (stored in localStorage).
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
        enabled: isRealProfileId(activeProfileId),
        staleTime: 5 * 60 * 1000,
        retry: false,
  })

  const isProBono = Boolean(profile?.billing?.is_pro_bono)

  // Compute days remaining from the pro bono start/end dates
  const { daysRemaining, endDateLabel } = useMemo(() => {
        if (!isProBono) return { daysRemaining: null, endDateLabel: "" }

                                                      const billing = profile?.billing ?? {}

                                                            // Only an EXPLICIT end date can announce an ending. Pro bono is an
                                                            // admin-only flag with no built-in term (billing_accounts.is_pro_bono,
                                                            // #1597); deriving an end from profile.created_at + 30 days told a
                                                            // live pro bono client "Your pro bono arrangement has ended" and that
                                                            // charges now apply — false on both counts (prod, 2026-09-07).
                                                            let endDate = null
        if (billing.pro_bono_end_date) {
                endDate = new Date(billing.pro_bono_end_date)
        }

                                                      if (!endDate || Number.isNaN(endDate.getTime())) {
                                                              return { daysRemaining: null, endDateLabel: "" }
                                                      }

                                                      const now = new Date()
        const diffMs = endDate.getTime() - now.getTime()
        const days = Math.max(0, Math.ceil(diffMs / 86_400_000))
        const label = endDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
        return { daysRemaining: days, endDateLabel: label }
  }, [isProBono, profile])

  // Don't show for admins, dismissed users, non-pro-bono, or a pro bono
  // arrangement with no declared end date (nothing is ending).
  if (dismissed || !isProBono || activeProfileId === "__admin__") return null
  if (daysRemaining === null) return null

  const tierName = profile?.billing?.tier?.name || profile?.billing?.tier_id || "your current tier"

  const handleDismiss = () => {
        localStorage.setItem(DISMISS_KEY, "true")
        setDismissed(true)
  }

  const isExpired = daysRemaining === 0
    const daysLabel = daysRemaining === 1 ? "1 day" : `${daysRemaining} days`

  return (
        <div className="relative bg-amber-50 border-b border-amber-200">
              <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="flex items-start gap-3 flex-1 min-w-0">
                                            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                                            <div className="text-sm text-amber-900">
                                                          <p className="font-semibold">
                                                            {isExpired
                                                                                ? "Pro Bono Period Has Ended"
                                                                                : "Important: Pro Bono Status Ending Soon"}
                                                          </p>
                                                          <p className="mt-1">
                                                            {isExpired ? (
                            <>
                                                Your pro bono arrangement has ended. Charges will now apply
                                                based on <strong>{tierName}</strong> and any active add-ons.
                                                Please review the payment sheet for full pricing details.
                            </>
                          ) : (
                            <>
                                                Your pro bono arrangement will end in{" "}
                                                <strong>{daysLabel}</strong>
                              {endDateLabel && <> (on {endDateLabel})</>}. After that,
                                                charges will begin based on <strong>{tierName}</strong> and
                                                any active add-ons. Please review the payment sheet below
                                                for full pricing details.
                            </>
                          )}
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
