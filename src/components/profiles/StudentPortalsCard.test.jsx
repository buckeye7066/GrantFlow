// @vitest-environment jsdom
import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { apiFetchMock, createCrawlerJobMock, toastMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  createCrawlerJobMock: vi.fn(),
  toastMock: vi.fn(),
}))

vi.mock("@/api/client", () => ({
  apiFetch: (...args) => apiFetchMock(...args),
  default: { fetch: (...args) => apiFetchMock(...args) },
}))

vi.mock("@/api/crawlers", () => ({
  createCrawlerJob: (...args) => createCrawlerJobMock(...args),
}))

vi.mock("@/api/profileIdGuards", () => ({
  assertRealProfileId: vi.fn(),
}))

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}))

import StudentPortalsCard from "./StudentPortalsCard.jsx"

function renderWithQueryClient(ui) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe("StudentPortalsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createCrawlerJobMock.mockResolvedValue({ ok: true })
    apiFetchMock.mockImplementation(async (endpoint, options = {}) => {
      if (endpoint.startsWith("/api/crawlers/portal-check-results/")) {
        return { results: [] }
      }
      if (endpoint.startsWith("/api/profiles/profile-1/school-portals") && (!options.method || options.method === "GET")) {
        return {
          ok: true,
          providers: [
            {
              id: "tsac",
              name: "Tennessee Student Assistance Corporation (TSAC)",
            },
          ],
          applications: [{ id: "app-1", name: "Middle Tennessee State University", school_name: "Middle Tennessee State University" }],
          merged_awards: [],
          connections: [
            {
              id: "connection-1",
              provider_name: "Tennessee Student Assistance Corporation (TSAC)",
              provider_id: "tsac",
              integration_mode: "pilot_manual_import",
              default_application_id: "app-1",
              limitations: ["Live TSAC OAuth/API authentication is not implemented in this release."],
              available_awards: [
                {
                  id: "portal_award_hope",
                  title: "Tennessee HOPE Scholarship",
                  amount_display: "$3,500",
                  status: "offered",
                  academic_year: "2026-2027",
                  provider_name: "Tennessee Student Assistance Corporation (TSAC)",
                  already_merged: false,
                },
              ],
            },
          ],
        }
      }
      if (endpoint === "/api/profiles/profile-1/school-portals/merge" && options.method === "POST") {
        return { ok: true, merged_count: 1, merged_awards: [] }
      }
      return { ok: true }
    })
  })

  it("renders provider imports and posts selected awards to the merge route", async () => {
    renderWithQueryClient(<StudentPortalsCard state="TN" profileId="profile-1" />)

    expect(await screen.findByText(/pilot\/manual-import only/i)).toBeTruthy()
    expect(await screen.findByText("Tennessee HOPE Scholarship")).toBeTruthy()

    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /merge 1 award/i }))

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/profiles/profile-1/school-portals/merge",
        expect.objectContaining({
          method: "POST",
          body: expect.any(String),
        }),
      )
    })

    const mergeCall = apiFetchMock.mock.calls.find(([endpoint]) => endpoint === "/api/profiles/profile-1/school-portals/merge")
    const body = JSON.parse(mergeCall[1].body)
    expect(body).toMatchObject({
      connection_id: "connection-1",
      application_id: "app-1",
      award_ids: ["portal_award_hope"],
    })
  })
})
