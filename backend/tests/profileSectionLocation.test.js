/**
 * The profiles table has NO state/city/zip columns. Every location fact lives
 * in profile_sections.basic_information, in one of three shapes existing
 * profiles use. Before this reader, loadProfileContext logged
 * `zip=? state=? city=?` for a Cleveland, TN 37312 student and every
 * state-keyed lane missed her by construction (prod 2026-09-05).
 */
import { describe, it, expect } from 'vitest'
import { readSectionLocation } from '../services/profileHelpers.js'

describe('readSectionLocation', () => {
  it('reads flat basic_information keys', () => {
    expect(readSectionLocation({ basic_information: { state: 'tn', city: 'Cleveland', zip_code: '37312' } }))
      .toEqual({ state: 'TN', city: 'Cleveland', zip: '37312' })
  })

  it('reads the nested location object the intake writes', () => {
    expect(readSectionLocation({
      basic_information: { location: { city: 'Cleveland', county: 'Bradley County', state: 'TN', zip_code: '37312' } },
    })).toEqual({ state: 'TN', city: 'Cleveland', zip: '37312' })
  })

  it('reads a structured address object', () => {
    expect(readSectionLocation({
      basic_information: { address: { line1: '100 Main St', city: 'Cleveland', state: 'TN', postal_code: '37311-1234' } },
    })).toEqual({ state: 'TN', city: 'Cleveland', zip: '37311-1234' })
  })

  it('parses the trailing "City, ST ZIP" of a free-text address only for parts nothing structured supplies', () => {
    const fromText = readSectionLocation({
      basic_information: { address: '3940 Eveningside Dr. NE \nCleveland, TN 37312' },
    })
    expect(fromText).toEqual({ state: 'TN', city: 'Cleveland', zip: '37312' })
    // A structured city wins over the text-derived one; the text still fills state/zip.
    expect(readSectionLocation({
      basic_information: { city: 'Charleston', address: '1 Road\nCleveland, TN 37312' },
    })).toEqual({ state: 'TN', city: 'Charleston', zip: '37312' })
  })

  it('corroborates the ZIP across shapes: a stray flat zip_code loses to a location object and address line that agree', () => {
    expect(readSectionLocation({
      basic_information: {
        zip_code: '55402',
        city: 'Cleveland',
        state: 'TN',
        location: { city: 'Cleveland', state: 'TN', zip_code: '37312' },
        address: '3940 Eveningside Dr. NE \nCleveland, TN 37312',
      },
    })).toEqual({ state: 'TN', city: 'Cleveland', zip: '37312' })
    // A one-to-one disagreement keeps the flat value.
    expect(readSectionLocation({
      basic_information: { zip_code: '37311', address: '1 Road\nCleveland, TN 37312' },
    })).toEqual({ state: 'TN', city: 'Cleveland', zip: '37311' })
  })

  it('refuses shapes that are not a US state code or ZIP instead of guessing', () => {
    expect(readSectionLocation({ basic_information: { state: 'Tennessee', zip: 'SW1A 1AA', city: 'London' } }))
      .toEqual({ state: null, city: 'London', zip: null })
    expect(readSectionLocation({})).toEqual({ state: null, city: null, zip: null })
    expect(readSectionLocation(null)).toEqual({ state: null, city: null, zip: null })
  })
})
