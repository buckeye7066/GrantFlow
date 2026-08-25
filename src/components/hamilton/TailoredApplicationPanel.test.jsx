// @vitest-environment jsdom
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { apiFetchMock, toastMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  toastMock: vi.fn(),
}))

// Mock the API transport (mirrors StudentPortalsCard.test precedent). The real
// src/api/hamilton wrapper runs against this, so we also exercise the endpoints.
vi.mock("@/api/client", () => {
  const fetchImpl = (...args) => apiFetchMock(...args)
  return {
    apiFetch: fetchImpl,
    default: {
      fetch: fetchImpl,
      getToken: () => null,
      getRefreshToken: () => null,
      refreshTokens: () => Promise.resolve(),
    },
  }
})

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}))

import TailoredApplicationPanel from "./TailoredApplicationPanel.jsx"

function renderPanel(props = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TailoredApplicationPanel
          profileId="profile-1"
          grantId="grant-9"
          grantTitle="Acme Foundation"
          autoLoad
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("TailoredApplicationPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("blocks submission for missing funder facts and deep-links each to the profile", async () => {
    apiFetchMock.mockImplementation(async (endpoint) => {
      if (endpoint.includes("/hamilton/tailored/application?grant_id=")) {
        return {
          fields: { primary: "Draft narrative for Acme." },
          status: "pending",
          missing_questions: [
            {
              requirement: "Household income",
              question: "Acme asks for your household income — add it to your profile.",
              field: "household_income",
              section_key: "financial_information",
            },
          ],
          funder_requirements: ["A statement of need"],
          can_auto_submit: false,
          gate_reason: "missing_info",
        }
      }
      return { ok: true }
    })

    renderPanel()

    // The blocking question renders with its deep-link to the profile section.
    const link = await screen.findByRole("link", { name: /add it to your profile/i })
    expect(link.getAttribute("href")).toContain("section=financial_information")
    expect(link.getAttribute("href")).toContain("field=household_income")
    expect(screen.getByText(/Acme asks for your household income/i)).toBeTruthy()

    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull()
    expect(screen.getByText(/before Hamilton can submit/i)).toBeTruthy()
  })

  it("maps a legacy approved record to ready and reports that automation is off", async () => {
    apiFetchMock.mockImplementation(async (endpoint) => {
      if (endpoint.includes("/hamilton/tailored/application?grant_id=")) {
        return {
          fields: { primary: "Approved narrative body." },
          status: "approved",
          missing_questions: [],
          funder_requirements: [],
          can_auto_submit: false,
          gate_reason: "automation_off",
        }
      }
      return { ok: true }
    })

    renderPanel()

    expect(await screen.findByText("Approved narrative body.")).toBeTruthy()
    // The saved narrative stays read-only until Edit is selected.
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByText(/Automation is off.*ready for you to use/i)).toBeTruthy()
    expect(screen.getByText(/^Ready$/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull()
  })

  it("reports auto-submit readiness without adding a second review action", async () => {
    apiFetchMock.mockImplementation(async (endpoint) => {
      if (endpoint.includes("/hamilton/tailored/application?grant_id=")) {
        return {
          fields: { primary: "Automation-ready narrative." },
          status: "pending",
          missing_questions: [],
          funder_requirements: [],
          can_auto_submit: true,
          gate_reason: null,
        }
      }
      return { ok: true }
    })

    renderPanel()

    expect(await screen.findByText("Automation-ready narrative.")).toBeTruthy()
    expect(screen.getByText(/Automation is on.*Hamilton can use this draft and submit/i)).toBeTruthy()
    expect(screen.getByText(/^Generated$/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull()
  })

  it("edit mode posts the edited fields to the edit endpoint", async () => {
    apiFetchMock.mockImplementation(async (endpoint, options = {}) => {
      if (endpoint.includes("/hamilton/tailored/application?grant_id=")) {
        return {
          fields: { primary: "Original draft." },
          status: "pending",
          missing_questions: [],
          funder_requirements: [],
          can_auto_submit: false,
          gate_reason: "automation_off",
        }
      }
      if (endpoint.endsWith("/hamilton/tailored/edit") && options.method === "POST") {
        return { ok: true, status: "edited" }
      }
      return { ok: true }
    })

    renderPanel()

    fireEvent.click(await screen.findByRole("button", { name: /^edit$/i }))
    const textarea = await screen.findByRole("textbox")
    fireEvent.change(textarea, { target: { value: "My edited narrative." } })
    fireEvent.click(screen.getByRole("button", { name: /save edits/i }))

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/hamilton/tailored/edit",
        expect.objectContaining({ method: "POST", body: expect.any(String) }),
      )
    })
    const editCall = apiFetchMock.mock.calls.find(([e]) => e.endsWith("/hamilton/tailored/edit"))
    const body = JSON.parse(editCall[1].body)
    expect(body.grant_id).toBe("grant-9")
    expect(body.fields.primary).toBe("My edited narrative.")
  })

  it("hides the panel when the endpoint 404s (not deployed yet)", async () => {
    apiFetchMock.mockImplementation(async () => {
      const err = new Error("Not found")
      err.status = 404
      throw err
    })

    const { container } = renderPanel()

    await waitFor(() => {
      expect(screen.queryByTestId("tailored-application-panel")).toBeNull()
    })
    // Nothing rendered at all — the card is never broken.
    expect(container.textContent).toBe("")
  })

  it("is lazy by default: renders only a toggle and fetches nothing until opened", async () => {
    apiFetchMock.mockResolvedValue({ ok: true })
    renderPanel({ autoLoad: false })

    expect(screen.getByRole("button", { name: /tailored application/i })).toBeTruthy()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})
