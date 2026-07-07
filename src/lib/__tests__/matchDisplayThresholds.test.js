import { describe, expect, it } from "vitest"

import { MATCH_DISPLAY_TIERS, scoreToMatchLabel } from "../matchDisplayThresholds.js"

describe("scoreToMatchLabel", () => {
  // Regression for the cross-component label conflict: a given score must read
  // as ONE canonical label on every surface. Data-point scale (2026-07-06
  // evening): 14 = excellent (top ~10%, old 75), 11 = good (top ~quarter, old
  // 50), 8 = fair (pipeline-bar coverage, old 25), 7 = potential (old 15).
  it("maps a mid-tier score to a single canonical label everywhere", () => {
    // 12 sits inside the Good band [good, excellent) on the data-point scale.
    expect(scoreToMatchLabel(12)).toBe("Good Match")
    // The old scale's canonical 59 is deep past the excellent bar now.
    expect(scoreToMatchLabel(59)).toBe("Excellent Match")
  })

  it("uses the canonical data-point tier boundaries (excellent/good/fair/potential)", () => {
    const { excellent, good, fair, potential } = MATCH_DISPLAY_TIERS
    expect(scoreToMatchLabel(excellent)).toBe("Excellent Match")
    expect(scoreToMatchLabel(excellent - 1)).toBe("Good Match")
    expect(scoreToMatchLabel(good)).toBe("Good Match")
    expect(scoreToMatchLabel(good - 1)).toBe("Fair Match")
    expect(scoreToMatchLabel(fair)).toBe("Fair Match")
    expect(scoreToMatchLabel(fair - 1)).toBe("Potential Match")
    expect(scoreToMatchLabel(potential)).toBe("Potential Match")
    expect(scoreToMatchLabel(potential - 1)).toBe("Low Match")
  })

  it("treats non-numeric / missing scores as Low Match", () => {
    expect(scoreToMatchLabel(null)).toBe("Low Match")
    expect(scoreToMatchLabel(undefined)).toBe("Low Match")
    expect(scoreToMatchLabel(NaN)).toBe("Low Match")
  })
})
