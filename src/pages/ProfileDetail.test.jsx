// @vitest-environment jsdom
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { Search } from "lucide-react"
import { describe, expect, it, vi } from "vitest"

import { WorkAreaLinkCard } from "./ProfileDetail.jsx"

describe("WorkAreaLinkCard", () => {
  it("uses the whole card as the work-area action", () => {
    const onOpen = vi.fn()

    render(
      <WorkAreaLinkCard
        icon={Search}
        title="Item funding"
        detail="Search for specific item funding opportunities."
        actionLabel="Open item funding"
        onOpen={onOpen}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /item funding/i }))

    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("does not expose disabled work areas as buttons", () => {
    render(
      <WorkAreaLinkCard
        icon={Search}
        title="Grant monitoring"
        detail="Monitor awarded grants and compliance requirements."
        actionLabel="Unavailable"
        disabledReason="Link this profile to an organization to track awarded grants and compliance."
      />,
    )

    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("Unavailable")).toBeTruthy()
    expect(screen.getByText(/Link this profile/i)).toBeTruthy()
  })
})
