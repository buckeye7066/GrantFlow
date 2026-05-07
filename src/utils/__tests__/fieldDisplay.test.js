import { describe, expect, it, vi } from "vitest"

import { formatFieldLabel, formatFieldValue, humanizeFieldKey } from "@/utils/fieldDisplay"

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

  it("renders live language and geographic qualifier shapes cleanly", () => {
    expect(formatFieldLabel("basic_information", "profile_type")).toBe("Profile type")
    expect(formatFieldLabel("basic_information", "current_school")).toBe("Current school")
    expect(formatFieldLabel("basic_information", "location")).toBe("Location")
    expect(formatFieldLabel("demographics", "gender")).toBe("Gender")
    expect(formatFieldLabel("demographics", "geographic_qualifiers")).toBe("Geographic qualifiers")

    expect(formatFieldValue("demographics", "languages", "English")).toBe("English")
    expect(formatFieldValue("demographics", "languages", ["English", "Russian"])).toBe("English, Russian")
    expect(formatFieldValue("demographics", "languages", { primary: "English", secondary: ["Russian"] })).toBe("English, Russian")
    expect(formatFieldValue("demographics", "geographic_qualifiers", ["rural", "Appalachian"])).toBe("rural, Appalachian")
    expect(formatFieldValue("demographics", "geographic_qualifiers", { region: "Appalachian" })).toBe("Appalachian")
    expect(formatFieldValue("demographics", "geographic_qualifiers", "rural")).toBe("rural")
  })

  it("renders the previously-noisy housing/programs_services list fields without warnings", () => {
    // Regression guard for the [fieldDisplay] Missing or invalid SECTION_METADATA
    // ... format text cannot render object Object warnings on /ProfileDetail.
    // sectionMetadata declares these as string_array AND fieldDisplay's text
    // branch coerces gracefully; both must hold for the warnings to stay gone.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(formatFieldValue("housing", "geographic_designation", ["rural", "frontier"])).toBe("rural, frontier")
    expect(formatFieldValue("housing", "geographic_designation", "rural, urban")).toBe("rural, urban")
    expect(formatFieldValue("housing", "geographic_designation", { 0: "rural", 1: "urban" })).toBe("rural, urban")
    expect(formatFieldValue("housing", "geographic_designation", [])).toBe("—")

    expect(formatFieldValue("programs_services", "focus_areas", ["health", "youth"])).toBe("health, youth")
    expect(formatFieldValue("programs_services", "interests", ["youth services"])).toBe("youth services")
    expect(formatFieldValue("programs_services", "keywords", ["rural", "broadband"])).toBe("rural, broadband")
    expect(formatFieldValue("programs_services", "keywords", { 0: "rural", 1: "broadband" })).toBe("rural, broadband")
    expect(formatFieldValue("programs_services", "interests", "mental health, food access")).toBe("mental health, food access")

    const offenders = warn.mock.calls
      .map((call) => (typeof call[0] === "string" ? call[0] : ""))
      .filter((message) => message.startsWith("[fieldDisplay] Missing or invalid SECTION_METADATA"))
    expect(offenders).toEqual([])
    warn.mockRestore()
  })

  it("renders basic_information.keywords cleanly (regression: legacy intake mirror)", () => {
    // Real production profiles store keywords lifted from intake under
    // basic_information as well as the canonical programs_services
    // section. ProfileOverview iterates whichever section's data was
    // saved, so both paths must render without warnings.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(formatFieldLabel("basic_information", "keywords")).toBe("Keywords (intake)")
    expect(formatFieldValue("basic_information", "keywords", ["rural", "broadband"])).toBe("rural, broadband")
    expect(formatFieldValue("basic_information", "keywords", "rural, broadband")).toBe("rural, broadband")
    expect(formatFieldLabel("basic_information", "interests")).toBe("Interests (intake)")
    expect(formatFieldLabel("basic_information", "tags")).toBe("Tags")

    const offenders = warn.mock.calls
      .map((call) => (typeof call[0] === "string" ? call[0] : ""))
      .filter((message) => message.startsWith("[fieldDisplay] Missing or invalid SECTION_METADATA"))
    expect(offenders).toEqual([])
    warn.mockRestore()
  })

  it("humanizes unknown field keys instead of emitting Unknown field (permanent drift guard)", () => {
    // Profile shapes evolve faster than metadata declarations. The
    // resolver MUST always render something readable so the user sees
    // their own data — never "Unknown field" and never "—" when the
    // value is non-empty.
    expect(humanizeFieldKey("created_at")).toBe("Created at")
    expect(humanizeFieldKey("ein_number")).toBe("EIN number")
    expect(humanizeFieldKey("uei")).toBe("UEI")
    expect(humanizeFieldKey("cdfiCertified")).toBe("CDFI certified")
    expect(humanizeFieldKey("zip-code")).toBe("ZIP code")
    expect(humanizeFieldKey("")).toBe("")

    expect(formatFieldLabel("brand_new_section", "some_new_field")).toBe("Some new field")
    expect(formatFieldValue("brand_new_section", "some_new_field", "hello")).toBe("hello")
    expect(formatFieldValue("brand_new_section", "some_new_field", ["a", "b"])).toBe("a, b")
    expect(formatFieldValue("brand_new_section", "some_new_field", { a: "x", b: "y" })).toBe("a: x, b: y")
    expect(formatFieldValue("brand_new_section", "some_new_field", true)).toBe("Yes")
    expect(formatFieldValue("brand_new_section", "some_new_field", null)).toBe("—")
  })
})
