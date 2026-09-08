import { describe, expect, it } from 'vitest'
import { resolveAccountDisplayName } from './accountDisplayName.js'

const user = { display_name: 'mcnabbwg', primary_email: 'mcnabbwg@yahoo.com' }
const profiles = [{ id: 'p1', display_name: 'GeneMac' }, { id: 'p2', display_name: 'Other' }]

describe('resolveAccountDisplayName', () => {
  it('shows the active profile name to an end user, not the email-derived account name', () => {
    expect(resolveAccountDisplayName({ user, profiles, activeProfileId: 'p1' })).toBe('GeneMac')
  })
  it('keeps the account name for admins', () => {
    expect(resolveAccountDisplayName({ user, profiles, activeProfileId: 'p1', isAdmin: true })).toBe('mcnabbwg')
  })
  it('falls back to the account name when no active profile matches', () => {
    expect(resolveAccountDisplayName({ user, profiles, activeProfileId: 'missing' })).toBe('mcnabbwg')
    expect(resolveAccountDisplayName({ user, profiles: [], activeProfileId: 'p1' })).toBe('mcnabbwg')
  })
  it('never renders an empty name', () => {
    expect(resolveAccountDisplayName({ user: {}, profiles: [], activeProfileId: null })).toBe('User')
  })
})
