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
})
