// @vitest-environment jsdom
import React from "react"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import ProfileOverview from "../ProfileOverview.jsx"
import { formatInlinePreviewValue, renderValue } from "../profileOverviewHelpers.jsx"
import { calculateProfileCompletion } from "@/utils/profileCompletion"

const baseProfile = {
  id: "profile-student",
  display_name: "Student Profile",
  primary_type: "high_school_student",
  updated_at: "2026-04-26T12:00:00.000Z",
  sections: [
    {
      section_key: "basic_information",
      data: { full_name: "Student Profile", state: "OH" },
      updated_at: "2026-04-26T12:00:00.000Z",
    },
    {
      section_key: "education",
      data: {
        schools: [{ name: "Central High", type: "high_school" }],
      },
      updated_at: "2026-04-26T12:00:00.000Z",
    },
  ],
}

describe("ProfileOverview display rendering", () => {
  it("never emits [object Object] and renders object values as labeled rows", () => {
    const { container } = render(<div>{renderValue("schools", [{ name: "Central High" }], "education")}</div>)

    expect(container.textContent).not.toContain("[object Object]")
    expect(container.textContent).toContain("name: Central High")
    expect(container.textContent).toContain("Central High")
  })

  it("formats currency_usd fields as dollars", () => {
    const { container } = render(<div>{renderValue("household_income", 56000, "financial_information")}</div>)

    expect(container.textContent).toContain("$56,000")
  })

  it("filters sentinel values from inline string arrays", () => {
    expect(formatInlinePreviewValue(["Second-generation immigrant", "unknown"])).toBe("Second-generation immigrant")
  })

  it("shows Not updated yet when section data is empty even if updated_at exists", () => {
    render(
      <ProfileOverview
        profile={{
          ...baseProfile,
          sections: [
            {
              section_key: "basic_information",
              data: { notes: "   " },
              updated_at: "2026-04-26T12:00:00.000Z",
            },
          ],
        }}
      />,
    )

    expect(screen.getAllByText("Not updated yet").length).toBeGreaterThan(0)
  })

  it("renders a section card count that matches completion totalSections", () => {
    render(<ProfileOverview profile={baseProfile} />)

    const completion = calculateProfileCompletion(baseProfile)
    expect(screen.getByText(`${completion.totalSections} sections defined • ${completion.completedSections} fully populated`)).toBeTruthy()
    expect(screen.queryByText("Organization Details")).toBeNull()
    expect(screen.getByText("Education")).toBeTruthy()
  })
})
