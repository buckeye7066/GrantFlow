import { describe, expect, it } from "vitest"

import {
  dedupeLongText,
  guardProfileSectionPayload,
  guardProfileSectionSuggestion,
} from "@/utils/profileSuggestionGuards"
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

  it("dedupeLongText: explicit empty string from the user CLEARS the field (Kimberly regression)", () => {
    // The user opened Occupational notes, deleted every character, and
    // saved. The field must end up empty. Without this contract the
    // additive merge silently restores the pre-edit text and the user
    // can never delete incorrect prose ("nonprofit employee and small
    // business owner" on a profile that is none of those things).
    expect(dedupeLongText("Kimberly is a nonprofit employee and small business owner.", "")).toBe("")
    expect(dedupeLongText("Existing text.", "   ")).toBe("")
    expect(dedupeLongText("Existing text.", "\n\n  \t\n")).toBe("")
  })

  it("dedupeLongText: null/undefined suggestion preserves existing (AI omission ≠ user clear)", () => {
    expect(dedupeLongText("Existing prose.", null)).toBe("Existing prose.")
    expect(dedupeLongText("Existing prose.", undefined)).toBe("Existing prose.")
  })

  it("dedupeLongText: non-empty suggestion still appends only NEW sentences (additive AI flow)", () => {
    const merged = dedupeLongText(
      "Kimberly receives Medicaid.",
      "Kimberly receives Medicaid. Kimberly is enrolled in ECF CHOICES.",
    )
    expect(merged).toContain("Kimberly receives Medicaid.")
    expect(merged).toContain("ECF CHOICES")
  })

  it("guardProfileSectionPayload: clearing a LONG_TEXT_FIELD round-trips an empty string for every section", () => {
    // notes / personal_statement / goals / mission / needs_description
    // are all in LONG_TEXT_FIELDS — clearing any of them via the editor
    // must persist as empty so the user can delete wrong info on any
    // profile, not just Kimberly's. We only check sections+fields that
    // are actually declared in SECTION_METADATA so we don't hit
    // unknown_field rejections.
    const cases = [
      ["occupation", "notes"],
      ["education", "notes"],
      ["narrative", "mission"],
      ["organization_details", "mission"],
      ["programs_services", "notes"],
    ]
    for (const [sectionKey, key] of cases) {
      const result = guardProfileSectionPayload(
        { [key]: "" },
        {
          sectionKey,
          profile: { primary_type: "individual" },
          existing: { [key]: "Stale text that the user wants to delete." },
        },
      )
      expect(result.data[key], `${sectionKey}.${key} should clear to ""`).toBe("")
    }
  })

  it("guardProfileSectionSuggestion: user-initiated clear of notes wins over the existing-merge spread", () => {
    // The full editor save path: ProfileDetail calls
    // guardProfileSectionSuggestion(existing, formValues). Even though
    // the wrapper spreads `{ ...existing, ...guarded.data }`, an
    // explicit empty-string in formValues must beat the existing value
    // in the spread — otherwise Kimberly's profile traps the bad notes
    // forever.
    const result = guardProfileSectionSuggestion(
      {
        notes: "Kimberly is a nonprofit employee and small business owner.",
        nonprofit_employee: true,
        small_business_owner: true,
      },
      {
        notes: "",
        nonprofit_employee: false,
        small_business_owner: false,
      },
      { sectionKey: "occupation", profile: { primary_type: "individual" } },
    )

    expect(result.data.notes).toBe("")
    expect(result.data.nonprofit_employee).toBe(false)
    expect(result.data.small_business_owner).toBe(false)
  })

  it("guardProfileSectionSuggestion: AI suggestion that omits notes preserves the user's existing prose", () => {
    // Mirror image of the above: the AI flow must NOT wipe the user's
    // notes when it returns a partial suggestion that happens to omit
    // the field. We test by passing undefined / no key.
    const result = guardProfileSectionSuggestion(
      { notes: "User-authored description that must survive AI augmentation." },
      { /* AI suggestion omits notes */ },
      { sectionKey: "narrative", profile: { primary_type: "individual" } },
    )

    expect(result.data.notes).toBe("User-authored description that must survive AI augmentation.")
  })

  it("keeps frontend and backend wrappers identical for the same input", () => {
    const args = [
      { missionary: true, notes: "student focused on academics" },
      { sectionKey: "occupation", profile: { primary_type: "individual" } },
    ]

    expect(frontendGuards.guardProfileSectionPayload(...args)).toEqual(backendGuards.guardProfileSectionPayload(...args))
  })
})
