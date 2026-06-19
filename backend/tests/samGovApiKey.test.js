import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getSamGovApiKey } from '../config/grantsGovEndpoints.js'

// Guards the historical split where the gate read SAM_GOV_PUBLIC_API_KEY but the
// connectors read SAM_GOV_API_KEY — setting one name silently did nothing.
describe('getSamGovApiKey', () => {
  const had = {
    pub: Object.prototype.hasOwnProperty.call(process.env, 'SAM_GOV_PUBLIC_API_KEY'),
    legacy: Object.prototype.hasOwnProperty.call(process.env, 'SAM_GOV_API_KEY'),
  }
  const orig = { pub: process.env.SAM_GOV_PUBLIC_API_KEY, legacy: process.env.SAM_GOV_API_KEY }

  beforeEach(() => {
    delete process.env.SAM_GOV_PUBLIC_API_KEY
    delete process.env.SAM_GOV_API_KEY
  })
  afterEach(() => {
    if (had.pub) process.env.SAM_GOV_PUBLIC_API_KEY = orig.pub; else delete process.env.SAM_GOV_PUBLIC_API_KEY
    if (had.legacy) process.env.SAM_GOV_API_KEY = orig.legacy; else delete process.env.SAM_GOV_API_KEY
  })

  it('returns null when neither variable is set', () => {
    expect(getSamGovApiKey()).toBeNull()
  })

  it('reads the documented SAM_GOV_PUBLIC_API_KEY', () => {
    process.env.SAM_GOV_PUBLIC_API_KEY = 'pub-key'
    expect(getSamGovApiKey()).toBe('pub-key')
  })

  it('falls back to the legacy SAM_GOV_API_KEY', () => {
    process.env.SAM_GOV_API_KEY = 'legacy-key'
    expect(getSamGovApiKey()).toBe('legacy-key')
  })

  it('prefers SAM_GOV_PUBLIC_API_KEY when both are set', () => {
    process.env.SAM_GOV_PUBLIC_API_KEY = 'pub-key'
    process.env.SAM_GOV_API_KEY = 'legacy-key'
    expect(getSamGovApiKey()).toBe('pub-key')
  })
})
