import { expect, it } from 'vitest'
import { buildCalendarExport, calendarDate, upcomingPipelineGrants } from './calendarExport'

it('preserves date-only deadlines and skips invalid or rolling dates', () => {
  const events = ['2026-09-21', 'rolling', '2026-02-30', 'not a date'].map((deadline, id) => ({ id, deadline, title: 'Deadline' }))
  const text = buildCalendarExport(events, { month: '2026-09' })
  expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1)
  expect(text).toContain('DTSTART;VALUE=DATE:20260921\r\nDTEND;VALUE=DATE:20260922')
  expect(calendarDate('2026-02-30')).toBeNull()
})

it('exports only the selected month, with stable IDs, safe text and timed events', () => {
  const event = { id: 'run:one', deadline: '2026-09-21T15:30:00Z', title: 'Grant, one; \\ two\nBEGIN:VEVENT' }
  const text = buildCalendarExport([event, { id: 'other', deadline: '2026-10-01' }], { month: '2026-09' })
  expect(text).toContain('DTSTART:20260921T153000Z')
  expect(text).toContain('SUMMARY:Grant\\, one\\; \\\\ two\\nBEGIN:VEVENT')
  expect(text.match(/\r\nBEGIN:VEVENT/g)).toHaveLength(1)
  expect(text).toContain('UID:run%3Aone@grantflow')
})

it('folds long UTF-8 lines without breaking characters', () => {
  const text = buildCalendarExport([{ id: 'one', deadline: '2026-09-21', title: '資金🌱'.repeat(60) }])
  for (const line of text.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
  expect(text.replace(/\r\n /g, '')).toContain('SUMMARY:' + '資金🌱'.repeat(60))
})

it('keeps due-today and saved/preparation grants while respecting the profile filter', () => {
  const grants = [
    { id: 'one', profile_id: 'a', status: 'saved', deadline: '2026-09-21' },
    { id: 'two', profile_id: 'b', status: 'drafting', deadline: '2026-09-22' },
    { id: 'three', profile_id: 'a', status: 'gathering_documents', deadline: '2026-09-22' },
    { id: 'four', profile_id: 'a', status: 'archived', deadline: '2026-09-22' },
  ]
  expect(upcomingPipelineGrants(grants, 'a', new Date(2026, 8, 21, 18)).map(g => g.id)).toEqual(['one', 'three'])
})
