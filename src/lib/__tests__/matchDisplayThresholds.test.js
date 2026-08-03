import { describe, expect, it } from "vitest"

import {
  AUTO_ADD_SCORE,
  STRONG_MATCH_SCORE,
  GOOD_MATCH_SCORE,
  MODERATE_MATCH_SCORE,
  MATCH_DISPLAY_TIERS,
  MIN_SCORE_SLIDER_MAX,
  MIN_SCORE_GUIDANCE_ZONES,
  minScoreBandLabel,
  translateLegacyMinScore,
  scoreToMatchTier,
  scoreToMatchLabel,
  fitPercent,
} from "../matchDisplayThresholds.js"

import * as backendThresholds from "../../../backend/config/matchThresholds.js"

/**
 * Drift tripwire.
 *
 * matchDisplayThresholds.js has carried the comment "These MUST stay in sync
 * with backend/config/matchThresholds.js" since it was written, with nothing
 * enforcing it. Two hand-maintained copies of the same numbers is precisely
 * the shape this repo's guidelines say to guard mechanically: a recalibration
 * that updated one file and not the other would leave the backend bucketing a
 * match one way while the card in front of the user read another, and every
 * test would still pass.
 *
 * Caught for real on 2026-07-31: STRONG_MATCH_SCORE 14 -> 17 had to be applied
 * in BOTH files plus MATCH_DISPLAY_TIERS.excellent.
 */
describe("frontend/backend threshold parity", () => {
  it.each([
    ["AUTO_ADD_SCORE", AUTO_ADD_SCORE],
    ["STRONG_MATCH_SCORE", STRONG_MATCH_SCORE],
    ["GOOD_MATCH_SCORE", GOOD_MATCH_SCORE],
    ["MODERATE_MATCH_SCORE", MODERATE_MATCH_SCORE],
  ])("%s matches backend/config/matchThresholds.js", (name, frontendValue) => {
    expect(frontendValue).toBe(backendThresholds[name])
  })

  it("keeps the excellent display tier ON the strong-match bar", () => {
    // The "Excellent Match" label and the "Best matches" bucket are the same
    // claim to the user; they must not be able to disagree.
    expect(MATCH_DISPLAY_TIERS.excellent).toBe(STRONG_MATCH_SCORE)
    expect(MATCH_DISPLAY_TIERS.good).toBe(GOOD_MATCH_SCORE)
  })

  it("keeps the tiers strictly ordered", () => {
    const { excellent, good, fair, potential } = MATCH_DISPLAY_TIERS
    expect(excellent).toBeGreaterThan(good)
    expect(good).toBeGreaterThan(fair)
    expect(fair).toBeGreaterThan(potential)
  })
})

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

describe("scoreToMatchTier (badge color bands)", () => {
  it("mirrors scoreToMatchLabel tiers exactly", () => {
    const cases = [
      [MATCH_DISPLAY_TIERS.excellent, "excellent", "Excellent Match"],
      [MATCH_DISPLAY_TIERS.good, "good", "Good Match"],
      [MATCH_DISPLAY_TIERS.fair, "fair", "Fair Match"],
      [MATCH_DISPLAY_TIERS.potential, "potential", "Potential Match"],
      [MATCH_DISPLAY_TIERS.potential - 1, "low", "Low Match"],
      [null, "low", "Low Match"],
    ]
    for (const [score, tier, label] of cases) {
      expect(scoreToMatchTier(score)).toBe(tier)
      expect(scoreToMatchLabel(score)).toBe(label)
    }
  })
})

