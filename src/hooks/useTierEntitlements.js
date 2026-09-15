import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { getBillingOverview, getTierCatalog } from "@/api/billing"
import { useAuthStore } from "@/stores/authStore"
import { hasFullAdminWorkspace } from "@/lib/workspaceAccess"
import { isRealProfileId } from "@/api/profileIdGuards"

/**
 * useTierEntitlements(profileId)
 *
 * The ONE place the frontend asks "what can this profile do?". Replaces the
 * scattered `canUseFeature(billing, 'enable_x')` checks. Reads the profile's
 * billing (non-admin safe) + the canonical catalog, and returns capabilities,
 * locked features, and plain-English upgrade messaging.
 *
 * Admins bypass all gates (mirrors the backend). Capability keys are the SAME
 * ones the backend enforces — the catalog's `CAPABILITY_KEYS`. There were three
 * until 2026-09-15; there are now ten, because three could not express a
 * seven-rung ladder and every tier had ended up granting everything.
 *
 * This map IS the frontend's vocabulary: both `capabilities` and `locked` are
 * derived from it, so a flag missing here has no shorthand AND never appears in
 * the locked list the upgrade prompts are built from. Enforcement is still the
 * backend's (`can(key)` passes any raw key straight through), but keep this in
 * step with `shared/tierCatalog.js` CAPABILITY_KEYS.
 */
const CAP = {
  documentAI: "enable_document_ai",
  itemFunding: "enable_item_funding",
  matchingIntelligence: "enable_matching_intelligence",
  applicationDrafting: "enable_application_drafting",
  pipelineAutomation: "enable_pipeline_automation",
  autoSubmit: "enable_auto_submit",
  funderIntelligence: "enable_funder_intelligence",
  outreach: "enable_outreach",
  complianceReporting: "enable_compliance_reporting",
  bulkExport: "enable_bulk_export",
}

export function useTierEntitlements(profileId) {
  // The auth store keeps the admin bit on `user.is_admin` (there is no
  // top-level `isAdmin` and no `user.role`). Reading `s.isAdmin` answered
  // "not admin" for every administrator, so the owner was gated by the selected
  // profile's billing and the Automation tab requested
  // GET /api/billing/me/__admin__ (404) in production (2026-09-11).
  const isAdmin = useAuthStore((s) => s.isAdmin === true || hasFullAdminWorkspace(s.user))
  // `__admin__` / "all" / "none" are UI-only selector values, never billing rows.
  const billingProfileId =
    isRealProfileId(profileId) && profileId !== "all" && profileId !== "none" ? profileId : null

  const billingQuery = useQuery({
    queryKey: ["billing-overview", billingProfileId],
    queryFn: () => getBillingOverview(billingProfileId),
    enabled: Boolean(billingProfileId) && !isAdmin,
    staleTime: 60_000,
  })
  const catalogQuery = useQuery({
    queryKey: ["tier-catalog"],
    queryFn: getTierCatalog,
    staleTime: 5 * 60_000,
  })

  return useMemo(() => {
    const tier = billingQuery.data?.account?.tier || null
    const entitlements = billingQuery.data?.entitlements?.capabilities || null
    const catalog = catalogQuery.data || null
    const loading = (!isAdmin && billingQuery.isLoading) || catalogQuery.isLoading
    const error = billingQuery.error || catalogQuery.error || null

    // The server decision is authoritative because it includes payment state,
    // suspension, promotions and add-ons. Tier flags are only a rolling-deploy
    // fallback while an older backend is still serving the new frontend.
    const decisionFor = (key) => entitlements?.[key] || null
    const has = (key) => isAdmin || (decisionFor(key)
      ? decisionFor(key).allowed === true
      : Boolean(tier?.[key]))

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
      const decision = decisionFor(key)
      if (decision?.reason === "entitlement_authority_unavailable") {
        return `GrantFlow couldn’t verify ${feature} access. Nothing will run until billing can be verified.`
      }
      if (decision?.payment_required) {
        return `Payment or an approved waiver is required before ${feature} can run.`
      }
      if (String(decision?.reason || "").startsWith("profile_")) {
        return `This profile is paused. Resolve the account hold before using ${feature}.`
      }
      return target
        ? `${feature} isn’t included in your ${tier?.name || "current"} plan. Upgrade to ${target.name} or add ${feature} to unlock it.`
        : `${feature} requires an active add-on.`
    }

    /* DERIVED from CAP, not hand-listed. Three of these were enumerated by
       hand while `locked` below already iterated CAP — so expanding the
       vocabulary from three flags to ten (2026-09-15) would have left seven
       capabilities correctly LOCKED but invisible to `capabilities.*`, and a
       consumer reading `capabilities.autoSubmit` would get `undefined`, which
       is falsy and therefore indistinguishable from "denied". */
    const capabilities = Object.fromEntries(
      Object.entries(CAP).map(([name, key]) => [name, has(key)]),
    )
    const locked = Object.entries(CAP)
      .filter(([, key]) => !has(key))
      .map(([name, key]) => ({ name, key, label: labelFor(key), upgradeMessage: upgradeMessage(key) }))
    const addons = [...new Map(
      Object.values(entitlements || {})
        .flatMap((decision) => decision?.active_addons || [])
        .map((addon) => [addon.id, addon]),
    ).values()]

    return {
      loading,
      error,
      isAdmin,
      tier,
      billing: billingQuery.data?.billing || null,
      entitlements,
      addons,
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
