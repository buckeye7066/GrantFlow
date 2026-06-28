// @vitest-environment jsdom
import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import ProfileSectionEditor from "../ProfileSectionEditor.jsx"

global.ResizeObserver = global.ResizeObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("ProfileSectionEditor metadata schema", () => {
  it("shows legacy unknown keys separately and drops them on save by default", async () => {
    const onSave = vi.fn()
    render(
      <ProfileSectionEditor
        open
        sectionKey="narrative"
        initialData={{ primary_goal: "Graduate", legacy_key: "old value" }}
        profileId="profile-1"
        onClose={() => {}}
        onSave={onSave}
        isSaving={false}
      />,
    )

    expect(screen.getByText("Legacy fields")).toBeTruthy()
    expect(screen.getByText("legacy_key")).toBeTruthy()
    const scrollBody = screen.getByTestId("profile-section-editor-scroll")
    expect(scrollBody.className).toContain("min-h-0")
    expect(scrollBody.className).toContain("overflow-y-auto")

    fireEvent.click(screen.getByText("Save changes"))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).toMatchObject({ primary_goal: "Graduate" })
    expect(onSave.mock.calls[0][0]).not.toHaveProperty("legacy_key")
  })
})
