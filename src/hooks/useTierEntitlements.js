import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { getBillingOverview, getTierCatalog } from "@/api/billing"
import { useAuthStore } from "@/stores/authStore"

/**
 * useTierEntitlements(profileId)
 *
 * The ONE place the frontend asks "what can this profile do?". Replaces the
 * scattered `canUseFeature(billing, 'enable_x')` checks. Reads the profile's
 * billing (non-admin safe) + the canonical catalog, and returns capabilities,
 * locked features, and plain-English upgrade messaging.
 *
 * Admins bypass all gates (mirrors the backend). Capability keys are the SAME
 * three the backend enforces: enable_document_ai, enable_item_funding,
 * enable_pipeline_automation.
 */
const CAP = {
  documentAI: "enable_document_ai",
  itemFunding: "enable_item_funding",
  pipelineAutomation: "enable_pipeline_automation",
}

export function useTierEntitlements(profileId) {
  const isAdmin = useAuthStore((s) => s.isAdmin === true || s.user?.role === "admin")

  const billingQuery = useQuery({
    queryKey: ["billing-overview", profileId],
    queryFn: () => getBillingOverview(profileId),
    enabled: Boolean(profileId) && !isAdmin,
    staleTime: 60_000,
  })
  const catalogQuery = useQuery({
    queryKey: ["tier-catalog"],
    queryFn: getTierCatalog,
    staleTime: 5 * 60_000,
  })

  return useMemo(() => {
    const tier = billingQuery.data?.account?.tier || null
    const catalog = catalogQuery.data || null
    const loading = (!isAdmin && billingQuery.isLoading) || catalogQuery.isLoading
    const error = billingQuery.error || catalogQuery.error || null

    const has = (key) => isAdmin || Boolean(tier?.[key])

    // The cheapest tier in the catalog that unlocks a given capability — used to
    // tell the user exactly what to upgrade to.
    const lowestTierWith = (key) => {
      const tiers = catalog?.tiers || []
      return tiers.find((t) => t.capabilities?.[key]) || null
    }
    const labelFor = (key) => catalog?.capability_labels?.[key]?.label || key
    const upgradeMessage = (key) => {
      if (has(key)) return null
      const target = lowestTierWith(key)
      const feature = labelFor(key)
      return target
        ? `${feature} isn’t included in your ${tier?.name || "current"} plan. Upgrade to ${target.name} to unlock it.`
        : `${feature} isn’t included in your current plan.`
    }

    const capabilities = {
      documentAI: has(CAP.documentAI),
      itemFunding: has(CAP.itemFunding),
      pipelineAutomation: has(CAP.pipelineAutomation),
    }
    const locked = Object.entries(CAP)
      .filter(([, key]) => !has(key))
      .map(([name, key]) => ({ name, key, label: labelFor(key), upgradeMessage: upgradeMessage(key) }))

    return {
      loading,
      error,
      isAdmin,
      tier,
      billing: billingQuery.data?.billing || null,
      capabilities,
      can: (key) => has(key),
      locked,
      upgradeMessage,
      CAP,
      catalog,
    }
  }, [billingQuery.data, billingQuery.isLoading, billingQuery.error, catalogQuery.data, catalogQuery.isLoading, catalogQuery.error, isAdmin])
}

export { CAP as TIER_CAPABILITY_KEYS }
