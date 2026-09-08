import { it, expect } from 'vitest'
import { parseDbTimestamp } from '../utils/dbTimestamp.js'

it('normalizes UTC database timestamps, explicit offsets and PostgreSQL Date values to one instant', () => {
  const expected = Date.parse('2026-09-08T12:34:56Z')
  for (const value of ['2026-09-08 12:34:56', '2026-09-08T12:34:56', '2026-09-08T08:34:56-04:00', new Date(expected)]) {
    expect(parseDbTimestamp(value)).toBe(expected)
  }
  expect(Number.isNaN(parseDbTimestamp(null))).toBe(true)
  expect(Number.isNaN(parseDbTimestamp('bad timestamp'))).toBe(true)
})
