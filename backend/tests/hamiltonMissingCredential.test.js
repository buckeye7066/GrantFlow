/**
 * Hamilton missing-credential flag — pure notice/link builders.
 */
import { describe, it, expect } from 'vitest'
import {
  hostOfUrl,
  buildAddCredentialLink,
  missingCredentialNotice,
  MISSING_CREDENTIAL_NOTIFICATION_TYPE,
} from '../services/hamilton/hamiltonMissingCredential.js'

describe('hostOfUrl', () => {
  it('extracts a lowercased hostname, with or without scheme', () => {
    expect(hostOfUrl('https://www.MTSU.edu/financial-aid/')).toBe('www.mtsu.edu')
    expect(hostOfUrl('pipelinemt.mtsu.edu/login')).toBe('pipelinemt.mtsu.edu')
    expect(hostOfUrl('')).toBeNull()
    expect(hostOfUrl('not a url')).toBeNull()
  })
})

describe('buildAddCredentialLink', () => {
  it('deep-links to the profile Universities tab with host + loginUrl prefilled', () => {
    const link = buildAddCredentialLink({ profileId: 'p1', host: 'mtsu.edu', loginUrl: 'https://pipelinemt.mtsu.edu' })
    expect(link).toContain('/ProfileDetail?')
    expect(link).toContain('id=p1')
    expect(link).toContain('tab=universities')
    expect(link).toContain('addLogin=mtsu.edu')
    expect(link).toContain('loginUrl=https')
  })
})

describe('missingCredentialNotice', () => {
  it('builds a flag with the add link, host, and a 2FA heads-up', () => {
    const n = missingCredentialNotice({ profileId: 'p1', host: 'mtsu.edu', loginUrl: 'https://mtsu.edu', fundingTitle: 'MTSU Aid' })
    expect(n.type).toBe(MISSING_CREDENTIAL_NOTIFICATION_TYPE)
    expect(n.title).toMatch(/mtsu\.edu/)
    expect(n.message).toMatch(/authenticator app or phone/i)
    expect(n.message).toMatch(/MTSU Aid/)
    expect(n.data.add_credential_link).toContain('addLogin=mtsu.edu')
    expect(n.data.portal_host).toBe('mtsu.edu')
    expect(n.data.requires_authentication_note).toBe(true)
  })
})
