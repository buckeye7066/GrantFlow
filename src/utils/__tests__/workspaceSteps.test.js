import { describe, expect, it, vi } from "vitest"

// Control the profile-facts completeness deterministically so the ordering
// tests don't have to enumerate every applicable section. The count-based
// steps (documents / action-plan / pipeline) read real fields on the profile.
vi.mock("@/utils/profileCompletion", () => ({
  calculateProfileCompletion: (profile) =>
    profile?.__factsComplete
      ? { totalSections: 5, completedSections: 5, completionPct: 100, nextIncompleteSectionKey: null }
      : { totalSections: 5, completedSections: 1, completionPct: 20, nextIncompleteSectionKey: "basic_information" },
}))

import {
  WORKSPACE_STEPS,
  WORKSPACE_STEP_KEYS,
  isStepComplete,
  getNextIncompleteStep,
  getWorkspaceStepStatus,
} from "@/utils/workspaceSteps"

const factsDone = { __factsComplete: true }

describe("workspace step model", () => {
  it("defines the four ordered workspace steps matching the primary nav tabs", () => {
    expect(WORKSPACE_STEP_KEYS).toEqual(["profile", "documents", "action-plan", "pipeline"])
    // Each step's `tab` must equal its `key` so a consumer can deep-link it.
    for (const step of WORKSPACE_STEPS) {
      expect(step.tab).toBe(step.key)
      expect(step.title).toBeTruthy()
      expect(step.anyaHint).toBeTruthy()
    }
  })
})

describe("isStepComplete — green is a FACT, never a stamp", () => {
  it("profile facts complete only when there is nothing left to fill", () => {
    expect(isStepComplete("profile", { __factsComplete: false })).toBe(false)
    expect(isStepComplete("profile", factsDone)).toBe(true)
  })

  it("count-based steps are complete only on a positive count", () => {
    expect(isStepComplete("documents", { document_count: 0 })).toBe(false)
    expect(isStepComplete("documents", { document_count: 2 })).toBe(true)
    expect(isStepComplete("action-plan", { action_plan_count: 1 })).toBe(true)
    expect(isStepComplete("pipeline", { pipeline_count: 3 })).toBe(true)
  })

  it("a missing/undefined signal never reads as complete", () => {
    expect(isStepComplete("documents", {})).toBe(false)
    expect(isStepComplete("action-plan", {})).toBe(false)
    expect(isStepComplete("pipeline", {})).toBe(false)
    // Garbage / negative values are not green either.
    expect(isStepComplete("pipeline", { pipeline_count: -1 })).toBe(false)
    expect(isStepComplete("documents", { document_count: "nope" })).toBe(false)
  })

  it("returns false for a null profile and unknown step keys", () => {
    expect(isStepComplete("documents", null)).toBe(false)
    expect(isStepComplete("not-a-step", factsDone)).toBe(false)
  })
})

describe("getNextIncompleteStep — the single next logical step, in funnel order", () => {
  it("points at profile facts when facts are incomplete", () => {
    expect(getNextIncompleteStep({ __factsComplete: false }).key).toBe("profile")
  })

  it("advances to documents once facts are complete", () => {
    expect(getNextIncompleteStep({ ...factsDone, document_count: 0 }).key).toBe("documents")
  })

  it("advances to the Anya plan once facts + documents are done", () => {
    expect(getNextIncompleteStep({ ...factsDone, document_count: 1 }).key).toBe("action-plan")
  })

  it("advances to portals & pipeline once facts + documents + plan are done", () => {
    expect(
      getNextIncompleteStep({ ...factsDone, document_count: 1, action_plan_count: 1 }).key,
    ).toBe("pipeline")
  })

  it("returns null when every step is genuinely complete", () => {
    expect(
      getNextIncompleteStep({ ...factsDone, document_count: 1, action_plan_count: 1, pipeline_count: 1 }),
    ).toBeNull()
  })
})

describe("getWorkspaceStepStatus — one source of truth for cards + Anya", () => {
  it("marks exactly one step as the next (the one that pulses)", () => {
    const status = getWorkspaceStepStatus({ ...factsDone, document_count: 1 })
    const nextFlags = status.steps.filter((step) => step.isNext)
    expect(nextFlags).toHaveLength(1)
    expect(nextFlags[0].key).toBe("action-plan")
    expect(status.nextStepKey).toBe("action-plan")
    // The next step (and everything past it) is NOT green.
    expect(status.steps.find((s) => s.key === "action-plan").complete).toBe(false)
    // Steps before it ARE green.
    expect(status.steps.find((s) => s.key === "profile").complete).toBe(true)
    expect(status.steps.find((s) => s.key === "documents").complete).toBe(true)
  })

  it("reports every step done with no pulsing step when complete", () => {
    const status = getWorkspaceStepStatus({
      ...factsDone,
      document_count: 4,
      action_plan_count: 1,
      pipeline_count: 9,
    })
    expect(status.allComplete).toBe(true)
    expect(status.nextStepKey).toBeNull()
    expect(status.completedCount).toBe(4)
    expect(status.totalCount).toBe(4)
    expect(status.steps.every((step) => step.complete)).toBe(true)
    expect(status.steps.some((step) => step.isNext)).toBe(false)
  })

  it("a completed later step still shows its OWN green truth even when an earlier step pulses", () => {
    // Pipeline is truly worked, but the Anya plan was never generated: the plan
    // pulses (first incomplete), yet pipeline stays honestly green.
    const status = getWorkspaceStepStatus({ ...factsDone, document_count: 1, pipeline_count: 5 })
    expect(status.nextStepKey).toBe("action-plan")
    expect(status.steps.find((s) => s.key === "pipeline").complete).toBe(true)
    expect(status.steps.find((s) => s.key === "pipeline").isNext).toBe(false)
  })
})
