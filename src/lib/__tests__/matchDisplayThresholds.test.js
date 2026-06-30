import { describe, expect, it } from "vitest"

import { scoreToMatchLabel } from "../matchDisplayThresholds.js"

describe("scoreToMatchLabel", () => {
  // Regression for the cross-component label conflict: a 59% score read
  // "Good Match" on the AI Match Score card but "Fair Match" in the header
  // badge / pipeline card. There is now ONE helper, so every surface agrees.
  it("maps a 59% score to a single canonical label everywhere", () => {
    expect(scoreToMatchLabel(59)).toBe("Fair Match")
  })

  it("uses the canonical 80/65/50/35 tier boundaries", () => {
    expect(scoreToMatchLabel(80)).toBe("Excellent Match")
    expect(scoreToMatchLabel(79)).toBe("Good Match")
    expect(scoreToMatchLabel(65)).toBe("Good Match")
    expect(scoreToMatchLabel(64)).toBe("Fair Match")
    expect(scoreToMatchLabel(50)).toBe("Fair Match")
    expect(scoreToMatchLabel(49)).toBe("Potential Match")
    expect(scoreToMatchLabel(35)).toBe("Potential Match")
    expect(scoreToMatchLabel(34)).toBe("Low Match")
  })

  it("treats non-numeric / missing scores as Low Match", () => {
    expect(scoreToMatchLabel(null)).toBe("Low Match")
    expect(scoreToMatchLabel(undefined)).toBe("Low Match")
    expect(scoreToMatchLabel(NaN)).toBe("Low Match")
  })
})
