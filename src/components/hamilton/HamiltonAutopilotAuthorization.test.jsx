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

describe('HamiltonAutopilotAuthorization fail-closed submit UX', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientPostMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, results: [] })
      .mockResolvedValueOnce({ ok: true, queued: true })
  })

  it('does not offer real auto-submit and launches draft preparation with a human-review veto', async () => {
    render(
      <HamiltonAutopilotAuthorization
        open
        onOpenChange={vi.fn()}
        profileId="profile-1"
        selectedSources={[{ opportunity_id: 'opp-1', title: 'Fixture opportunity' }]}
      />,
    )

    expect(screen.getByText(/final portal submit and new-account creation are not automated/i)).toBeTruthy()
    expect(screen.queryByText(/allow auto-submit/i)).toBeNull()
    expect(screen.queryByText(/submit applications when complete/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /run hamilton to prepare drafts/i }))
    await waitFor(() => expect(clientPostMock).toHaveBeenCalledTimes(3))

    const authorizeBody = clientPostMock.mock.calls[0][1]
    expect(authorizeBody.authorization_types).not.toContain('submit_applications')
    expect(authorizeBody.options).toMatchObject({
      allow_auto_submit: false,
      submit_applications: false,
      require_human_review: true,
    })
    expect(clientPostMock.mock.calls[2][1].options.allow_auto_submit).toBe(false)
  })
})
