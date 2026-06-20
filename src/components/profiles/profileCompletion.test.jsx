// @vitest-environment jsdom
import React from "react"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import ProfileOverview from "./ProfileOverview.jsx"

// ProfileOverview renders PipelinePotentialBreakdown, which calls useQuery, so it
// needs a QueryClientProvider in the tree.
function renderWithQueryClient(ui) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe("profile completion display", () => {
  it("does not count stored but non-applicable sections as complete", () => {
    renderWithQueryClient(
      <ProfileOverview
        profile={{
          id: "profile-family",
          display_name: "Family Profile",
          primary_type: "family",
          updated_at: "2026-04-26T12:00:00.000Z",
          sections: [
            {
              section_key: "basic_information",
              data: { full_name: "Family Profile", state: "OH" },
              updated_at: "2026-04-26T12:00:00.000Z",
            },
            {
              section_key: "student_details",
              data: { gpa: 4.0 },
              updated_at: "2026-04-26T12:00:00.000Z",
            },
          ],
        }}
        onEditSection={vi.fn()}
        onSaveField={vi.fn()}
      />,
    )

    expect(screen.getByText(/sections defined • 1 fully populated/i)).toBeTruthy()
  })
})
