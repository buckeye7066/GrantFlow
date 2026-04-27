import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { SECTION_METADATA } from "@/config/sectionMetadata"
import { DESIGNATED_PROFILES } from "../../../backend/config/designatedProfiles.js"

function collect(profile, failures) {
  for (const [sectionKey, data] of Object.entries(profile?.sections ?? {})) {
    const declared = new Set((SECTION_METADATA[sectionKey]?.fields ?? []).map((field) => field.name))
    for (const key of Object.keys(data ?? {})) {
      if (!declared.has(key)) failures.push(`${sectionKey}.${key}`)
    }
  }
}

describe("SECTION_METADATA completeness", () => {
  it("declares every saved key in designated seed profiles", () => {
    const failures = []
    for (const profile of DESIGNATED_PROFILES) collect(profile, failures)
    const anastasia = JSON.parse(
      readFileSync(path.join(process.cwd(), "backend", "config", "profile-anastasia.json"), "utf8"),
    )
    collect(anastasia, failures)
    expect(failures.sort()).toEqual([])
  })

  it("declares live legacy/profile-intake fields with renderable formats", () => {
    const field = (sectionKey, fieldKey) =>
      SECTION_METADATA[sectionKey].fields.find((entry) => entry.name === fieldKey)

    expect(field("basic_information", "profile_type")).toMatchObject({ label: "Profile type", format: "enum" })
    expect(field("basic_information", "current_school")).toMatchObject({ label: "Current school", format: "text" })
    expect(field("basic_information", "location")).toMatchObject({ label: "Location", format: "json" })
    expect(field("demographics", "gender")).toMatchObject({ label: "Gender", format: "text" })
    expect(field("demographics", "geographic_qualifiers")).toMatchObject({ label: "Geographic qualifiers", format: "string_array" })
    expect(field("demographics", "languages")).toMatchObject({ label: "Languages", format: "string_array" })
  })
})
