import { describe, expect, it } from "vitest"

import { scoreToMatchLabel } from "../matchDisplayThresholds.js"

describe("scoreToMatchLabel", () => {
  // Regression for the cross-component label conflict: a given score must read
  // as ONE canonical label on every surface. Need-anchored scale (2026-07-06):
  // 75 = excellent (~¾ of main needs), 50 = good (half), 25 = fair (one full
  // need), 15 = potential (partial coverage).
  it("maps a 59% score to a single canonical label everywhere", () => {
    expect(scoreToMatchLabel(59)).toBe("Good Match")
  })

  it("uses the canonical 75/50/25/15 tier boundaries", () => {
    expect(scoreToMatchLabel(75)).toBe("Excellent Match")
    expect(scoreToMatchLabel(74)).toBe("Good Match")
    expect(scoreToMatchLabel(50)).toBe("Good Match")
    expect(scoreToMatchLabel(49)).toBe("Fair Match")
    expect(scoreToMatchLabel(25)).toBe("Fair Match")
    expect(scoreToMatchLabel(24)).toBe("Potential Match")
    expect(scoreToMatchLabel(15)).toBe("Potential Match")
    expect(scoreToMatchLabel(14)).toBe("Low Match")
  })

  it("treats non-numeric / missing scores as Low Match", () => {
    expect(scoreToMatchLabel(null)).toBe("Low Match")
    expect(scoreToMatchLabel(undefined)).toBe("Low Match")
    expect(scoreToMatchLabel(NaN)).toBe("Low Match")
  })
})
