import { describe, expect, it } from "vitest"
import { federalSearchErrorMessage, isFederalQuotaError } from "../federalSearchError.js"

const quotaError = (retryAt) => Object.assign(new Error("federal_listings_quota_exhausted"), {
  status: 503,
  errorCode: "federal_listings_quota_exhausted",
  details: { error: "federal_listings_quota_exhausted", upstream_status: 429, retry_at: retryAt },
})

describe("federal search error message", () => {
  it("names the SAM.gov daily limit and when it returns", () => {
    const retryAt = "2026-09-12T00:00:00.000Z"
    const message = federalSearchErrorMessage(quotaError(retryAt))
    expect(message).toContain("daily request limit")
    expect(message).toContain(new Date(retryAt).toLocaleString())
  })

  it("omits the time when the backend could not state one", () => {
    expect(federalSearchErrorMessage(quotaError(null))).toBe(
      "The federal program catalog (SAM.gov) has reached its daily request limit.",
    )
    expect(federalSearchErrorMessage(quotaError("not a date"))).not.toContain("available again")
  })

  it("reports any other failure without claiming a quota", () => {
    const error = Object.assign(new Error("Request failed"), { status: 502, errorCode: "federal_listings_unavailable" })
    expect(isFederalQuotaError(error)).toBe(false)
    expect(federalSearchErrorMessage(error)).toBe("Federal programs could not be loaded. Please try again.")
  })

  it("says nothing when there is no error", () => {
    expect(federalSearchErrorMessage(null)).toBeNull()
  })
})
