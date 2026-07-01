import { describe, expect, it } from "vitest"

import { buildAnyaPrefill } from "./anyaInterviewPrefill.js"

// These tests pin the fix for the owner-reported bug: "Ask Anya generates a list
// on most profiles instead of the interview." The root cause was the prefill
// ending with a dumped markdown list of every question, which the LLM mirrored
// back. The seed message must instead drive a one-question-at-a-time interview.

const planWithQuestions = {
  title: "Housing assistance readiness",
  plan_id: "housing",
  checklist: [
    { title: "Household size", status: "known", known_value: "4", why: "needed for AMI" },
    { title: "Monthly rent", status: "missing", why: "needed for gap" },
  ],
  interview_questions: [
    { id: "q1", prompt: "What is your current monthly rent?", why: "size the gap" },
    { id: "q2", prompt: "Are you currently behind on rent?", why: "urgency" },
    { id: "q3", prompt: "How many people live with you?", why: "AMI" },
  ],
}

describe("buildAnyaPrefill", () => {
  it("instructs a one-question-at-a-time interview, not a list", () => {
    const msg = buildAnyaPrefill(planWithQuestions, "The Doe Family")
    expect(msg).toMatch(/ONE question/i)
    expect(msg).toMatch(/NEVER paste, number, bullet, or summarize/i)
    // It must NOT reintroduce the old dumped "Questions:" list header that caused
    // the model to echo every question at once.
    expect(msg).not.toMatch(/^Questions:/m)
  })

  it("pulls the first question out as the immediate action", () => {
    const msg = buildAnyaPrefill(planWithQuestions, "The Doe Family")
    expect(msg).toContain("Start now by asking ONLY this first question: What is your current monthly rent?")
    // The remaining questions are framed as a PRIVATE queue, explicitly not shown.
    expect(msg).toMatch(/private queue .*never show this list/i)
  })

  it("treats already-known facts as do-not-re-ask reference (not a question)", () => {
    const msg = buildAnyaPrefill(planWithQuestions, "The Doe Family")
    expect(msg).toMatch(/Known facts \(do NOT re-ask/i)
    expect(msg).toContain("Household size: 4")
  })

  it("handles a plan with no required questions without dumping anything", () => {
    const msg = buildAnyaPrefill(
      { title: "Ready", plan_id: "general", checklist: [], interview_questions: [] },
      "Acme Nonprofit",
    )
    expect(msg).toMatch(/no required questions right now/i)
    expect(msg).toMatch(/one at a time/i)
    expect(msg).not.toContain("Start now by asking ONLY this first question")
  })

  it("is resilient to a null/empty plan", () => {
    const msg = buildAnyaPrefill(null, "")
    expect(msg).toContain("this profile")
    expect(msg).toMatch(/Project readiness plan/i)
    expect(typeof msg).toBe("string")
  })
})
