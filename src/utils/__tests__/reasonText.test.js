/**
 * Tests for reasonText — the renderer behind the "Why This Matches" badges on
 * the matcher, grant cards and the source trace.
 *
 * Two jobs, both load-bearing:
 *   1. never crash a render (React error #31: objects as children), and
 *   2. never show the profile owner a raw producer slug when explaining why a
 *      funding source fits their needs.
 *
 * The slug vocabulary is taken from production on 2026-07-31, by frequency
 * over profile_opportunity_matches.match_reasons.
 */

import { describe, expect, it } from "vitest"

import { formatReasonText, humanizeReasonSlug } from "../reasonText.js"

describe("humanizeReasonSlug", () => {
  it.each([
    ["health_medical", "Health & medical"],
    ["nonprofit_ministry", "Nonprofit / ministry"],
    ["family_life", "Family circumstances"],
    ["technology_equipment", "Technology & equipment"],
    ["research_arts", "Research & arts"],
    ["individual", "Individual applicant"],
    ["fafsa", "FAFSA on file"],
    ["pell", "Pell-eligible"],
  ])("maps the production slug %s to a human label", (slug, label) => {
    expect(humanizeReasonSlug(slug)).toBe(label)
  })

  it("de-slugifies an UNKNOWN slug rather than leaking snake_case", () => {
    // A new producer slug must degrade gracefully, never reach the user raw.
    expect(humanizeReasonSlug("wildfire_recovery")).toBe("Wildfire Recovery")
    expect(humanizeReasonSlug("childcare")).toBe("Childcare")
  })

  it("leaves human-authored copy untouched", () => {
    // Real production value — already a sentence, must not be mangled.
    const sentence = "Profession/major match: EMS/EMT/paramedic"
    expect(humanizeReasonSlug(sentence)).toBe(sentence)
    expect(humanizeReasonSlug("Serves Shelby County, TN")).toBe("Serves Shelby County, TN")
  })

  it("is safe on empty / nullish input", () => {
    expect(humanizeReasonSlug(null)).toBe("")
    expect(humanizeReasonSlug(undefined)).toBe("")
    expect(humanizeReasonSlug("")).toBe("")
  })
})

describe("formatReasonText", () => {
  it("humanizes a plain slug", () => {
    expect(formatReasonText("health_medical")).toBe("Health & medical")
  })

  it("humanizes a slug arriving inside a structured reason object", () => {
    // Both producer shapes must read identically to the user.
    expect(formatReasonText({ reason: "housing" })).toBe("Housing")
    expect(formatReasonText({ label: "family_life" })).toBe("Family circumstances")
  })

  it("keeps the source annotation on a {reason, source} object", () => {
    expect(formatReasonText({ reason: "housing", source: "matchEngine" })).toBe(
      "Housing (matchEngine)",
    )
  })

  it("joins an array of slugs as human labels", () => {
    expect(formatReasonText(["housing", "veteran"])).toBe("Housing, Veteran")
  })

  it("still never renders an object as a React child", () => {
    // The original reason this module exists.
    expect(formatReasonText({})).toBe("")
    expect(formatReasonText(null)).toBe("")
    expect(formatReasonText(undefined)).toBe("")
    expect(formatReasonText({ unknownKey: "x", other: 1 })).toContain("unknownKey")
  })
})
