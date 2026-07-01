// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ProfileGapInterview from '../ProfileGapInterview.jsx'

const PLAN = {
  complete: false,
  needs_questions: true,
  questions: [
    { id: 'has_disability', type: 'yes_no', prompt: 'Do you have a disability?',
      writes: { section: 'demographics', field: 'disability_status', yes: 'Has disability', no: 'No disability' } },
    { id: 'is_senior', type: 'yes_no', prompt: 'Are you 60 or older?',
      writes: { section: 'demographics', field: 'age_group', yes: 'Senior 60+', no: null } },
    { id: 'state', type: 'text', prompt: 'Which state do you live in?',
      writes: { section: 'location_focus', field: 'state' } },
  ],
}

describe('ProfileGapInterview', () => {
  it('renders every question prompt', () => {
    render(<ProfileGapInterview plan={PLAN} onSubmit={() => {}} />)
    expect(screen.getByText('Do you have a disability?')).toBeTruthy()
    expect(screen.getByText('Are you 60 or older?')).toBeTruthy()
    expect(screen.getByText('Which state do you live in?')).toBeTruthy()
  })

  it('maps answers to section updates (yes→value, no→null skipped, text→as-is)', () => {
    const onSubmit = vi.fn()
    render(<ProfileGapInterview plan={PLAN} onSubmit={onSubmit} />)

    const yesButtons = screen.getAllByText('Yes')
    const noButtons = screen.getAllByText('No')
    fireEvent.click(yesButtons[0]) // has_disability = Yes → 'Has disability'
    fireEvent.click(noButtons[1])  // is_senior = No → age_group null → skipped
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'TN' } })

    fireEvent.click(screen.getByText('Save & continue'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [updates] = onSubmit.mock.calls[0]
    expect(updates).toEqual({
      demographics: { disability_status: 'Has disability' },
      location_focus: { state: 'TN' },
    })
    // is_senior answered "No" writes nothing (age_group side is null).
    expect(updates.demographics.age_group).toBeUndefined()
  })

  it('disables submit until at least one answer is given', () => {
    render(<ProfileGapInterview plan={PLAN} onSubmit={() => {}} />)
    const save = screen.getByText('Save & continue').closest('button')
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getAllByText('Yes')[0])
    expect(save.disabled).toBe(false)
  })

  it('renders nothing when there are no questions', () => {
    const { container } = render(<ProfileGapInterview plan={{ questions: [] }} onSubmit={() => {}} />)
    expect(container.querySelector('[data-testid="profile-gap-interview"]')).toBeNull()
  })
})
