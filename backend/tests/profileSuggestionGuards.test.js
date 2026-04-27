import { describe, expect, it } from "vitest"

import { guardProfileSectionPayload } from "../utils/profileSuggestionGuards.js"
import * as backendGuards from "../utils/profileSuggestionGuards.js"
import * as frontendGuards from "../../src/utils/profileSuggestionGuards.js"

describe("backend profileSuggestionGuards", () => {
  it("rejects high school occupation flags without employer evidence", () => {
    const result = guardProfileSectionPayload(
      { missionary: true },
      { sectionKey: "occupation", profile: { primary_type: "high_school_student" } },
    )

    expect(result.data.missionary).toBeUndefined()
    expect(result.rejected).toContainEqual(expect.objectContaining({ key: "missionary", reason: "missing_employer_evidence" }))
  })

  it("accepts occupation flags with employer evidence", () => {
    const result = guardProfileSectionPayload(
      { missionary: true, missionary_evidence: "Hired by Cru in 2024-09" },
      { sectionKey: "occupation", profile: { primary_type: "high_school_student" } },
    )

    expect(result.data.missionary).toBe(true)
    expect(result.rejected).toEqual([])
  })

  it("rejects occupation flags contradicted by student academic notes", () => {
    const result = guardProfileSectionPayload(
      { nonprofit_employee: true, notes: "student focused on academics" },
      { sectionKey: "occupation", profile: { primary_type: "individual" } },
    )

    expect(result.data.nonprofit_employee).toBeUndefined()
    expect(result.rejected).toContainEqual(expect.objectContaining({ key: "nonprofit_employee", reason: "missing_employer_evidence" }))
  })

  it("routes household evidence away from applicant self benefit fields", () => {
    const result = guardProfileSectionPayload(
      {
        ssdi_recipient_self: true,
        ssdi_recipient_self_evidence: "dependent child of an SSDI recipient",
      },
      { sectionKey: "government_assistance", profile: { primary_type: "high_school_student" } },
    )

    expect(result.data.ssdi_recipient_self).toBeUndefined()
    expect(result.data.ssdi_recipient_household).toBe(true)
  })

  it("dedupes near-duplicate long text", () => {
    const result = guardProfileSectionPayload(
      { mission: "Student needs scholarship support for college applications." },
      {
        sectionKey: "organization_details",
        profile: { primary_type: "high_school_student" },
        existing: { mission: "Student needs scholarship support for college applications." },
      },
    )

    expect(result.data.mission).toBe("Student needs scholarship support for college applications.")
  })

  it("rejects unknown keys leaking labels into the payload", () => {
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

  it("keeps frontend and backend wrappers identical", () => {
    const args = [
      { missionary: true, notes: "student focused on academics" },
      { sectionKey: "occupation", profile: { primary_type: "individual" } },
    ]

    expect(backendGuards.guardProfileSectionPayload(...args)).toEqual(frontendGuards.guardProfileSectionPayload(...args))
  })
})
