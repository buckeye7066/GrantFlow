import { describe, it, expect } from "vitest"
import {
  resolveMissingInfoTarget,
  buildProfileSectionLink,
} from "@/config/missingInfoTargets"

function parse(link) {
  // link looks like "/ProfileDetail?id=..&tab=..&section=..&field=.."
  const [path, query] = String(link).split("?")
  return { path, params: new URLSearchParams(query || "") }
}

describe("resolveMissingInfoTarget", () => {
  it("maps a known field key", () => {
    expect(resolveMissingInfoTarget("first_name")).toMatchObject({
      tab: "profile",
      section: "basic_information",
      field: "first_name",
    })
  })

  it("normalizes casing / spacing / hyphens", () => {
    expect(resolveMissingInfoTarget("First Name")?.field).toBe("first_name")
    expect(resolveMissingInfoTarget("school-name")?.tab).toBe("universities")
  })

  it("resolves a bare section key via the section→tab map", () => {
    expect(resolveMissingInfoTarget("demographics")).toMatchObject({ tab: "profile", section: "demographics" })
  })

  it("returns null for non-profile keys (portal login, fees, …)", () => {
    expect(resolveMissingInfoTarget("login")).toBeNull()
    expect(resolveMissingInfoTarget("application_fee")).toBeNull()
    expect(resolveMissingInfoTarget("")).toBeNull()
  })
})

describe("buildProfileSectionLink", () => {
  it("deep-links an editable section with section + field params", () => {
    const { path, params } = parse(buildProfileSectionLink("p1", "first_name"))
    expect(path).toBe("/ProfileDetail")
    expect(params.get("id")).toBe("p1")
    expect(params.get("tab")).toBe("profile")
    expect(params.get("section")).toBe("basic_information")
    expect(params.get("field")).toBe("first_name")
  })

  it("omits section/field for non-editable sections (documents, universities)", () => {
    const docs = parse(buildProfileSectionLink("p1", "transcript"))
    expect(docs.params.get("tab")).toBe("documents")
    expect(docs.params.get("section")).toBeNull()
    expect(docs.params.get("field")).toBeNull()

    const school = parse(buildProfileSectionLink("p1", "school_name"))
    expect(school.params.get("tab")).toBe("universities")
    expect(school.params.get("section")).toBeNull()
  })

  it("returns null when there is no profile target or no profileId", () => {
    expect(buildProfileSectionLink("p1", "login")).toBeNull()
    expect(buildProfileSectionLink(null, "first_name")).toBeNull()
  })
})
