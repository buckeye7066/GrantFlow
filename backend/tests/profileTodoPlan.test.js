import { describe, it, expect } from 'vitest'
import {
  todoHasMeaningfulValue,
  todoSectionIsComplete,
  parseTodoDeadline,
  futureDeadlineFor,
  todoTargetsCompleteSection,
  sanitizeTodoPlan,
  formatTodoDate,
} from '../services/profileTodoPlan.js'

describe('profileTodoPlan completion helpers', () => {
  it('treats empty / sentinel / false values as not meaningful', () => {
    expect(todoHasMeaningfulValue('')).toBe(false)
    expect(todoHasMeaningfulValue('unknown')).toBe(false)
    expect(todoHasMeaningfulValue(false)).toBe(false)
    expect(todoHasMeaningfulValue(null)).toBe(false)
    expect(todoHasMeaningfulValue([])).toBe(false)
    expect(todoHasMeaningfulValue({})).toBe(false)
  })

  it('treats real strings / numbers / non-empty collections as meaningful', () => {
    expect(todoHasMeaningfulValue('Acme Org')).toBe(true)
    expect(todoHasMeaningfulValue(0)).toBe(true)
    expect(todoHasMeaningfulValue(['a'])).toBe(true)
    expect(todoHasMeaningfulValue({ a: 'b' })).toBe(true)
  })

  it('marks a section complete when any field has a meaningful value', () => {
    expect(todoSectionIsComplete({ employer: 'Axiom', status: '' })).toBe(true)
    expect(todoSectionIsComplete({ employer: '', status: 'unknown' })).toBe(false)
    expect(todoSectionIsComplete(null)).toBe(false)
  })
})

describe('profileTodoPlan deadline helpers', () => {
  it('parses real calendar dates, ignores vague timeframes', () => {
    expect(parseTodoDeadline('2024-01-15')).toBeInstanceOf(Date)
    expect(parseTodoDeadline('within 2 weeks')).toBeNull()
    expect(parseTodoDeadline('ASAP')).toBeNull()
    expect(parseTodoDeadline('')).toBeNull()
    expect(parseTodoDeadline(null)).toBeNull()
  })

  it('computes future offsets spaced by priority', () => {
    const today = new Date(Date.UTC(2026, 5, 22)) // 2026-06-22
    expect(futureDeadlineFor('critical', today)).toBe('2026-06-29')
    expect(futureDeadlineFor('high', today)).toBe('2026-07-06')
    expect(futureDeadlineFor('medium', today)).toBe('2026-07-22')
    expect(futureDeadlineFor('low', today)).toBe('2026-08-21')
    expect(futureDeadlineFor(undefined, today)).toBe('2026-07-22') // defaults to medium
  })
})

describe('todoTargetsCompleteSection', () => {
  const complete = new Set(['employment', 'health_medical', 'financial_information'])

  it('suppresses "complete X section" items when X is already complete', () => {
    expect(
      todoTargetsCompleteSection({ title: 'Complete Employment Section', profile_section: 'employment' }, complete),
    ).toBe(true)
    expect(
      todoTargetsCompleteSection({ title: 'Fill in your Health Section', profile_section: 'health_medical' }, complete),
    ).toBe(true)
  })

  it('does not suppress real-world actions that merely reference the section', () => {
    expect(
      todoTargetsCompleteSection(
        { title: 'Request a letter from your doctor', profile_section: 'health_medical' },
        complete,
      ),
    ).toBe(false)
  })

  it('does not suppress items for incomplete sections', () => {
    expect(
      todoTargetsCompleteSection({ title: 'Complete Education Section', profile_section: 'education' }, complete),
    ).toBe(false)
  })
})

describe('sanitizeTodoPlan', () => {
  const today = new Date('2026-06-22T15:00:00.000Z')
  const completeSectionKeys = new Set(['employment', 'health_medical', 'financial_information'])

  it('drops already-complete-section tasks and rewrites past-dated deadlines', () => {
    const todo = {
      categories: [
        {
          name: 'Profile Completion',
          items: [
            { title: 'Complete Employment Section', priority: 'high', deadline: '2024-01-15', profile_section: 'employment' },
            { title: 'Complete Health Section', priority: 'medium', deadline: null, profile_section: 'health_medical' },
            { title: 'Complete Financial Information Section', priority: 'high', deadline: null, profile_section: 'financial_information' },
            { title: 'Complete Education Section', priority: 'medium', deadline: '2023-10-31', profile_section: 'education' },
          ],
        },
        {
          name: 'Immediate Actions',
          items: [
            { title: 'Submit the XYZ grant', priority: 'critical', deadline: '2023-10-31' },
          ],
        },
      ],
      total_items: 5,
    }

    const out = sanitizeTodoPlan(todo, { today, completeSectionKeys })

    // The three already-complete sections are dropped; only the incomplete
    // Education task survives in the first category.
    const completionCat = out.categories.find((c) => c.name === 'Profile Completion')
    expect(completionCat.items).toHaveLength(1)
    expect(completionCat.items[0].title).toBe('Complete Education Section')
    // Its past date (2023-10-31) was rewritten to a future medium offset.
    expect(completionCat.items[0].deadline).toBe('2026-07-22')

    // The critical immediate action's past date is bumped to a near-future date.
    const immediateCat = out.categories.find((c) => c.name === 'Immediate Actions')
    expect(immediateCat.items[0].deadline).toBe('2026-06-29')

    // Totals + generated_date reflect today.
    expect(out.total_items).toBe(2)
    expect(out.generated_date).toBe('2026-06-22')
  })

  it('removes categories that become empty after filtering', () => {
    const todo = {
      categories: [
        {
          name: 'Profile Completion',
          items: [
            { title: 'Complete Employment Section', priority: 'high', deadline: null, profile_section: 'employment' },
          ],
        },
      ],
      total_items: 1,
    }
    const out = sanitizeTodoPlan(todo, { today, completeSectionKeys })
    expect(out.categories).toHaveLength(0)
    expect(out.total_items).toBe(0)
  })

  it('leaves already-future deadlines untouched', () => {
    const todo = {
      categories: [
        { name: 'Future', items: [{ title: 'Do thing', priority: 'high', deadline: '2026-12-01' }] },
      ],
    }
    const out = sanitizeTodoPlan(todo, { today, completeSectionKeys })
    expect(out.categories[0].items[0].deadline).toBe('2026-12-01')
  })

  it('is a no-op for malformed input', () => {
    expect(sanitizeTodoPlan({ raw: 'oops' }, { today, completeSectionKeys })).toEqual({ raw: 'oops' })
    expect(sanitizeTodoPlan(null, { today, completeSectionKeys })).toBeNull()
  })
})

describe('formatTodoDate', () => {
  it('formats as YYYY-MM-DD in UTC', () => {
    expect(formatTodoDate(new Date('2026-06-22T23:30:00.000Z'))).toBe('2026-06-22')
  })
})
