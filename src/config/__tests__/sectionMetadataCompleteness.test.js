import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { SECTION_METADATA } from "@/config/sectionMetadata"
import { DESIGNATED_PROFILES } from "../../../backend/config/designatedProfiles.js"

// A saved key is "declared" if it matches a field's canonical name OR one of
// its legacy_aliases. Seed/DB profiles still carry pre-canonicalisation keys
// (e.g. `unemployed` → employment_status, `immigrant_status` →
// immigration_status) that are mapped on save; counting only canonical names
// would false-flag them. Mirrors buildDeclaredFieldIndex() in
// scripts/audit-section-metadata.mjs.
function collectDeclared(sectionKey) {
  const declared = new Set()
  for (const field of SECTION_METADATA[sectionKey]?.fields ?? []) {
    if (!field?.name) continue
    declared.add(field.name)
    for (const alias of field.legacy_aliases ?? []) declared.add(alias)
  }
  return declared
}

function collect(profile, failures) {
  for (const [sectionKey, data] of Object.entries(profile?.sections ?? {})) {
    const declared = collectDeclared(sectionKey)
    for (const key of Object.keys(data ?? {})) {
      if (!declared.has(key)) failures.push(`${sectionKey}.${key}`)
    }
  }
}

describe("SECTION_METADATA completeness", () => {
  it("declares every saved key in designated seed profiles", () => {
    const failures = []
    for (const profile of DESIGNATED_PROFILES) collect(profile, failures)
    const demo_stem_student = JSON.parse(
      readFileSync(path.join(process.cwd(), "backend", "config", "profile-demo-tennessee-stem-student.json"), "utf8"),
    )
    collect(demo_stem_student, failures)
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
