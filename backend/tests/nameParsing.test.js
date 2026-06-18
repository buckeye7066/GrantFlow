import { describe, it, expect } from 'vitest'
import { parseFullName, looksLikeOrganization, deriveNamePartsIntoBasicInfo } from '../../shared/nameParsing.js'

describe('parseFullName', () => {
  it('splits a three-part personal name (the Anastasia case)', () => {
    expect(parseFullName('Anastasia Nicole White')).toMatchObject({
      first_name: 'Anastasia',
      middle_name: 'Nicole',
      last_name: 'White',
      is_org: false,
    })
  })

  it('splits a simple two-part name', () => {
    expect(parseFullName('John Doe')).toMatchObject({ first_name: 'John', middle_name: '', last_name: 'Doe' })
  })

  it('keeps a single token as first name only', () => {
    expect(parseFullName('Cher')).toMatchObject({ first_name: 'Cher', last_name: '' })
  })

  it('strips a leading honorific', () => {
    expect(parseFullName('Dr. Jane Smith')).toMatchObject({ first_name: 'Jane', last_name: 'Smith' })
  })

  it('captures a trailing generational suffix instead of treating it as the surname', () => {
    expect(parseFullName('John Smith Jr.')).toMatchObject({ first_name: 'John', last_name: 'Smith', suffix: 'Jr' })
  })

  it('handles "Last, First Middle" comma form', () => {
    expect(parseFullName('White, Anastasia Nicole')).toMatchObject({
      first_name: 'Anastasia',
      middle_name: 'Nicole',
      last_name: 'White',
    })
  })

  it('does not split organization names', () => {
    expect(parseFullName('Helping Hands Foundation')).toMatchObject({ is_org: true, first_name: '', last_name: '' })
    expect(looksLikeOrganization('Acme Inc')).toBe(true)
    expect(looksLikeOrganization('Anastasia Nicole White')).toBe(false)
  })

  it('returns empty parts for blank input', () => {
    expect(parseFullName('')).toMatchObject({ first_name: '', last_name: '', is_org: false })
    expect(parseFullName(null)).toMatchObject({ first_name: '', last_name: '' })
  })
})

describe('deriveNamePartsIntoBasicInfo', () => {
  it('derives first/last from full_name when missing', () => {
    const { data, changed } = deriveNamePartsIntoBasicInfo({ full_name: 'Anastasia Nicole White' })
    expect(changed).toBe(true)
    expect(data.first_name).toBe('Anastasia')
    expect(data.last_name).toBe('White')
    expect(data.middle_name).toBe('Nicole')
  })

  it('falls back to the supplied display name when the section has no full_name', () => {
    const { data, changed } = deriveNamePartsIntoBasicInfo({}, 'Anastasia Nicole White')
    expect(changed).toBe(true)
    expect(data.first_name).toBe('Anastasia')
    expect(data.last_name).toBe('White')
  })

  it('never clobbers human-entered first/last names', () => {
    const input = { full_name: 'Anastasia Nicole White', first_name: 'Ana', last_name: 'W' }
    const { data, changed } = deriveNamePartsIntoBasicInfo(input)
    expect(changed).toBe(false)
    expect(data).toBe(input)
    expect(data.first_name).toBe('Ana')
  })

  it('fills only the missing half', () => {
    const { data, changed } = deriveNamePartsIntoBasicInfo({ full_name: 'Anastasia Nicole White', first_name: 'Anastasia' })
    expect(changed).toBe(true)
    expect(data.first_name).toBe('Anastasia')
    expect(data.last_name).toBe('White')
  })

  it('does not derive parts for organization names', () => {
    const { changed } = deriveNamePartsIntoBasicInfo({ full_name: 'Helping Hands Foundation' })
    expect(changed).toBe(false)
  })

  it('is a no-op when there is no name source at all', () => {
    const input = { email: 'x@y.com' }
    const { data, changed } = deriveNamePartsIntoBasicInfo(input)
    expect(changed).toBe(false)
    expect(data).toBe(input)
  })
})
