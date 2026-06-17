// @vitest-environment jsdom
import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { toastMock, apiFetchMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  apiFetchMock: vi.fn(),
}))

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}))

vi.mock("@/api/documents", () => ({
  deleteDocument: vi.fn(),
  ingestDocument: vi.fn(),
  listDocuments: vi.fn(async () => []),
}))

vi.mock("@/api/colleges.js", () => ({
  fetchLocalFundingByZip: vi.fn(),
}))

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    apiFetch: (...args) => apiFetchMock(...args),
  }
})

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
  beforeEach(() => {
    vi.clearAllMocks()
    apiFetchMock.mockResolvedValue({
      success: true,
      data: {
        acceptanceRate: "65%",
      },
    })
  })

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

  it("does not open the edit dialog when AI assist is clicked", async () => {
    const onSave = vi.fn()

    renderWithQueryClient(
      <UniversityApplicationsSection
        applications={[
          {
            id: "app-1",
            name: "Middle Tennessee State University",
            status: "planning",
          },
        ]}
        onSave={onSave}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /ai assist/i }))

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/ai/school-lookup",
        expect.objectContaining({ method: "POST" }),
      )
    })

    expect(screen.queryByText("Edit University Application")).toBeNull()
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled()
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "School data updated",
        }),
      )
    })
  })
})
