// @vitest-environment jsdom
import React from "react"
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach } from "vitest"

// Toast is a side-effect surface we don't assert on here.
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

// Control the profiles API: the AI-assist call and the controlled-vocabulary
// endpoint used by the tag picker.
const getProfileVocabulary = vi.fn()
const requestProfileFieldAI = vi.fn()
vi.mock("@/api/profiles", () => ({
  getProfileVocabulary: (...args) => getProfileVocabulary(...args),
  requestProfileFieldAI: (...args) => requestProfileFieldAI(...args),
}))

import ProfileFieldWithAI, { buildEnumOptions } from "../ProfileFieldWithAI.jsx"

function renderField(field, value = "", onChange = vi.fn()) {
  return render(
    <ProfileFieldWithAI field={field} value={value} onChange={onChange} sectionKey="s" profileId="p1" />,
  )
}

describe("ProfileFieldWithAI format-based rendering", () => {
  beforeEach(() => {
    getProfileVocabulary.mockReset()
    requestProfileFieldAI.mockReset()
  })

  it("format:'enum' renders a single-choice Select (not a text input)", () => {
    renderField({
      name: "financial_need_level",
      label: "Financial need level",
      format: "enum",
      options: ["low", "moderate", "high"],
    }, "moderate")

    // Radix Select trigger is a combobox; there is no free-text input.
    expect(screen.getByTestId("enum-select-financial_need_level")).toBeTruthy()
    expect(screen.getByRole("combobox")).toBeTruthy()
  })

  it("format:'tags' renders a tag picker sourced from the vocabulary endpoint", async () => {
    getProfileVocabulary.mockResolvedValue({ focus: ["education", "housing"], needs: [] })

    renderField({
      name: "focus_areas",
      label: "Focus areas",
      format: "tags",
      vocabulary: "focus",
    }, [])

    expect(screen.getByTestId("tag-picker-focus_areas")).toBeTruthy()
    // Options from the mocked vocabulary render as add-buttons.
    await waitFor(() => expect(screen.getByText("+ education")).toBeTruthy())
    expect(screen.getByText("+ housing")).toBeTruthy()
    expect(getProfileVocabulary).toHaveBeenCalled()
  })

  it("format:'tags' falls back to free-text when the vocabulary endpoint 404s (pre-deploy)", async () => {
    const err = new Error("Not found")
    err.status = 404
    getProfileVocabulary.mockRejectedValue(err)

    renderField({
      name: "focus_areas",
      label: "Focus areas",
      format: "tags",
      vocabulary: "focus",
    }, ["existing_tag"])

    // Graceful degradation: a textarea appears so the form never breaks.
    await waitFor(() => expect(screen.getByTestId("tags-fallback-focus_areas")).toBeTruthy())
    expect(screen.getByTestId("tags-fallback-focus_areas").value).toContain("existing_tag")
  })

  it("format:'prose' renders a labeled textarea marked not-used-for-scoring", () => {
    renderField({
      name: "mission",
      label: "Mission",
      format: "prose",
      scored: false,
    }, "We serve families.")

    const textarea = screen.getByDisplayValue("We serve families.")
    expect(textarea.tagName).toBe("TEXTAREA")
    expect(screen.getByText(/not used for match scoring/i)).toBeTruthy()
  })

  it("deprecated fields are not rendered at all", () => {
    const { container } = renderField({
      name: "location",
      label: "Location",
      format: "json",
      deprecated: true,
    }, { city: "Cleveland" })

    expect(container.firstChild).toBeNull()
  })

  it("preserves a stored enum value that is not in the option list", () => {
    const field = { name: "employment_status", format: "enum", options: ["employed_full_time", "retired"] }
    const options = buildEnumOptions(field, "legacy_status_value")

    // The stored value is surfaced as a leading option so it is never blanked.
    expect(options[0]).toBe("legacy_status_value")
    expect(options).toContain("employed_full_time")

    // And an in-list value is not duplicated.
    expect(buildEnumOptions(field, "retired")).toEqual(["employed_full_time", "retired"])
  })
})
