// @vitest-environment jsdom
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'

// Stub every branch child so we test ONLY the priority routing, not their deps.
vi.mock('@/components/onboarding/ForcedWelcomeVideo', () => ({
  default: () => <div data-testid="branch-forced-welcome-video" />,
}))
vi.mock('@/components/onboarding/AnyaGuidedTour', () => ({
  default: () => <div data-testid="branch-anya-guided-tour" />,
}))
vi.mock('@/components/onboarding/GuidedCycleTour', () => ({
  default: () => <div data-testid="branch-guided-cycle-tour" />,
}))
vi.mock('@/components/onboarding/ResetOnboardingFlow', () => ({
  default: () => <div data-testid="branch-reset-onboarding" />,
}))
vi.mock('@/components/onboarding/HamiltonFollowUpPrompt', () => ({
  default: () => <div data-testid="branch-hamilton-followup" />,
}))
vi.mock('@/components/shared/ErrorBoundary', () => ({
  default: ({ children }) => <>{children}</>,
}))

// Selector-style Zustand mock.
const authState = vi.hoisted(() => ({
  guidedCycleTourStatus: null,
  forcedWelcomeVideo: null,
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector) => selector(authState),
}))

import OnboardingSequencer from '../OnboardingSequencer.jsx'

const FORCED = { id: 'fwv-1', url: '/api/media/asset-1', label: 'Hi' }

describe('OnboardingSequencer forced welcome video priority', () => {
  beforeEach(() => {
    authState.guidedCycleTourStatus = null
    authState.forcedWelcomeVideo = null
  })

  it('renders ForcedWelcomeVideo when forcedWelcomeVideo is set', () => {
    authState.forcedWelcomeVideo = FORCED
    render(<OnboardingSequencer />)
    expect(screen.getByTestId('branch-forced-welcome-video')).toBeTruthy()
  })

  it('forced video BEATS pending_reinterview (highest priority)', () => {
    authState.forcedWelcomeVideo = FORCED
    authState.guidedCycleTourStatus = 'pending_reinterview'
    render(<OnboardingSequencer />)
    expect(screen.getByTestId('branch-forced-welcome-video')).toBeTruthy()
    expect(screen.queryByTestId('branch-reset-onboarding')).toBeNull()
  })

  it('forced video BEATS pending', () => {
    authState.forcedWelcomeVideo = FORCED
    authState.guidedCycleTourStatus = 'pending'
    render(<OnboardingSequencer />)
    expect(screen.getByTestId('branch-forced-welcome-video')).toBeTruthy()
    expect(screen.queryByTestId('branch-guided-cycle-tour')).toBeNull()
  })

  it('falls through to the normal branch once the forced video is cleared', () => {
    authState.forcedWelcomeVideo = null
    authState.guidedCycleTourStatus = 'pending_reinterview'
    render(<OnboardingSequencer />)
    expect(screen.queryByTestId('branch-forced-welcome-video')).toBeNull()
    expect(screen.getByTestId('branch-reset-onboarding')).toBeTruthy()
  })

  it('a forced video with no url does not gate (treated as absent)', () => {
    authState.forcedWelcomeVideo = { id: 'x', url: '' }
    authState.guidedCycleTourStatus = null
    render(<OnboardingSequencer />)
    expect(screen.queryByTestId('branch-forced-welcome-video')).toBeNull()
    expect(screen.getByTestId('branch-anya-guided-tour')).toBeTruthy()
  })
})