describe("fitPercent (Instrumentl-style user-facing fit gauge)", () => {
  // The defect this fixes: an Excellent match (score 17) rendered as the raw
  // "17%" reads like a terrible match. The gauge must lift it to ~90% and stay
  // consistent with the tier labels.
  it("reads an Excellent match as a high percentage (never looks poor)", () => {
    expect(fitPercent(STRONG_MATCH_SCORE)).toBeGreaterThanOrEqual(90)
    expect(fitPercent(23)).toBeGreaterThanOrEqual(90) // prod p95
  })

  it("anchors the tiers to intuitive percentages", () => {
    expect(fitPercent(MODERATE_MATCH_SCORE)).toBe(60) // Potential
    expect(fitPercent(GOOD_MATCH_SCORE)).toBe(75) // Good
    expect(fitPercent(STRONG_MATCH_SCORE)).toBe(90) // Excellent
  })

  it("keeps the percentage ordered the same way as the tiers", () => {
    const { excellent, good, fair, potential } = MATCH_DISPLAY_TIERS
    expect(fitPercent(excellent)).toBeGreaterThan(fitPercent(good))
    expect(fitPercent(good)).toBeGreaterThan(fitPercent(fair))
    expect(fitPercent(fair)).toBeGreaterThan(fitPercent(potential))
  })

  it("is monotonic non-decreasing across the whole scale", () => {
    let prev = -1
    for (let s = 0; s <= 40; s++) {
      const p = fitPercent(s)
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
  })

  it("clamps to [0, 99] and never claims a perfect 100", () => {
    expect(fitPercent(0)).toBe(0)
    expect(fitPercent(-5)).toBe(0)
    expect(fitPercent(null)).toBe(0)
    expect(fitPercent(undefined)).toBe(0)
    expect(fitPercent(NaN)).toBe(0)
    expect(fitPercent(1000)).toBe(99)
    for (let s = 0; s <= 200; s++) {
      const p = fitPercent(s)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(99)
    }
  })
})

describe("translateLegacyMinScore (stored min-score preference migration)", () => {
  // The dead-slider class: a persisted need-anchored value (25/50/75/85 stops)
  // above the live track max must translate to its data-point band instead of
  // starving results forever (max real score ≈ 58; >23 is the top 1%).
  it("translates retired-scale values (>30) to their data-point band", () => {
    expect(translateLegacyMinScore(85)).toBe(STRONG_MATCH_SCORE) // the stuck owner slider
    expect(translateLegacyMinScore(75)).toBe(STRONG_MATCH_SCORE)
    expect(translateLegacyMinScore(100)).toBe(STRONG_MATCH_SCORE)
    expect(translateLegacyMinScore(60)).toBe(GOOD_MATCH_SCORE)
    expect(translateLegacyMinScore(50)).toBe(GOOD_MATCH_SCORE)
    expect(translateLegacyMinScore(40)).toBe(GOOD_MATCH_SCORE)
    expect(translateLegacyMinScore(31)).toBe(GOOD_MATCH_SCORE)
  })

  it("passes live-scale values (<=30) through untouched", () => {
    for (const v of [0, 2, MODERATE_MATCH_SCORE, AUTO_ADD_SCORE, GOOD_MATCH_SCORE, STRONG_MATCH_SCORE, 23, MIN_SCORE_SLIDER_MAX]) {
      expect(translateLegacyMinScore(v)).toBe(v)
    }
  })

  it("never returns a value above the slider max for finite input", () => {
    for (let v = 0; v <= 200; v++) {
      expect(translateLegacyMinScore(v)).toBeLessThanOrEqual(MIN_SCORE_SLIDER_MAX)
    }
  })
})

describe("MIN_SCORE_GUIDANCE_ZONES (slider band segments)", () => {
  it("is contiguous from 0 to the slider max and driven by the tier constants", () => {
    expect(MIN_SCORE_GUIDANCE_ZONES[0].min).toBe(0)
    for (let i = 1; i < MIN_SCORE_GUIDANCE_ZONES.length; i++) {
      expect(MIN_SCORE_GUIDANCE_ZONES[i].min).toBe(MIN_SCORE_GUIDANCE_ZONES[i - 1].max)
    }
    expect(MIN_SCORE_GUIDANCE_ZONES[MIN_SCORE_GUIDANCE_ZONES.length - 1].max).toBe(MIN_SCORE_SLIDER_MAX)
    // Band boundaries = the imported constants, so a recalibration moves the slider.
    expect(MIN_SCORE_GUIDANCE_ZONES.map((z) => z.min)).toEqual([
      0, MODERATE_MATCH_SCORE, GOOD_MATCH_SCORE, STRONG_MATCH_SCORE,
    ])
  })

  it("labels a slider value with its band (the value chip copy)", () => {
    expect(minScoreBandLabel(0)).toBe("Broad matches")
    expect(minScoreBandLabel(MODERATE_MATCH_SCORE - 1)).toBe("Broad matches")
    expect(minScoreBandLabel(MODERATE_MATCH_SCORE)).toBe("Good matches")
    expect(minScoreBandLabel(GOOD_MATCH_SCORE)).toBe("Strong matches")
    expect(minScoreBandLabel(STRONG_MATCH_SCORE)).toBe("Best matches")
    expect(minScoreBandLabel(MIN_SCORE_SLIDER_MAX)).toBe("Best matches")
  })

  it("keeps the slider max above the top display tier (something can always match Best)", () => {
    expect(MIN_SCORE_SLIDER_MAX).toBeGreaterThan(MATCH_DISPLAY_TIERS.excellent)
  })
})
