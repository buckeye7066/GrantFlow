import { describe, expect, it } from "vitest"

import { SECTION_METADATA } from "@/config/sectionMetadata"
import { calculateProfileCompletion, getApplicableSectionKeys } from "@/utils/profileCompletion"

describe("profile section applicability", () => {
  it("excludes non-applicable organization, medical, nonprofit, and business sections for a high school student", () => {
    const profile = {
      primary_type: "high_school_student",
      sections: [
        { section_key: "basic_information", data: { full_name: "Student Profile" } },
        { section_key: "education", data: { current_institution: "Central High" } },
      ],
    }

    const sectionKeys = getApplicableSectionKeys(profile)

    expect(sectionKeys).not.toContain("organization_details")
    expect(sectionKeys).not.toContain("medical_insurance")
    expect(sectionKeys).not.toContain("medical_history")
    expect(sectionKeys).not.toContain("nonprofit_compliance")
    expect(sectionKeys).not.toContain("small_business_details")
  })

  it("uses the same applicable section list for completion totals", () => {
    const profile = {
      primary_type: "high_school_student",
      sections: [
        { section_key: "basic_information", data: { full_name: "Student Profile" } },
        { section_key: "education", data: { current_institution: "Central High" } },
      ],
    }

    expect(calculateProfileCompletion(profile).totalSections).toBe(getApplicableSectionKeys(profile).length)
  })

  it("excludes university_applications (and other student-only sections) for a nonprofit", () => {
    // Regression: Focus Forward (a nonprofit) was nagged to "Fill in University
    // Applications" and stuck at 94% because university_applications was counted
    // for every profile type. It is now gated to student types.
    const profile = {
      primary_type: "nonprofit",
      sections: [
        { section_key: "basic_information", data: { full_name: "Focus Forward Ministries" } },
        { section_key: "narrative", data: { mission: "Serve the community" } },
      ],
    }

    const sectionKeys = getApplicableSectionKeys(profile)
    expect(sectionKeys).not.toContain("university_applications")
    expect(sectionKeys).not.toContain("education")
  })

  it("includes university_applications for a student", () => {
    const profile = {
      primary_type: "high_school_student",
      sections: [{ section_key: "basic_information", data: { full_name: "Student" } }],
    }
    expect(getApplicableSectionKeys(profile)).toContain("university_applications")
  })

  it("returns only unconstrained sections when primary_type is missing", () => {
    const profile = {
      sections: [{ section_key: "basic_information", data: { full_name: "Unknown Type" } }],
    }
    const unconstrainedSectionKeys = Object.entries(SECTION_METADATA)
      .filter(([, config]) => {
        const appliesTo = config.applies_to ?? config.appliesTo ?? null
        return !Array.isArray(appliesTo) || appliesTo.length === 0
      })
      .map(([sectionKey]) => sectionKey)

    expect(getApplicableSectionKeys(profile)).toEqual(unconstrainedSectionKeys)
  })
})
