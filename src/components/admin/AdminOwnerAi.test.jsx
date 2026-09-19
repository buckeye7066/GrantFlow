// @vitest-environment jsdom
import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ value: {} }))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => state.value }))
import AdminOwnerAi from './AdminOwnerAi.jsx'
afterEach(cleanup)
it('shows status loading rather than disappearing', () => {
  state.value = { isPending: true }; render(<AdminOwnerAi />)
  expect(screen.getByText(/Checking owner subscription/i)).toBeTruthy()
})
it('distinguishes unavailable status from a disabled bridge', () => {
  state.value = { isError: true }; render(<AdminOwnerAi />)
  expect(screen.getByText(/status is unavailable/i)).toBeTruthy()
})


it('shows the owners no-metered-fallback policy instead of implying API billing', () => {
  state.value = {data:{enabled:true,online:true,busy:false,order:['subscription:codex','subscription:claude'],providers:{codex:'ready',claude:'auth_required'},metered_fallback_allowed:false}}
  render(<AdminOwnerAi />)
  expect(screen.getByText(/Metered API fallback is disabled/i)).toBeTruthy()
  expect(screen.getByText(/free models/i)).toBeTruthy()
})
