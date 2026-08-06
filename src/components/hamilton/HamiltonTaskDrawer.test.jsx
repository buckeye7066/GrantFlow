// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getApplicationTaskMock, uploadManualSubmissionReceiptMock, clientGetMock, clientPostMock, toastMock } = vi.hoisted(() => ({
  getApplicationTaskMock: vi.fn(),
  uploadManualSubmissionReceiptMock: vi.fn(),
  clientGetMock: vi.fn(),
  clientPostMock: vi.fn(),
  toastMock: vi.fn(),
}))

vi.mock('@/api/hamilton', () => ({
  getApplicationTask: (...args) => getApplicationTaskMock(...args),
  statusLabel: (status) => status,
  approveAutoSubmit: vi.fn(),
  continueHamilton: vi.fn(),
  supplyMissingInfo: vi.fn(),
  uploadManualSubmissionReceipt: (...args) => uploadManualSubmissionReceiptMock(...args),
}))

vi.mock('@/api/client', () => ({
  default: {
    get: (...args) => clientGetMock(...args),
    post: (...args) => clientPostMock(...args),
  },
}))

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

vi.mock('@/components/profiles/MissingInfoChecklist', () => ({
  default: () => null,
}))

import HamiltonTaskDrawer from './HamiltonTaskDrawer.jsx'

describe('HamiltonTaskDrawer irreversible-boundary controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientGetMock.mockResolvedValue({ blockers: [] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    'submit_attempt_started',
    'submit_evidence_pending',
    'submission_verification_required',
  ])('quarantines %s in the UI instead of offering Continue or re-enable', async (status) => {
    const task = {
      id: `task-${status}`,
      profile_id: 'profile-1',
      status,
      assigned_agent: 'hamilton',
      auto_submit_enabled: true,
      allow_auto_submit: true,
      last_agent_message: 'Check the external portal before retrying.',
    }
    getApplicationTaskMock.mockResolvedValue({ task, events: [], missing_info: [] })

    render(<HamiltonTaskDrawer open onClose={vi.fn()} task={task} />)

    expect((await screen.findByRole('alert')).textContent).toMatch(/submission outcome needs verification/i)
    expect(screen.queryByRole('button', { name: /let hamilton continue/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^enable auto-submit$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /disable future submit intent/i })).toBeTruthy()
  })

  it('warns that cancellation cannot undo an uncertain external action before sending it', async () => {
    const task = {
      id: 'task-uncertain-cancel',
      profile_id: 'profile-1',
      status: 'submit_evidence_pending',
      assigned_agent: 'hamilton',
      auto_submit_enabled: false,
      allow_auto_submit: false,
    }
    getApplicationTaskMock.mockResolvedValue({ task, events: [], missing_info: [] })
    clientGetMock.mockResolvedValue({
      blockers: [{
        id: 'blocker-1',
        blocker_type: 'submission_verification_required',
        blocker_title: 'Verify portal receipt',
        blocker_message: 'The external outcome is uncertain.',
        required_action: 'cancel',
      }],
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<HamiltonTaskDrawer open onClose={vi.fn()} task={task} />)
    fireEvent.click(await screen.findByRole('button', { name: /cancel task/i }))

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/cannot undo.*verify the portal/is))
    expect(clientPostMock).not.toHaveBeenCalled()
  })

  it('requires explicit owner attestation before binding a manual submission receipt', async () => {
    const task = {
      id: 'task-manual-receipt',
      profile_id: 'profile-1',
      status: 'draft_completed',
      assigned_agent: 'hamilton',
      portal_url: 'https://funder.example/apply',
      auto_submit_enabled: false,
      allow_auto_submit: false,
    }
    const submittedTask = {
      ...task,
      status: 'submitted',
      submission_proof: {
        verified_external: true,
        label: 'Externally submitted — owner-attested portal confirmation on file',
        evidence_authority: 'owner_attestation',
        proof_document_id: 'doc-receipt-1',
      },
    }
    getApplicationTaskMock
      .mockResolvedValueOnce({ task, events: [], missing_info: [] })
      .mockResolvedValue({
        task: submittedTask,
        events: [{
          id: 'event-receipt-1',
          event_type: 'submitted',
          status: 'submitted',
          message: 'Owner-attested portal confirmation evidence was bound to this task.',
          created_at: '2026-08-06T14:00:00.000Z',
        }],
        missing_info: [],
      })
    uploadManualSubmissionReceiptMock.mockResolvedValue({ task: submittedTask })

    render(<HamiltonTaskDrawer open onClose={vi.fn()} task={task} />)

    const saveButton = await screen.findByRole('button', { name: /save submission receipt/i })
    expect(saveButton.disabled).toBe(true)

    const fileInput = screen.getByLabelText(/portal confirmation/i)
    const receipt = new File(['%PDF-1.7 receipt'], 'receipt.pdf', { type: 'application/pdf' })
    fireEvent.change(fileInput, { target: { files: [receipt] } })
    expect(saveButton.disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox'))
    expect(saveButton.disabled).toBe(false)
    fireEvent.click(saveButton)

    await waitFor(() => expect(uploadManualSubmissionReceiptMock).toHaveBeenCalledTimes(1))
    expect(uploadManualSubmissionReceiptMock).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        file: receipt,
        idempotencyKey: expect.stringMatching(/^manual-receipt-/),
      }),
    )
    expect(await screen.findByText(/owner-attested portal confirmation on file/i)).toBeTruthy()
    expect(screen.getByText(/not independently verified by a funder api/i)).toBeTruthy()
    expect(await screen.findByText(/owner-attested portal confirmation evidence was bound/i)).toBeTruthy()
  })

  it('offers receipt reconciliation for an internal submitted row but not after proof exists', async () => {
    const task = {
      id: 'task-submitted-unverified',
      profile_id: 'profile-1',
      status: 'submitted',
      assigned_agent: 'hamilton',
      application_url: 'https://funder.example/apply',
      submission_proof: { verified_external: false },
    }
    getApplicationTaskMock.mockResolvedValue({ task, events: [], missing_info: [] })

    const first = render(<HamiltonTaskDrawer open onClose={vi.fn()} task={task} />)

    expect(await screen.findByRole('button', { name: /save submission receipt/i })).toBeTruthy()
    expect(screen.getByText(/does not complete those steps or independently verify/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /open portal/i }).getAttribute('href'))
      .toBe('https://funder.example/apply')

    const verified = {
      ...task,
      submission_proof: {
        verified_external: true,
        source: 'owner_attested_manual_receipt',
        evidence_authority: 'owner_attestation',
      },
    }
    getApplicationTaskMock.mockResolvedValue({ task: verified, events: [], missing_info: [] })
    first.unmount()
    render(<HamiltonTaskDrawer open onClose={vi.fn()} task={verified} />)

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /save submission receipt/i })).toBeNull()
    })
  })

  it('does not offer receipt retention without a real server-recorded HTTPS portal', async () => {
    const task = {
      id: 'task-synthetic-portal',
      profile_id: 'profile-1',
      status: 'ready_to_submit',
      assigned_agent: 'hamilton',
      portal_url: 'https://hamilton-submit-fixture.invalid/apply',
    }
    getApplicationTaskMock.mockResolvedValue({ task, events: [], missing_info: [] })

    render(<HamiltonTaskDrawer open onClose={vi.fn()} task={task} />)

    expect(await screen.findByRole('status')).toHaveTextContent(/server-recorded official https portal/i)
    expect(screen.queryByRole('button', { name: /save submission receipt/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /open portal/i })).toBeNull()
  })
})
