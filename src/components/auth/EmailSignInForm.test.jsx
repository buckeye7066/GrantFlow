import { describe, expect, it } from 'vitest'
import { looksLikeEmail, normalizePhoneE164 } from './EmailSignInForm'

describe('login identifier detection', () => {
  it('treats values with @ as email, others as phone', () => {
    expect(looksLikeEmail('jane@example.org')).toBe(true)
    expect(looksLikeEmail('+1 555 123 4567')).toBe(false)
    expect(looksLikeEmail('5551234567')).toBe(false)
  })
})

describe('normalizePhoneE164 (client-side, before sending to backend)', () => {
  it('prepends +1 for bare US 10-digit numbers (backend would otherwise mangle it)', () => {
    expect(normalizePhoneE164('5551234567')).toBe('+15551234567')
    expect(normalizePhoneE164('(555) 123-4567')).toBe('+15551234567')
    expect(normalizePhoneE164('555.123.4567')).toBe('+15551234567')
  })

  it('handles US 11-digit with leading 1', () => {
    expect(normalizePhoneE164('15551234567')).toBe('+15551234567')
    expect(normalizePhoneE164('1 (555) 123-4567')).toBe('+15551234567')
  })

  it('preserves an explicit + country code', () => {
    expect(normalizePhoneE164('+447911123456')).toBe('+447911123456')
    expect(normalizePhoneE164('+1 555 123 4567')).toBe('+15551234567')
  })

  it('rejects values too short to be a phone number', () => {
    expect(normalizePhoneE164('12345')).toBeNull()
    expect(normalizePhoneE164('')).toBeNull()
    expect(normalizePhoneE164(null)).toBeNull()
    expect(normalizePhoneE164('+12')).toBeNull()
  })
})
