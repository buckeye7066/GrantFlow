import { describe, expect, it } from "vitest"

import { guardProfileSectionSuggestion } from "@/utils/profileSuggestionGuards"

describe("guardProfileSectionSuggestion", () => {
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
})
