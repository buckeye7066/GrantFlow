import { describe, expect, it } from 'vitest'
import { guardProfileSectionPayload, guardProfileSectionSuggestion } from '../profileSuggestionGuards.js'

describe('profile location save precedence', () => {
  it('keeps an edited canonical ZIP even when an old alias follows it', () => {
    const result = guardProfileSectionPayload({ zip_code: '37312', zip: '37311' }, { sectionKey: 'basic_information' })
    expect(result.data.zip_code).toBe('37312')
  })
  it('keeps an intentional canonical clear instead of restoring an old ZIP', () => {
    const result = guardProfileSectionPayload({ zip_code: '', postal_code: '37311' }, { sectionKey: 'basic_information' })
    expect(result.data.zip_code).toBe('')
  })
  it('does not send old aliases back after merging a manual profile edit', () => {
    const result = guardProfileSectionSuggestion({ zip: '37311', city: 'Cleveland' }, { zip_code: '37312' }, { sectionKey: 'basic_information' })
    expect(result.data).toMatchObject({ zip_code: '37312', city: 'Cleveland' })
    expect(result.data).not.toHaveProperty('zip')
  })
})
