// @vitest-environment jsdom
import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach } from "vitest"

const toast = vi.fn()
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: (...args) => toast(...args) }),
}))

const requestProfileFieldAI = vi.fn()
vi.mock("@/api/profiles", () => ({
  requestProfileFieldAI: (...args) => requestProfileFieldAI(...args),
}))

import ApplicationEssaysCard from "../ApplicationEssaysCard.jsx"
import { SECTION_METADATA } from "@/config/sectionMetadata"

const LIVE_ESSAYS = (SECTION_METADATA.essays?.fields ?? []).filter((f) => !f.deprecated)
const DEPRECATED_ESSAYS = (SECTION_METADATA.essays?.fields ?? []).filter((f) => f.deprecated)

function renderCard(props = {}) {
  return render(
    <ApplicationEssaysCard
      essays={{}}
      onSaveField={vi.fn()}
      isSaving={false}
      profileId="p1"
      {...props}
    />,
  )
}

describe("ApplicationEssaysCard — Assist with AI on every essay", () => {
  beforeEach(() => {
    toast.mockReset()
    requestProfileFieldAI.mockReset()
  })

  // TOTALITY (owner order 2026-09-08: "add an 'assist with ai' to each essay
  // question ... there were several"). A single-button assertion would pass
  // while the other essays stayed bare — which is the defect being fixed. This
  // scans SECTION_METADATA, so an essay added later without a button fails here.
  it("renders one 'Assist with AI' button per LIVE essay question", () => {
    renderCard()

    expect(LIVE_ESSAYS.length).toBeGreaterThan(1)
    for (const field of LIVE_ESSAYS) {
      expect(
        screen.getByTestId(`essay-ai-assist-${field.name}`),
        `essay "${field.name}" has no Assist with AI button`,
      ).toBeTruthy()
      expect(screen.getByLabelText(field.label)).toBeTruthy()
    }
    expect(screen.getAllByText("Assist with AI")).toHaveLength(LIVE_ESSAYS.length)
  })

  it("does not ask a deprecated (duplicated) essay question", () => {
    renderCard()
    for (const field of DEPRECATED_ESSAYS) {
      expect(screen.queryByTestId(`essay-ai-assist-${field.name}`)).toBeNull()
      expect(document.getElementById(`essay-${field.name}`)).toBeNull()
    }
  })

  it("a generated draft lands in the box AND is saved (a programmatic fill never fires blur)", async () => {
    const onSaveField = vi.fn()
    requestProfileFieldAI.mockResolvedValue({ suggestion: "A drafted statement of need." })
    const field = LIVE_ESSAYS[0]

    renderCard({ onSaveField })
    fireEvent.click(screen.getByTestId(`essay-ai-assist-${field.name}`))

    await waitFor(() => expect(onSaveField).toHaveBeenCalledWith("essays", field.name, "A drafted statement of need."))
    expect(screen.getByLabelText(field.label).value).toBe("A drafted statement of need.")
    expect(requestProfileFieldAI).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "p1", sectionKey: "essays", fieldName: field.name }),
    )
  })

  it("an empty suggestion neither overwrites the essay nor reports success", async () => {
    const onSaveField = vi.fn()
    requestProfileFieldAI.mockResolvedValue({ suggestion: "   ", hint: "Add more profile detail." })
    const field = LIVE_ESSAYS[0]

    renderCard({ onSaveField, essays: { [field.name]: "what I wrote" } })
    fireEvent.click(screen.getByTestId(`essay-ai-assist-${field.name}`))

    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(onSaveField).not.toHaveBeenCalled()
    expect(screen.getByLabelText(field.label).value).toBe("what I wrote")
    expect(toast.mock.calls.at(-1)[0].title).toBe("No suggestion available")
  })

  it("a failed request is reported and leaves the essay untouched", async () => {
    const onSaveField = vi.fn()
    requestProfileFieldAI.mockRejectedValue(new Error("boom"))
    const field = LIVE_ESSAYS[0]

    renderCard({ onSaveField, essays: { [field.name]: "what I wrote" } })
    fireEvent.click(screen.getByTestId(`essay-ai-assist-${field.name}`))

    await waitFor(() => expect(toast.mock.calls.at(-1)[0].variant).toBe("destructive"))
    expect(onSaveField).not.toHaveBeenCalled()
    expect(screen.getByLabelText(field.label).value).toBe("what I wrote")
  })
})
