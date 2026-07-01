/**
 * isMetadataExpired must be robust to a MISSING or CORRUPTED expires_at so a
 * synthetic profile with malformed metadata can never become immortal (some prod
 * rows had a malformed multi-value expires_at). It falls back to
 * created_at + ttl_hours.
 */
import { describe, it, expect } from 'vitest'
import { isMetadataExpired } from '../services/amy/amyMetadata.js'

const now = new Date('2026-07-01T00:00:00.000Z')
const hoursAgo = (h) => new Date(now.getTime() - h * 3600 * 1000).toISOString()

describe('isMetadataExpired (corruption-hardened)', () => {
  it('uses a valid expires_at when present', () => {
    expect(isMetadataExpired({ expires_at: hoursAgo(1) }, now)).toBe(true)   // past
    expect(isMetadataExpired({ expires_at: new Date(now.getTime() + 3600e3).toISOString() }, now)).toBe(false) // future
  })

  it('falls back to created_at + ttl_hours when expires_at is CORRUPTED', () => {
    // Corrupt multi-value string + created 50h ago, ttl 48h → expired.
    const corrupt = `${hoursAgo(50)}\n${hoursAgo(48)}`
    expect(isMetadataExpired({ expires_at: corrupt, created_at: hoursAgo(50), ttl_hours: 48 }, now)).toBe(true)
    // Same corruption but created only 1h ago → NOT expired yet.
    expect(isMetadataExpired({ expires_at: corrupt, created_at: hoursAgo(1), ttl_hours: 48 }, now)).toBe(false)
  })

  it('falls back when expires_at is MISSING', () => {
    expect(isMetadataExpired({ created_at: hoursAgo(100), ttl_hours: 48 }, now)).toBe(true)
    expect(isMetadataExpired({ created_at: hoursAgo(10), ttl_hours: 48 }, now)).toBe(false)
  })

  it('is false (not immortal-safe to delete) when nothing is parseable', () => {
    expect(isMetadataExpired({ expires_at: 'garbage' }, now)).toBe(false) // no created_at → can't judge
    expect(isMetadataExpired(null, now)).toBe(false)
  })
})
