import { describe, expect, it } from "vitest"

import { SECTION_METADATA } from "@/config/sectionMetadata"

const ALLOWED = [
  "GPA",
  "SAT",
  "ACT",
  "EIN",
  "CAGE",
  "NICRA",
  "NTEE",
  "EMS",
  "HIV",
  "AIDS",
  "TBI",
  "SSDI",
  "SSI",
  "SNAP",
  "TANF",
  "IEP",
  "ESL",
  "FAFSA",
  "IRS",
  "DUNS",
  "UEI",
  "NIH",
  "NSF",
  "DOD",
  "VA",
  "USDA",
  "HHS",
  "ZIP",
  "USD",
  "LGBTQ",
  "Appalachian",
  "Gold Star",
  "501(c)(3)",
  "Section 8",
  "SAM.gov",
  "Grants.gov",
  "eRA Commons",
  "ECF",
  "HUBZone",
  "QCT",
  "EPA",
  "FEMA",
  "CAA",
  "CDFI",
  "MSI",
  "HBCU",
  "HSI",
  "TCU",
  "RHC",
  "PPO",
  "HMO",
  "ROTC",
  "JROTC",
  "EFC",
  "SAI",
]

const ALLOWED_STARTS = ["eRA Commons", "501(c)(3)", "8(a)"]

function stripAllowed(label) {
  return ALLOWED.reduce((text, allowed) => text.replaceAll(allowed, ""), label)
}

describe("SECTION_METADATA label style", () => {
  it("uses sentence case for every field label", () => {
    const failures = []
    for (const [sectionKey, section] of Object.entries(SECTION_METADATA)) {
      for (const field of section.fields ?? []) {
        const label = field.label ?? ""
        const first = label.trim().match(/[A-Za-z]/)?.[0]
        if (first && first !== first.toUpperCase() && !ALLOWED_STARTS.some((entry) => label.startsWith(entry))) {
          failures.push(`${sectionKey}.${field.name}: ${label}`)
        }
        const unapprovedCaps = stripAllowed(label).match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g)
        if (unapprovedCaps) failures.push(`${sectionKey}.${field.name}: ${label}`)
      }
    }
    expect(failures).toEqual([])
  })
})
