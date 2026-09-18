// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ProfileSectionEditor from '../ProfileSectionEditor.jsx'
import { guardProfileSectionSuggestion } from '../../../utils/profileSuggestionGuards.js'

global.ResizeObserver = global.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
afterEach(cleanup)

it('loads a stored legacy ZIP into the editor and preserves it when only the phone changes', async () => {
  const initialData = { full_name: 'Example Applicant', email: 'example@example.invalid', state: 'TN', city: 'Cleveland', zip: '37311' }
  const onSave = vi.fn()
  render(<ProfileSectionEditor open sectionKey="basic_information" profileId="zip-roundtrip" profileType="individual"
    initialData={initialData} onClose={() => {}} onSave={onSave} isSaving={false} />)
  const zip = screen.getByRole('textbox', { name: /^ZIP code/i })
  expect(zip.value).toBe('37311')
  fireEvent.change(screen.getByRole('textbox', { name: /^Phone number/i }), { target: { value: '4235550123' } })
  fireEvent.click(screen.getByText('Save changes'))
  await waitFor(() => expect(onSave).toHaveBeenCalled())
  const guarded = guardProfileSectionSuggestion(initialData, onSave.mock.calls[0][0], { sectionKey: 'basic_information', profile: { primary_type: 'individual' } })
  expect(guarded.data.zip_code).toBe('37311')
  expect(guarded.data.phone).toBe('4235550123')
})
