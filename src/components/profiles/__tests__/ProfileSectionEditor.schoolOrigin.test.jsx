// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ProfileSectionEditor from '../ProfileSectionEditor.jsx'

global.ResizeObserver = global.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
afterEach(cleanup)

it('lets an adult edit and save their own school history through Basic Information', async () => {
  const onSave = vi.fn()
  render(<ProfileSectionEditor open sectionKey="basic_information" profileId="adult-school-test" profileType="senior"
    initialData={{ full_name: 'Example Applicant', applicant_high_school_type: 'public', applicant_high_school_graduation_year: '1990' }}
    onClose={() => {}} onSave={onSave} isSaving={false} />)
  const county = screen.getByRole('textbox', { name: /Applicant high school county/i })
  fireEvent.change(county, { target: { value: 'Raleigh' } })
  expect(screen.queryByRole('textbox', { name: /^Academic status$/i })).toBeNull()
  fireEvent.click(screen.getByText('Save changes'))
  await waitFor(() => expect(onSave).toHaveBeenCalled())
  expect(onSave.mock.calls[0][0]).toMatchObject({ applicant_high_school_county: 'Raleigh', applicant_high_school_type: 'public', applicant_high_school_graduation_year: '1990' })
})

it('does not add personal school-history questions to a nonprofit profile', () => {
  render(<ProfileSectionEditor open sectionKey="basic_information" profileId="org-school-test" profileType="nonprofit"
    initialData={{ full_name: 'Example Organization' }} onClose={() => {}} onSave={() => {}} isSaving={false} />)
  expect(screen.queryByRole('textbox', { name: /Applicant high school county/i })).toBeNull()
})
