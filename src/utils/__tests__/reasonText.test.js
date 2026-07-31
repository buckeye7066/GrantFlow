/**
 * Tests for the reasonText layering — two functions, two contracts:
 *
 *   formatReasonText    — string COERCION only. Returns values verbatim
 *                         (never crash a render, React error #31), and its
 *                         verbatim behavior is pinned by the node:test lane
 *                         (tests/unit/reasonText.test.mjs,
 *                         grantOverviewMatchedNeeds.test.mjs) because
 *                         diagnostic consumers rely on raw values like
 *                         `missing_employer_evidence`.
 *
 *   humanizeMatchReason — the DISPLAY humanizer behind every "Why This
 *                         Matches" badge. Maps known slugs to curated copy,
 *                         title-cases unknown identifiers, passes human
 *                         sentences through.
 *
 * Learned the hard way (2026-07-31): humanization was first added into
 * formatReasonText itself, which broke the pinned verbatim contract in CI.
 * Humanize at the DISPLAY layer, never in the coercion layer.
 *
 * The slug vocabulary is taken from production 2026-07-31, by frequency over
 * profile_opportunity_matches.match_reasons.
 */

import { describe, expect, it } from "vitest"

import { formatReasonText, humanizeMatchReason } from "../reasonText.js"

describe("formatReasonText stays verbatim (the coercion contract)", () => {
  it("passes slug strings through UNTOUCHED", () => {
    // Diagnostic consumers depend on raw values; humanization is the display
    // layer's job. This is the exact regression that reddened CI.
    expect(formatReasonText("health_medical")).toBe("health_medical")
    expect(formatReasonText("missing_employer_evidence")).toBe("missing_employer_evidence")
  })

  it("coerces primitives without prettifying", () => {
    expect(formatReasonText(true)).toBe("true")
    expect(formatReasonText(42)).toBe("42")
  })
})

describe("humanizeMatchReason — the 'Why This Matches' display layer", () => {
  it.each([
    ["health_medical", "Health & medical"],
    ["nonprofit_ministry", "Nonprofit / ministry"],
    ["family_life", "Family circumstances"],
    ["technology_equipment", "Technology & equipment"],
    ["research_arts", "Research & arts"],
    ["individual", "Individual applicant"],
    ["fafsa", "FAFSA on file"],
    ["pell", "Pell-eligible"],
    ["education", "Education"],
    ["housing", "Housing"],
  ])("maps the production slug %s to curated copy", (slug, label) => {
    expect(humanizeMatchReason(slug)).toBe(label)
  })

  it("still maps the original matching-reason codes", () => {
    expect(humanizeMatchReason("keyword_match")).toBe("Matches your keywords")
    expect(humanizeMatchReason("geographic_match")).toBe("In your geographic area")
  })

  it("title-cases an UNKNOWN slug rather than leaking snake_case", () => {
    expect(humanizeMatchReason("wildfire_recovery")).toBe("Wildfire recovery")
  })

  it("leaves human-authored copy untouched", () => {
    const sentence = "Profession/major match: EMS/EMT/paramedic"
    expect(humanizeMatchReason(sentence)).toBe(sentence)
    expect(humanizeMatchReason("Serves Shelby County, TN")).toBe("Serves Shelby County, TN")
  })

  it("humanizes a slug arriving inside a structured reason object", () => {
    // Structured producers ({reason: slug}) must read like the string form.
    expect(humanizeMatchReason({ reason: "housing" })).toBe("Housing")
    expect(humanizeMatchReason({ label: "family_life" })).toBe("Family circumstances")
  })

  it("never renders an object raw, and is safe on nullish input", () => {
    expect(humanizeMatchReason(null)).toBe("")
    expect(humanizeMatchReason(undefined)).toBe("")
    expect(humanizeMatchReason("")).toBe("")
    expect(humanizeMatchReason({})).toBe("")
  })
})
