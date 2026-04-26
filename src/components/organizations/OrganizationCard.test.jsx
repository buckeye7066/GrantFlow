// @vitest-environment jsdom
import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import OrganizationCard from "./OrganizationCard.jsx"

function renderWithQueryClient(ui) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe("OrganizationCard", () => {
  it("renders individual/family profile cards without a TDZ crash", () => {
    expect(() =>
      renderWithQueryClient(
        <OrganizationCard
          organization={{
            id: "profile-family",
            name: "Family Assistance Profile",
            applicant_type: "family",
            assistance_categories: [],
          }}
          onClick={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />,
      ),
    ).not.toThrow()

    expect(screen.getByText("Family Assistance Profile")).toBeTruthy()
  })
})
