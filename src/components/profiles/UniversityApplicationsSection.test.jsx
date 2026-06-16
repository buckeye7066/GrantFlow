// @vitest-environment jsdom
import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

vi.mock("@/api/documents", () => ({
  deleteDocument: vi.fn(),
  ingestDocument: vi.fn(),
  listDocuments: vi.fn(async () => []),
}))

vi.mock("@/api/colleges.js", () => ({
  fetchLocalFundingByZip: vi.fn(),
}))

import UniversityApplicationsSection from "./UniversityApplicationsSection.jsx"

function renderWithQueryClient(ui) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe("UniversityApplicationsSection", () => {
  it("opens the edit dialog when the university card is clicked", async () => {
    renderWithQueryClient(
      <UniversityApplicationsSection
        applications={[
          {
            id: "app-1",
            name: "Middle Tennessee State University",
            status: "planning",
          },
        ]}
        onSave={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /open university card for middle tennessee state university/i }))

    expect(await screen.findByText("Edit University Application")).toBeTruthy()
  })
})
