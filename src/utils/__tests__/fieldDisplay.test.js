import { describe, expect, it } from "vitest"

import { formatFieldLabel, formatFieldValue } from "@/utils/fieldDisplay"

describe("formatFieldLabel", () => {
  it("reads labels from SECTION_METADATA only", () => {
    expect(formatFieldLabel("education", "gpa")).toBe("GPA")
    expect(formatFieldLabel("education", "act_score")).toBe("ACT score")
    expect(formatFieldLabel("government_assistance", "ssdi_recipient_self")).toBe("SSDI recipient self")
    expect(formatFieldLabel("government_assistance", "section8_recipient_self")).toBe("Section 8 recipient self")
    expect(formatFieldLabel("health_medical", "hiv_aids")).toBe("Living with HIV/AIDS")
    expect(formatFieldLabel("occupation", "ems_worker")).toBe("EMS/First responder")
    expect(formatFieldLabel("narrative", "primary_goal")).toBe("Primary goal")
    expect(formatFieldLabel("narrative", "personal_statement")).toBe("Personal statement")
  })

  it("formats values without raw object output", () => {
    expect(formatFieldValue("financial_information", "household_income", 56000)).toBe("$56,000")
    expect(formatFieldValue("education", "schools", [{ name: "Central High" }])).not.toContain("[object Object]")
  })
})
