// @vitest-environment jsdom
import React from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ access: 'signin_wall', toast: vi.fn(), onSuccess: null }))
vi.mock('@/api/hamilton', () => ({ listPortalSessions: vi.fn(), listPortalCredentials: vi.fn(), runPortalSyncRead: vi.fn(), runPortalSyncWrite: vi.fn(), listPortalSyncRuns: vi.fn() }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }))
vi.mock('@/components/shared/toastHelpers', () => ({ showErrorToast: (_toast, _title, message) => state.toast(message), showSuccessToast: vi.fn() }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }) => ({ data: queryKey[0] === 'hamilton-portal-sessions'
    ? { sessions: [{ portal_host: 'portal.example.org', status: 'valid' }] }
    : queryKey[0] === 'hamilton-portal-sync-runs'
      ? { runs: [{ portal_host: 'portal.example.org', status: 'failed', error: 'portal_access_unproven', summary: { read: { access: state.access } } }] }
      : { credentials: [] }, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: options => ({ mutate: host => options.onSuccess({ ok: false, error: 'portal_access_unproven', read: { access: state.access } }, host), isPending: false }),
}))
import PortalSyncCard from './PortalSyncCard.jsx'
beforeEach(() => { state.toast.mockClear() })
afterEach(cleanup)
it.each([
  ['signin_wall', /sign in again/i],
  ['blocked', /blocked this browser/i],
  ['unknown', /could not verify/i],
])('explains %s in both run history and the immediate failure toast', (access, expected) => {
  state.access = access
  render(<PortalSyncCard profileId="fixture-profile" />)
  expect(screen.getByText(expected)).toBeTruthy()
  fireEvent.click(screen.getByText('Pull data from portal'))
  expect(state.toast).toHaveBeenCalledWith(expect.stringMatching(expected))
})
