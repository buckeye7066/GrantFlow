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

  it("rejects negative income, absurd values, and fractional household size on the financial section", () => {
    const result = guardProfileSectionPayload(
      { annual_income: -5000, household_income: 99999999999, household_size: 3.7 },
      { sectionKey: "financial_information", profile: { primary_type: "individual" } },
    )
    // All three garbage values are rejected at the choke point, not persisted.
    expect(result.data.annual_income).toBeUndefined()
    expect(result.data.household_income).toBeUndefined()
    expect(result.data.household_size).toBeUndefined()
    expect(result.rejected.map((r) => r.key).sort()).toEqual(
      ["annual_income", "household_income", "household_size"].sort(),
    )
  })

  it("accepts valid financial values (coerces strings to numbers)", () => {
    const result = guardProfileSectionPayload(
      { annual_income: "45000", household_income: 60000, household_size: "4" },
      { sectionKey: "financial_information", profile: { primary_type: "individual" } },
    )
    expect(result.data.annual_income).toBe(45000)
    expect(result.data.household_income).toBe(60000)
    expect(result.data.household_size).toBe(4)
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

  it("normalizes legacy basic_information field aliases instead of silently dropping them", () => {
    // Regression: ZIP / Profile category were sent under short keys (zip,
    // profile_category) that the section schema didn't recognize, so the guard
    // dropped them as unknown_field — silent data loss (ZIP especially, which
    // matching depends on). They must now route to the canonical field, and
    // directly-entered age must be accepted rather than discarded.
    const result = guardProfileSectionPayload(
      { zip: "37201", profile_category: "veteran", age: "45" },
      { sectionKey: "basic_information", profile: { primary_type: "individual" } },
    )

    expect(result.data.zip_code).toBe("37201")
    expect(result.data.profile_type).toBe("veteran")
    expect(result.data.age).toBe("45")
    // Aliased/routed fields are not genuine drops (they carry routedTo); nothing
    // should be dropped as unknown_field here.
    const dropped = result.rejected.filter((r) => !r.routedTo)
    expect(dropped).toEqual([])
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

  it("normalizes known aliases and structured string arrays", () => {
    const education = guardProfileSectionPayload(
      { current_school: "Central High" },
      { sectionKey: "education", profile: { primary_type: "high_school_student" } },
    )
    expect(education.data.current_institution).toBe("Central High")
    expect(education.rejected).toContainEqual(expect.objectContaining({ key: "current_school", reason: "normalized_alias", routedTo: "current_institution" }))

    const demographics = guardProfileSectionPayload(
      { languages: { primary: "English", other: ["Russian"] } },
      { sectionKey: "demographics", profile: { primary_type: "individual" } },
    )
    expect(demographics.data.languages).toEqual(["English", "Russian"])
  })

  it("keeps frontend and backend wrappers identical", () => {
    const args = [
      { missionary: true, notes: "student focused on academics" },
      { sectionKey: "occupation", profile: { primary_type: "individual" } },
    ]

    expect(backendGuards.guardProfileSectionPayload(...args)).toEqual(frontendGuards.guardProfileSectionPayload(...args))
  })
})
