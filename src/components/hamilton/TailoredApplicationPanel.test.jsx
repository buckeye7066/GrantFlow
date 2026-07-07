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

  it("blocks approval while funder questions remain and deep-links each to the profile", async () => {
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

    // Approve is disabled while a question is unanswered.
    const approveBtn = screen.getByRole("button", { name: /^approve$/i })
    expect(approveBtn.disabled).toBe(true)

    // Auto-submit state tells the truth: answer the questions first.
    expect(screen.getByText(/before this can be submitted/i)).toBeTruthy()
  })

  it("shows read-only text + 'auto-submit when automation on' when approved but automation is off", async () => {
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
    // No editable textarea in read-only/approved view.
    expect(screen.queryByRole("textbox")).toBeNull()
    // Truthful gate state + link to turn automation on.
    expect(screen.getByText(/will auto-submit when you turn on automation/i)).toBeTruthy()
    const link = screen.getByRole("link", { name: /turn on automation/i })
    expect(link.getAttribute("href")).toContain("focus=profile-automations")
    // Approved status badge is present, and the approve button reads "Approved"
    // and is disabled (already approved — nothing more to do).
    expect(screen.getAllByText(/^Approved$/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole("button", { name: /^approved$/i }).disabled).toBe(true)
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
          gate_reason: "not_approved",
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
    fireEvent.click(screen.getByRole("button", { name: /save & approve/i }))

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
