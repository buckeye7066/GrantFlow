/**
 * REGRESSION: the "Profile Action Plan buttons do nothing" dead-click class.
 *
 * ProfileDetail handles ?tab=&section=&field=&focus= deep links in an effect
 * guarded by a token. The token MUST incorporate the router's location.key:
 * react-router assigns a fresh key on EVERY navigation, including a <Link>
 * click to the identical URL. A token built from param values alone treats a
 * re-click as already-handled — so every plan/checklist/reminder button went
 * dead after its first use (the bug shipped at least twice).
 */

import { describe, expect, it } from "vitest"
import { buildDeepLinkToken, isActionableDeepLink } from "./deepLinkToken"

describe("buildDeepLinkToken", () => {
  const params = { tab: "pipeline", section: "", field: "", focus: "portal-logins" }

  it("a RE-CLICK (same params, new location.key) yields a NEW token — the click must be handled again", () => {
    const first = buildDeepLinkToken({ locationKey: "k1", ...params })
    const reclick = buildDeepLinkToken({ locationKey: "k2", ...params })
    expect(reclick).not.toBe(first)
  })

  it("a re-render within the SAME navigation (same key + params) yields the SAME token — no double-handling", () => {
    const a = buildDeepLinkToken({ locationKey: "k1", ...params })
    const b = buildDeepLinkToken({ locationKey: "k1", ...params })
    expect(a).toBe(b)
  })

  it("different targets under the same key yield different tokens", () => {
    const a = buildDeepLinkToken({ locationKey: "k1", tab: "pipeline", focus: "portal-logins" })
    const b = buildDeepLinkToken({ locationKey: "k1", tab: "documents" })
    expect(a).not.toBe(b)
  })

  it("tolerates missing values", () => {
    expect(buildDeepLinkToken({})).toBe("||||")
    expect(buildDeepLinkToken()).toBe("||||")
  })
})

describe("isActionableDeepLink", () => {
  it("false when the URL carries no deep-link params (nothing to handle)", () => {
    expect(isActionableDeepLink({})).toBe(false)
    expect(isActionableDeepLink({ tab: "", section: "", field: "", focus: "" })).toBe(false)
    expect(isActionableDeepLink()).toBe(false)
  })

  it("true when any deep-link param is present", () => {
    expect(isActionableDeepLink({ tab: "pipeline" })).toBe(true)
    expect(isActionableDeepLink({ focus: "portal-logins" })).toBe(true)
    expect(isActionableDeepLink({ section: "financial_information", field: "household_income" })).toBe(true)
  })
})
