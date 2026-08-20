// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { clientPostMock, toastMock } = vi.hoisted(() => ({
  clientPostMock: vi.fn(),
  toastMock: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  default: { post: (...args) => clientPostMock(...args) },
}))

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

import HamiltonAutopilotAuthorization from './HamiltonAutopilotAuthorization.jsx'

describe('HamiltonAutopilotAuthorization submit-by-default UX', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientPostMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, results: [] })
      .mockResolvedValueOnce({ ok: true, queued: true })
  })

  it('authorizes submit by default and launches with allow_auto_submit true', async () => {
    render(
      <HamiltonAutopilotAuthorization
        open
        onOpenChange={vi.fn()}
        profileId="profile-1"
        selectedSources={[{ opportunity_id: 'opp-1', title: 'Fixture opportunity' }]}
      />,
    )

    expect(screen.getByText(/submit applications when complete/i)).toBeTruthy()
    expect(screen.getByText(/allow auto-submit/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /run hamilton \(fill \+ submit\)/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /run hamilton \(fill \+ submit\)/i }))
    await waitFor(() => expect(clientPostMock).toHaveBeenCalledTimes(3))

    const authorizeBody = clientPostMock.mock.calls[0][1]
    expect(authorizeBody.authorization_types).toContain('submit_applications')
    expect(authorizeBody.replace_omitted_types).toBe(true)
    expect(authorizeBody.authorization_version).toBe('hamilton-autopilot-v2')
    expect(authorizeBody.options).toMatchObject({
      allow_auto_submit: true,
      submit_applications: true,
      require_human_review: false,
    })
    expect(clientPostMock.mock.calls[2][1].options.allow_auto_submit).toBe(true)
  })
})
