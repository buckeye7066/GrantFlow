import { describe, expect, it } from "vitest"

import { guardProfileSectionPayload, guardProfileSectionSuggestion } from "@/utils/profileSuggestionGuards"
import * as frontendGuards from "@/utils/profileSuggestionGuards"
import * as backendGuards from "../../../backend/utils/profileSuggestionGuards.js"

describe("guardProfileSectionSuggestion", () => {
  it("rejects occupation identity flags for high school students without employer evidence", () => {
    const result = guardProfileSectionPayload(
      { missionary: true },
      { sectionKey: "occupation", profile: { primary_type: "high_school_student" } },
    )

    expect(result.data.missionary).toBeUndefined()
    expect(result.rejected).toContainEqual(expect.objectContaining({ key: "missionary", reason: "missing_employer_evidence" }))
  })

  it("accepts occupation identity flags when employer evidence is present", () => {
    const result = guardProfileSectionPayload(
      { missionary: true, missionary_evidence: "Hired by Cru in 2024-09" },
      { sectionKey: "occupation", profile: { primary_type: "high_school_student" } },
    )

    expect(result.data.missionary).toBe(true)
    expect(result.rejected).toEqual([])
  })

  it("rejects occupation identity flags contradicted by student academic notes", () => {
    const result = guardProfileSectionPayload(
      { nonprofit_employee: true, notes: "student focused on academics" },
      { sectionKey: "occupation", profile: { primary_type: "individual" }, sections: { employment: { current_status: "employed_full_time" } } },
    )

    expect(result.data.nonprofit_employee).toBeUndefined()
    expect(result.rejected).toContainEqual(expect.objectContaining({ key: "nonprofit_employee", reason: "missing_employer_evidence" }))
  })

  it("dedupes near-duplicate long-text AI suggestions", () => {
    const result = guardProfileSectionSuggestion(
      { notes: "Student needs scholarship support for college applications." },
      { notes: "Student needs scholarship support for college applications." },
      { sectionKey: "narrative", profile: { primary_type: "high_school_student" } },
    )

    expect(result.data.notes).toBe("Student needs scholarship support for college applications.")
  })

  it("routes household-qualified benefit evidence away from applicant self fields", () => {
    const result = guardProfileSectionSuggestion(
      {},
      {
        ssdi_recipient_self: true,
        ssdi_recipient_self_evidence: "dependent child of an SSDI recipient",
      },
      { sectionKey: "government_assistance", profile: { primary_type: "high_school_student" } },
    )

    expect(result.data.ssdi_recipient_self).toBeUndefined()
    expect(result.data.ssdi_recipient_household).toBe(true)
  })

  it("rejects unknown section keys leaking label text into the payload", () => {
    const result = guardProfileSectionPayload(
      { missionary_evangelist: true },
      { sectionKey: "occupation", profile: { primary_type: "individual" } },
    )

    expect(result.data.missionary_evangelist).toBeUndefined()
    expect(result.rejected).toContainEqual(expect.objectContaining({ key: "missionary_evangelist", reason: "unknown_field" }))
  })

  it("rejects format mismatches and accepts declared string fields", () => {
    expect(
      guardProfileSectionPayload(
        { foo_bar: 1 },
        { sectionKey: "narrative", profile: { primary_type: "individual" } },
      ).rejected,
    ).toContainEqual(expect.objectContaining({ key: "foo_bar", reason: "unknown_field" }))

    expect(
      guardProfileSectionPayload(
        { primary_goal: "x" },
        { sectionKey: "narrative", profile: { primary_type: "individual" } },
      ).data.primary_goal,
    ).toBe("x")

    expect(
      guardProfileSectionPayload(
        { primary_goal: 42 },
        { sectionKey: "narrative", profile: { primary_type: "individual" } },
      ).rejected,
    ).toContainEqual(expect.objectContaining({ key: "primary_goal", reason: "format_mismatch" }))
  })

  it("keeps frontend and backend wrappers identical for the same input", () => {
    const args = [
      { missionary: true, notes: "student focused on academics" },
      { sectionKey: "occupation", profile: { primary_type: "individual" } },
    ]

    expect(frontendGuards.guardProfileSectionPayload(...args)).toEqual(backendGuards.guardProfileSectionPayload(...args))
  })
})
