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

  const hadAlias = Object.prototype.hasOwnProperty.call(process.env, 'Sam_gov_key')
  const origAlias = process.env.Sam_gov_key

  beforeEach(() => {
    delete process.env.SAM_GOV_PUBLIC_API_KEY
    delete process.env.SAM_GOV_API_KEY
    delete process.env.Sam_gov_key
  })
  afterEach(() => {
    if (had.pub) process.env.SAM_GOV_PUBLIC_API_KEY = orig.pub; else delete process.env.SAM_GOV_PUBLIC_API_KEY
    if (had.legacy) process.env.SAM_GOV_API_KEY = orig.legacy; else delete process.env.SAM_GOV_API_KEY
    if (hadAlias) process.env.Sam_gov_key = origAlias; else delete process.env.Sam_gov_key
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

  // A real key was once saved in Railway as `Sam_gov_key` — case-sensitive env
  // names meant the code never read it, silently disabling all of SAM.gov.
  it('falls back to a hand-entered Sam_gov_key variant', () => {
    process.env.Sam_gov_key = 'dashboard-key'
    expect(getSamGovApiKey()).toBe('dashboard-key')
  })
})

describe('loadFundingApiKeys SAM resolution', () => {
  it('also reads the Sam_gov_key dashboard variant', async () => {
    const { loadFundingApiKeys } = await import('../src/config/apiKeys.js')
    const had = Object.prototype.hasOwnProperty.call(process.env, 'Sam_gov_key')
    const orig = process.env.Sam_gov_key
    delete process.env.SAM_GOV_PUBLIC_API_KEY
    delete process.env.SAM_GOV_API_KEY
    process.env.Sam_gov_key = 'dashboard-key'
    try {
      expect(loadFundingApiKeys().SAM_GOV_PUBLIC_API_KEY).toBe('dashboard-key')
    } finally {
      if (had) process.env.Sam_gov_key = orig
      else delete process.env.Sam_gov_key
    }
  })
})
