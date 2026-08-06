// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }))

vi.mock('@/api/apiClient', () => ({
  apiFetch: (...args) => apiFetchMock(...args),
}))
vi.mock('@/api/client', () => ({ default: {} }))
vi.mock('@/config/env.js', () => ({ getApiBasePrefixForFetch: () => '' }))

import { uploadManualSubmissionReceipt } from './hamilton.js'

describe('uploadManualSubmissionReceipt', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    apiFetchMock.mockResolvedValue({ ok: true })
  })

  it('sends one attested multipart receipt with an idempotency key', async () => {
    const file = new File(['%PDF-1.7 receipt'], 'receipt.pdf', { type: 'application/pdf' })

    await uploadManualSubmissionReceipt('task 1', {
      file,
      submittedAt: '2026-08-06T14:00:00.000Z',
      confirmationReference: 'CONF-123',
      idempotencyKey: 'manual-receipt-test-1',
    })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [endpoint, options] = apiFetchMock.mock.calls[0]
    expect(endpoint).toBe('/api/hamilton/automation/tasks/task%201/manual-submission-receipt')
    expect(options.method).toBe('POST')
    expect(options.headers).toEqual({ 'Idempotency-Key': 'manual-receipt-test-1' })
    expect(options.body).toBeInstanceOf(FormData)
    expect(options.body.get('receipt')).toBe(file)
    expect(options.body.get('submitted_at')).toBe('2026-08-06T14:00:00.000Z')
    expect(options.body.get('confirmation_reference')).toBe('CONF-123')
    expect(options.body.get('attested')).toBe('true')
    expect(options.body.get('attestation_version')).toBe('hamilton-manual-submit-v1')
  })

  it('refuses an incomplete request before issuing a mutation', async () => {
    await expect(uploadManualSubmissionReceipt('task-1', {
      submittedAt: '2026-08-06T14:00:00.000Z',
      idempotencyKey: 'manual-receipt-test-2',
    })).rejects.toThrow(/receipt file required/i)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})
