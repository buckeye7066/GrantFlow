import { describe, expect, it } from "vitest"

import { formatFieldLabel } from "@/utils/fieldDisplay"

describe("formatFieldLabel", () => {
  it("formats acronyms, numbers, and per-key overrides", () => {
    expect(formatFieldLabel("gpa")).toBe("GPA")
    expect(formatFieldLabel("act_score")).toBe("ACT Score")
    expect(formatFieldLabel("ssdi_recipient")).toBe("SSDI Recipient")
    expect(formatFieldLabel("section8_housing")).toBe("Section 8 Housing")
    expect(formatFieldLabel("hiv_aids")).toBe("HIV/AIDS")
    expect(formatFieldLabel("ems_worker")).toBe("EMS Worker")
  })
})
