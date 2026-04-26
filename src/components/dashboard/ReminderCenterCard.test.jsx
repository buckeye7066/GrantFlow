// @vitest-environment jsdom
import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import ReminderCenterCard from "./ReminderCenterCard.jsx"

function renderWithQueryClient(ui) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe("ReminderCenterCard", () => {
  it("renders without crashing before an AI plan has a generated timestamp", () => {
    expect(() =>
      renderWithQueryClient(
        <ReminderCenterCard
          urgentDeadlines={[]}
          upcomingMilestones={[]}
        />,
      ),
    ).not.toThrow()

    expect(screen.getByText("Reminders & Nudges")).toBeTruthy()
    expect(screen.queryByText(/^Generated /)).toBeNull()
  })
})
