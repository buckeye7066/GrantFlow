// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ShareGrantFlowButton from './ShareGrantFlowButton.jsx'
import { GRANTFLOW_SHARE } from '@/lib/shareGrantFlow.js'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })
it('shares only the public app entry even from an owner profile URL with a token fragment', async () => {
  window.history.replaceState({}, '', '/ProfileDetail?id=private-profile&admin=1#access_token=private-session')
  const share = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'share', { configurable: true, value: share })
  render(<ShareGrantFlowButton />); fireEvent.click(screen.getByRole('button'))
  await waitFor(() => expect(share).toHaveBeenCalledWith(GRANTFLOW_SHARE))
  expect(GRANTFLOW_SHARE.url).toBe('https://app.axiombiolabs.org/welcome')
  expect(JSON.stringify(share.mock.calls)).not.toContain('private-')
})
